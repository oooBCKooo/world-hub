"""Independent Python provider; Runtime lifecycle is separate from Hub traffic."""
import argparse
from logic import statistics
import json
from pathlib import Path
import signal
import sys
import threading
import uuid

from hub_bridge import Bridge, BridgeError

CONTRACT = {"id": "text.statistics", "version": "1.0.0"}
stopping = threading.Event()
ready = threading.Event()
bridge = None
print_lock = threading.Lock()


def emit(frame):
    with print_lock:
        print(json.dumps(frame, ensure_ascii=True, separators=(",", ":")), flush=True)


def stop(*unused):
    stopping.set()
    ready.clear()
    if bridge is not None:
        bridge.close()


def lifecycle():
    try:
        while not stopping.is_set():
            line = sys.stdin.readline(65538)
            if not line:
                stop()
                return
            if len(line) > 65536:
                stop()
                return
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            if message.get("command") == "stop":
                stop()
                return
            if message.get("command") == "health" and isinstance(message.get("id"), str) and len(message["id"]) <= 256:
                emit({"event": "module-health", "id": message["id"], "ready": ready.is_set() and not stopping.is_set()})
    finally:
        stop()


def result_for(message, config, caller):
    body = message.get("body")
    invocation = body.get("invocationId", "") if isinstance(body, dict) else ""
    if not isinstance(invocation, str) or len(invocation) > 256:
        invocation = ""

    def failure(code, description):
        return {"ok": False, "kind": "demo.capability-result", "contract": CONTRACT,
                "invocationId": invocation, "status": "failed", "provider": config["module"]["id"],
                "error": {"code": code, "message": description, "retryable": False}}

    if message.get("fromPrincipal") != caller:
        return failure("PERMISSION_DENIED", "Caller is not authorized by this provider.")
    if not isinstance(body, dict) or body.get("contract") != CONTRACT:
        return failure("CONTRACT_MISMATCH", "Expected the supported exact contract.")
    if set(body) != {"contract", "invocationId", "text"} or not invocation or not isinstance(body.get("text"), str):
        return failure("INPUT_INVALID", "Expected text and a bounded invocation identifier.")
    text = body["text"]
    try:
        raw = text.encode("utf-8", "strict")
    except UnicodeEncodeError:
        return failure("INPUT_INVALID", "Text must be well-formed Unicode.")
    if len(raw) > 16384:
        return failure("INPUT_INVALID", "Text exceeds 16384 UTF-8 bytes.")
    return {"ok": True, "kind": "demo.capability-result", "contract": CONTRACT,
            "invocationId": invocation, "status": "completed", "provider": config["module"]["id"],
            "executionId": str(uuid.uuid4()), "output": statistics(text)}


def main():
    global bridge
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-config", required=True)
    arguments = parser.parse_args()
    config = json.loads(Path(arguments.runtime_config).read_text(encoding="utf-8"))
    connection = next(item for item in config["bridges"] if item["slot"] == "main")
    topic = config["topics"][config.get("settings", {}).get("topicKey", "stats")]
    caller = config["peers"][config.get("settings", {}).get("callerId", "desk")]["principal"]
    if config["format"] != "world-hub.run/v1" or topic not in connection["publish"] or topic not in connection["subscribe"]:
        raise ValueError("CONFIG_INVALID")
    bridge = Bridge(connection["endpoint"], connection["bridgeId"], credential=connection["credential"],
                    token=connection["token"], timeout=3)
    threading.Thread(target=lifecycle, daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    welcome = bridge.connect().frame
    if stopping.is_set():
        stop()
        return
    if welcome.get("principal") != connection["principal"] or welcome.get("authenticated") is not True:
        raise ValueError("WELCOME_UNTRUSTED")
    # Receive real registration and subscription receipts before announcing ready.
    bridge.send({"type": "register", "requestToken": "register", "channels": [{"name": topic, "publish": True, "subscribe": True}]})
    receipt = bridge.receive().frame
    if receipt.get("type") != "registered" or receipt.get("requestToken") != "register":
        raise ValueError("REGISTER_NOT_CONFIRMED")
    bridge.send({"type": "subscribe", "token": "subscribe", "filters": [topic], "operations": ["request"], "from": "now"})
    receipt = bridge.receive().frame
    if receipt.get("type") != "subscribed" or receipt.get("token") != "subscribe":
        raise ValueError("SUBSCRIBE_NOT_CONFIRMED")
    subscription = receipt["subscription"]
    if stopping.is_set():
        stop()
        return
    ready.set()
    emit({"event": "module-ready"})
    pending = {}
    while not stopping.is_set():
        try:
            message = bridge.receive(timeout=0.25).frame
        except TimeoutError:
            continue
        except BridgeError:
            if stopping.is_set():
                return
            raise
        if message.get("type") == "delivery" and message.get("operation") == "request" and message.get("topic") == topic:
            token = "response-" + str(message["seq"])
            pending[token] = message["seq"]
            bridge.send({"type": "respond", "requestToken": token, "requestSeq": message["seq"], "body": result_for(message, config, caller)})
        elif message.get("type") == "published" and message.get("requestToken") in pending:
            sequence = pending.pop(message["requestToken"])
            bridge.send({"type": "ack", "subscription": subscription, "seq": sequence})
        elif message.get("type") in {"error", "denied"}:
            raise ValueError("HUB_OPERATION_FAILED")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        if not stopping.is_set():
            emit({"event": "module-diagnostic", "code": "PYTHON_MODULE_FAILED"})
            stop()
            sys.exit(1)
    finally:
        stop()
