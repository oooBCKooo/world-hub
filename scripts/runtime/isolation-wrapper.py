"""Same-process Python adapter for the optional network=none Linux profile.

The only host destinations are selected by the host broker. This module never
starts a process, installs a dependency, or follows an application redirect.
"""
import base64
import http.client
import importlib.metadata
import io
import json
import os
import queue
import runpy
import sys
import threading
import uuid
from urllib.parse import urlsplit

from websockets.sync.server import serve

ENTRY, CONFIG_PATH, OPTIONS_TEXT = sys.argv[1:]
OPTIONS = json.loads(OPTIONS_TEXT)
VERSION = ".".join(map(str, sys.version_info[:3]))
PACKAGES = {name: importlib.metadata.version(name) for name in OPTIONS["expectedRuntime"]["packages"]}
if os.getuid() < 1 or VERSION != OPTIONS["expectedRuntime"]["version"] or PACKAGES != OPTIONS["expectedRuntime"]["packages"]:
    raise RuntimeError("ISOLATION_ENVIRONMENT_MISMATCH")
with open(CONFIG_PATH, encoding="utf-8") as source:
    CONFIG = json.load(source)
EVENT = "world-hub-isolation/v1"
HTTP_EVENT = "world-hub-isolation-http/v1"
MAX_FRAME = 4 * 1024 * 1024
MAX_BODY = 1024 * 1024
connections, incoming, http_incoming = {}, {}, {}
connection_lock = threading.RLock()
output_lock = threading.RLock()
original_stdin, original_stdout = sys.stdin, sys.stdout
commands = queue.Queue(maxsize=128)
http_target = None
http_active = set()
request_headers = {"accept", "accept-language", "authorization", "content-type", "cookie", "if-none-match", "range"}
response_headers = {"content-type", "cache-control", "etag", "last-modified", "content-range", "accept-ranges", "content-security-policy", "referrer-policy", "permissions-policy"}


class Lines(io.TextIOBase):
    def __init__(self):
        self.buffers = {}

    def writable(self):
        return True

    def write(self, text):
        with output_lock:
            key = threading.get_ident()
            pending = self.buffers.get(key, "") + text
            if len(pending.encode("utf-8")) > 131072 and "\n" not in pending:
                raise ValueError("Bounded adapter stdout exceeded")
            while "\n" in pending:
                line, pending = pending.split("\n", 1)
                original_stdout.write(line + "\n")
                original_stdout.flush()
            self.buffers[key] = pending
        return len(text)

    def flush(self):
        original_stdout.flush()


class Commands(io.TextIOBase):
    def readable(self):
        return True

    def readline(self, size=-1):
        value = commands.get()
        if value is None:
            commands.put(None)
            return ""
        if size >= 0 and len(value) > size:
            raise ValueError("Lifecycle line exceeds reader bound")
        return value


def emit(frame):
    with output_lock:
        original_stdout.write(json.dumps(frame, ensure_ascii=True, separators=(",", ":")) + "\n")
        original_stdout.flush()


def chunks(identifier, text, event=EVENT):
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_FRAME:
        raise ValueError("Isolation frame exceeds bound")
    # Python counts code points; the host counts UTF-16 units. 4096 code points
    # remain within its 8192-unit chunk bound even for supplementary Unicode.
    for index, offset in enumerate(range(0, max(len(text), 1), 4096)):
        yield {"event": event, "operation": "chunk", "connection": identifier,
               "index": index, "final": offset + 4096 >= len(text), "text": text[offset:offset + 4096]}


def collect(records, frame):
    identifier = frame["connection"]
    if frame.get("operation") != "chunk" or type(frame.get("index")) is not int or frame["index"] < 0 or type(frame.get("final")) is not bool or not isinstance(frame.get("text"), str) or len(frame["text"]) > 8192:
        raise ValueError("Invalid isolation chunk")
    record = records.setdefault(identifier, {"next": 0, "parts": [], "bytes": 0})
    if record["next"] != frame["index"]:
        raise ValueError("Isolation chunk order changed")
    record["next"] += 1
    record["parts"].append(frame["text"])
    record["bytes"] += len(frame["text"].encode("utf-8", "surrogatepass"))
    if record["bytes"] > MAX_FRAME:
        raise ValueError("Isolation frame exceeds bound")
    if frame["final"]:
        records.pop(identifier)
        # The JS host can split a surrogate pair between consecutive chunks.
        return "".join(record["parts"]).encode("utf-16", "surrogatepass").decode("utf-16")
    return None


def connection_handler(connection):
    with connection_lock:
        if len(connections) >= len(CONFIG["bridges"]):
            connection.close(1008, "Connection limit")
            return
        identifier = str(uuid.uuid4())
        connections[identifier] = connection
    emit({"event": EVENT, "operation": "open", "connection": identifier})
    try:
        for text in connection:
            if not isinstance(text, str):
                raise ValueError("Text bridge frame required")
            for frame in chunks(identifier, text):
                emit(frame)
    finally:
        with connection_lock:
            connections.pop(identifier, None)
            incoming.pop(identifier, None)
        emit({"event": EVENT, "operation": "close", "connection": identifier})


def target(value):
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Container loopback HTTP entry required")
    return parsed


def headers(value, response=False):
    if not isinstance(value, dict) or len(value) > 32:
        raise ValueError("Invalid HTTP headers")
    allowed, result, total = response_headers if response else request_headers, {}, 0
    for key, item in value.items():
        if key.lower() not in allowed:
            continue
        if not isinstance(item, str) or any(c in item for c in "\r\n\0"):
            raise ValueError("Invalid HTTP header value")
        total += len(key) + len(item)
        if total > 16384:
            raise ValueError("HTTP header bound exceeded")
        result[key.lower()] = item
    return result


def http_request(identifier, value):
    try:
        parsed = target(http_target)
        if value.get("operation") != "request" or value.get("method") not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
            raise ValueError("Invalid HTTP method")
        path = value.get("path")
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or len(path) > 4096 or any(c in path for c in "\r\n\0"):
            raise ValueError("Invalid HTTP path")
        encoded = value.get("body")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_BODY + 2) // 3) * 4:
            raise ValueError("Invalid HTTP body")
        body = base64.b64decode(encoded, validate=True)
        if len(body) > MAX_BODY or base64.b64encode(body).decode("ascii") != encoded:
            raise ValueError("HTTP body bound exceeded")
        connection = http.client.HTTPConnection("127.0.0.1", parsed.port, timeout=10)
        try:
            connection.request(value["method"], path, body=body, headers=headers(value["headers"]))
            response = connection.getresponse()
            data = response.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                raise ValueError("HTTP response exceeds bound")
            result = {"operation": "response", "status": response.status, "headers": headers(dict(response.getheaders()), True), "body": base64.b64encode(data).decode("ascii")}
        finally:
            connection.close()
    except Exception:
        result = {"operation": "response", "status": 502, "headers": {}, "body": ""}
    try:
        for frame in chunks(identifier, json.dumps(result, separators=(",", ":")), HTTP_EVENT):
            emit(frame)
    finally:
        with connection_lock:
            http_active.discard(identifier)


server = serve(connection_handler, "127.0.0.1", 0, max_size=MAX_FRAME, max_queue=16, close_timeout=1, compression=None)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.socket.getsockname()[1]
for bridge in CONFIG["bridges"]:
    bridge["endpoint"] = "ws://127.0.0.1:%d/bridge" % port
CONFIG["stateDir"] = "/state"
with open("/tmp/runtime-config.json", "x", encoding="utf-8") as destination:
    json.dump(CONFIG, destination)


def lifecycle():
    global http_target
    try:
        for line in original_stdin:
            if len(line.encode("utf-8")) > 131072:
                raise ValueError("Host adapter line exceeds bound")
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            if frame.get("event") == EVENT:
                identifier = frame.get("connection")
                with connection_lock:
                    connection = connections.get(identifier)
                if connection is None:
                    continue
                try:
                    if frame.get("operation") == "close":
                        connection.close(1001, "Host channel closed")
                        continue
                    text = collect(incoming, frame)
                    if text is not None:
                        connection.send(text)
                except Exception:
                    incoming.pop(identifier, None)
                    connection.close(1008, "Invalid host frame")
                continue
            if frame.get("event") == HTTP_EVENT and OPTIONS["httpAllowed"]:
                if frame.get("operation") == "setup":
                    if http_target is None:
                        target(frame["target"])
                        http_target = frame["target"]
                    continue
                identifier = frame.get("connection")
                try:
                    if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier or http_target is None or len(http_incoming) >= 16 and identifier not in http_incoming:
                        continue
                    text = collect(http_incoming, frame)
                    if text is not None:
                        with connection_lock:
                            if len(http_active) >= 16 or identifier in http_active:
                                continue
                            http_active.add(identifier)
                        threading.Thread(target=http_request, args=(identifier, json.loads(text)), daemon=True).start()
                except Exception:
                    http_incoming.pop(identifier, None)
                continue
            if frame.get("command") in {"health", "stop"}:
                commands.put_nowait(line)
                if frame["command"] == "stop":
                    threading.Timer(.1, server.shutdown).start()
    finally:
        commands.put_nowait(None)
        server.shutdown()


sys.stdin, sys.stdout = Commands(), Lines()
threading.Thread(target=lifecycle, daemon=True).start()
sys.argv = [ENTRY, "--runtime-config", "/tmp/runtime-config.json"]
sys.path.insert(0, os.path.dirname(ENTRY))
emit({"event": "isolation-ready", "runtime": "python", "runtimeVersion": VERSION, "packages": PACKAGES,
      "user": os.getuid(), "profile": OPTIONS["profile"]})
try:
    runpy.run_path(ENTRY, run_name="__main__")
finally:
    server.shutdown()
