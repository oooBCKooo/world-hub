"""Independent checks of this Python adapter; doesn't run repo-wide acceptance."""

from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone

import websockets
from websockets.sync.server import serve
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
from hub_bridge import Bridge, BridgeError, parse_frame


class Process:
    def __init__(self, command: list[str]):
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding="utf-8", bufsize=1)
        self.messages = queue.Queue(maxsize=256)
        self.stderr = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.error_reader = threading.Thread(target=self._errors, daemon=True)
        self.reader.start()
        self.error_reader.start()
        self.saved = []

    def _read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))

    def _errors(self):
        for line in self.process.stderr:
            self.stderr.append(line)

    def wait(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            self.saved.append(message)
            if predicate(message):
                return message
        raise AssertionError(f"Process wait failed: {self.saved[-3:]}; {self.stderr}")

    def command(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=True) + "\n")
        self.process.stdin.flush()

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def until(bridge: Bridge, predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = bridge.receive(timeout=deadline - time.monotonic())
        if predicate(frame.frame):
            return frame
    raise AssertionError("Bridge frame wait timed out")


def main():
    checks = []
    processes = []
    bridges = []
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="hub-phase7-python-") as scratch:
        scratch = Path(scratch)
        config = {
            "version": "0.1", "hub": {"id": "python-check"},
            "transport": {"host": "127.0.0.1", "port": 0, "path": "/bridge"},
            "log": {"enabled": False, "dir": str(scratch / "log")},
            "blobs": {"dir": str(scratch / "blobs")},
            "acl": {"defaultDeny": True, "allowUnlistedBridges": False,
                    "bridges": {name: {"allow": {"publish": ["#"], "subscribe": ["#"]}}
                                for name in ("py.sender", "py.receiver", "py.worker", "py.service")}},
        }
        config_path = scratch / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        try:
            hub = Process(["node", str(ROOT / "src/hub/hub-server.mjs"), "--config", str(config_path), "--quiet"])
            processes.append(hub)
            hub_ready = hub.wait(lambda frame: frame.get("event") == "ready")
            url = hub_ready["endpoint"]
            sender, receiver = Bridge(url, "py.sender", timeout=2), Bridge(url, "py.receiver", timeout=2)
            bridges.extend((sender, receiver))
            sender.connect()
            receiver.connect()
            receiver.send({"type": "subscribe", "token": "sub", "filters": ["py/check"], "from": "now"})
            sub = until(receiver, lambda frame: frame.get("type") == "subscribed").frame["subscription"]
            until(receiver, lambda frame: frame.get("type") == "caught_up" and frame.get("subscription") == sub)
            raw_body = '{ "unicode": "桥😀", "n":90071992547409931234567890, "x":1e+03, "escape":"\\u4e16" }'
            sender.send('{"type":"publish","topic":"py/check","requestToken":"raw","body":' + raw_body + '}')
            accepted = until(sender, lambda frame: frame.get("type") == "published" and frame.get("requestToken") == "raw")
            delivered = until(receiver, lambda frame: frame.get("type") == "delivery")
            assert raw_body in delivered.raw
            assert delivered.frame["body"]["n"] == 90071992547409931234567890
            assert delivered.frame["seq"] == accepted.frame["seq"]
            checks.append({"name": "real-hub-raw-unicode-bigint", "passed": True})
            try:
                receiver.receive(timeout=0.04)
                raise AssertionError("Empty receive unexpectedly returned")
            except TimeoutError:
                pass
            results = []
            def send_thread(i):
                sender.send({"type": "publish", "topic": "py/check", "requestToken": str(i), "body": {"i": i}})
                results.append(i)
            threads = [threading.Thread(target=send_thread, args=(i,)) for i in range(8)]
            for thread in threads:
                thread.start()
            seqs = {until(receiver, lambda frame: frame.get("type") == "delivery").frame["seq"] for _ in threads}
            for thread in threads:
                thread.join(timeout=3)
                assert not thread.is_alive()
            assert len(seqs) == 8 and len(results) == 8
            checks.append({"name": "receive-timeout-and-concurrent-sends", "passed": True})
            worker = Process([sys.executable, str(HERE / "worker.py"), "--url", url, "--bridge", "py.worker", "--timeout", "2"])
            processes.append(worker)
            worker.wait(lambda frame: frame.get("event") == "ready")
            assert worker.saved[0]["event"] == "frame" and worker.saved[0]["frame"]["type"] == "welcome"
            worker.command({"id": "raw", "action": "send", "raw": '{"type":"publish","topic":"py/check","body":{"unicode":"中文😀"},"requestToken":"worker-raw"}'})
            worker.wait(lambda frame: frame.get("id") == "raw" and frame.get("ok") is True)
            worker.wait(lambda frame: frame.get("event") == "frame" and frame["frame"].get("requestToken") == "worker-raw")
            worker.command({"id": "bad", "action": "send", "raw": {}})
            worker.wait(lambda frame: frame.get("id") == "bad" and frame.get("ok") is False)
            worker.command({"id": "surrogate-sub", "action": "send", "frame": {"type": "subscribe", "token": "surrogate-sub", "filters": ["py/surrogate"], "from": "now"}})
            surrogate_sub = worker.wait(lambda frame: frame.get("event") == "frame" and frame["frame"].get("type") == "subscribed" and frame["frame"].get("token") == "surrogate-sub")["frame"]["subscription"]
            worker.wait(lambda frame: frame.get("event") == "frame" and frame["frame"].get("type") == "caught_up" and frame["frame"].get("subscription") == surrogate_sub)
            surrogate_body = '{"text":"\\ud800","n":90071992547409931234567890}'
            sender.send('{"type":"publish","topic":"py/surrogate","body":' + surrogate_body + '}')
            surrogate_frame = worker.wait(lambda frame: frame.get("event") == "frame" and frame["frame"].get("type") == "delivery" and frame["frame"].get("topic") == "py/surrogate")
            assert surrogate_body in surrogate_frame["raw"]
            assert surrogate_frame["frame"]["body"]["text"] == '\ud800'
            worker.command({"id": "surrogate-send", "action": "send", "frame": {"type": "publish", "topic": "py/surrogate", "requestToken": "surrogate-dict", "body": {"text": '\ud800'}}})
            worker.wait(lambda frame: frame.get("id") == "surrogate-send" and frame.get("ok") is True)
            worker.wait(lambda frame: frame.get("event") == "frame" and frame["frame"].get("type") == "published" and frame["frame"].get("requestToken") == "surrogate-dict")
            assert worker.process.poll() is None
            checks.append({"name": "real-hub-escaped-lone-surrogate-receive-and-dict-send", "passed": True, "pid": worker.process.pid})
            worker.command({"id": "close", "action": "close"})
            worker.wait(lambda frame: frame.get("id") == "close" and frame.get("ok") is True)
            assert worker.process.wait(timeout=5) == 0
            checks.append({"name": "worker-ready-raw-validation-graceful-close", "passed": True, "pid": worker.process.pid})
            service = Process([sys.executable, str(HERE / "worker.py"), "--url", url, "--bridge", "py.service", "--timeout", "2", "--echo-topic", "py/service"])
            processes.append(service)
            service.wait(lambda frame: frame.get("event") == "ready")
            sender.send({"type": "subscribe", "token": "response", "filters": ["py/service"], "from": "now", "operations": ["response"]})
            response_sub = until(sender, lambda frame: frame.get("type") == "subscribed" and frame.get("token") == "response").frame["subscription"]
            until(sender, lambda frame: frame.get("type") == "caught_up" and frame.get("subscription") == response_sub)
            sender.send({"type": "request", "target": {"principal": "py.service"}, "topic": "py/service", "body": {"fixture": "phase7", "runId": "python-self-check", "steps": ["start"], "payload": {"n": 9007199254740993}}})
            response = until(sender, lambda frame: frame.get("type") == "delivery" and frame.get("operation") == "response")
            assert response.frame["body"]["steps"] == ["start", "python"]
            assert response.frame["body"]["payload"]["n"] == 9007199254740993
            assert response.frame["fromPrincipal"] == "py.service"
            service.command({"id": "bye", "action": "send", "frame": {"type": "bye"}})
            service.wait(lambda frame: frame.get("event") == "closed" and frame.get("normal") is True)
            assert service.process.wait(timeout=5) == 0
            checks.append({"name": "worker-directed-fixture-and-normal-peer-close", "passed": True, "pid": service.process.pid})
            denied = Process([sys.executable, str(HERE / "worker.py"), "--url", url, "--bridge", "py.unlisted", "--timeout", "2"])
            processes.append(denied)
            error = denied.wait(lambda frame: frame.get("event") == "error")
            assert error["error"]["code"] == "BRIDGE_NOT_REGISTERED"
            denied_frames = [message for message in denied.saved if message.get("event") == "frame"]
            assert len(denied_frames) == 1
            assert denied_frames[0]["frame"]["type"] == "denied"
            assert json.loads(denied_frames[0]["raw"]) == error["error"]["frame"]
            assert denied.process.wait(timeout=5) == 1
            assert not any(frame.get("event") == "ready" for frame in denied.saved)
            checks.append({"name": "handshake-denied-is-nonzero", "passed": True, "pid": denied.process.pid})
            denied_raw = '{ "type": "denied", "code": "CONTROL_DENIED", "message": "拒绝😀", "body": {"n":90071992547409931234567890,"x":1e+03} }'
            def exact_denial(ws):
                ws.recv(timeout=2)
                ws.send(denied_raw)
            with serve(exact_denial, "127.0.0.1", 0, close_timeout=0.5) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                exact = Process([sys.executable, str(HERE / "worker.py"), "--url", f"ws://127.0.0.1:{server.socket.getsockname()[1]}", "--bridge", "py.denial", "--timeout", "2"])
                processes.append(exact)
                exact.wait(lambda frame: frame.get("event") == "error")
                assert exact.saved[0]["event"] == "frame" and exact.saved[0]["raw"] == denied_raw
                assert exact.saved[0]["frame"]["body"]["n"] == 90071992547409931234567890
                assert exact.process.wait(timeout=5) == 1
                assert not any(frame.get("event") == "ready" for frame in exact.saved)
                server.shutdown()
                thread.join(timeout=2)
            checks.append({"name": "handshake-denied-raw-exact-before-error", "passed": True, "pid": exact.process.pid})
            stop = threading.Event()
            def stalled_peer(ws):
                ws.recv(timeout=2)
                stop.wait(timeout=2)
            with serve(stalled_peer, "127.0.0.1", 0, close_timeout=0.5) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                stalled = Bridge(f"ws://127.0.0.1:{server.socket.getsockname()[1]}", "py.stall", timeout=0.1)
                before = time.monotonic()
                try:
                    stalled.connect()
                    raise AssertionError("Stalled hello unexpectedly succeeded")
                except BridgeError as exc:
                    assert exc.code == "HANDSHAKE_TIMEOUT"
                elapsed = time.monotonic() - before
                assert elapsed < 2
                stop.set()
                server.shutdown()
                thread.join(timeout=2)
            checks.append({"name": "finite-welcome-timeout", "passed": True, "elapsedMs": round(elapsed * 1000)})
            pathological = parse_frame('{"body":{"large":1e400,"digits":' + '9' * 4500 + '}}')
            assert pathological.frame["body"]["large"] == "1e400"
            assert pathological.frame["body"]["digits"] == '9' * 4500
            checks.append({"name": "diagnostic-extreme-json-number-does-not-lose-raw", "passed": True})
        finally:
            for bridge in bridges:
                bridge.close()
            for process in reversed(processes):
                process.stop()
    report = {"language": "python", "pythonVersion": sys.version.split()[0], "websocketsVersion": websockets.__version__,
              "platform": sys.platform, "controllerPid": os.getpid(), "hubPid": hub_ready["pid"],
              "count": len(checks), "passed": sum(check["passed"] for check in checks),
              "elapsedMs": round((time.monotonic() - started) * 1000), "checks": checks,
              "scope": "Python adapter controls, real Hub except explicit raw-denial and stalled-welcome transports; not repo-wide acceptance"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    evidence = ROOT / ".artifacts" / "evidence" / "python-self-check" / (stamp + "-" + uuid.uuid4().hex[:8])
    evidence.mkdir(parents=True, exist_ok=False)
    report["report"] = str(evidence / "report.json")
    with (evidence / "report.json").open("x", encoding="utf-8") as output:
        output.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
