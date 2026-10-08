#!/usr/bin/env python3
"""NDJSON-controlled independent Python program for cross-language acceptance."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
import uuid

import websockets
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
from hub_bridge import Bridge, BridgeClosed, BridgeError, Frame, MAX_FRAME_BYTES


MAX_COMMAND_BYTES = MAX_FRAME_BYTES * 6 + 65536


def emit(value: dict) -> None:
    # Escaped surrogate code units are legal JSON input. Encoding a parsed lone
    # surrogate literally as UTF-8 would fail; escaping the NDJSON envelope keeps
    # both the diagnostic value and the raw string intact after JSON decoding.
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class InputLines:
    """Finite pipe/file reads; no background thread stuck on stdin.readline."""
    def __init__(self):
        self.fd = sys.stdin.fileno()
        self.buffer = bytearray()
        self.eof = False
        if sys.stdin.isatty():
            raise BridgeError("STDIN_PIPE_REQUIRED", "Worker stdin must be a pipe or redirected file")
        if os.name == "nt":
            import ctypes
            import msvcrt
            from ctypes import wintypes
            self.ctypes, self.wintypes = ctypes, wintypes
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.GetFileType.argtypes = [wintypes.HANDLE]
            self.kernel.GetFileType.restype = wintypes.DWORD
            self.kernel.PeekNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                                 wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
            self.kernel.PeekNamedPipe.restype = wintypes.BOOL
            self.handle = msvcrt.get_osfhandle(self.fd)
            self.pipe = self.kernel.GetFileType(self.handle) == 3

    def poll(self) -> list[dict]:
        if not self.eof:
            available = 65536
            if os.name == "nt" and self.pipe:
                count = self.wintypes.DWORD()
                ok = self.kernel.PeekNamedPipe(self.handle, None, 0, None, self.ctypes.byref(count), None)
                if not ok:
                    code = self.ctypes.get_last_error()
                    if code in (109, 232):
                        self.eof = True
                    else:
                        raise BridgeError("STDIN_FAILED", f"PeekNamedPipe failed: {code}")
                    available = 0
                else:
                    available = min(count.value, 65536)
            elif os.name != "nt":
                import select
                available = 65536 if select.select([self.fd], [], [], 0)[0] else 0
            if available:
                chunk = os.read(self.fd, available)
                if chunk:
                    self.buffer.extend(chunk)
                else:
                    self.eof = True
        lines: list[dict] = []
        while len(lines) < 32:
            newline = self.buffer.find(b"\n")
            if newline < 0:
                if self.eof and self.buffer:
                    newline = len(self.buffer)
                else:
                    break
            if newline > MAX_COMMAND_BYTES:
                raise BridgeError("COMMAND_TOO_LARGE", "NDJSON command exceeds the byte limit")
            line = bytes(self.buffer[:newline])
            del self.buffer[:newline + 1]
            if not line.strip():
                continue
            try:
                command = json.loads(line.decode("utf-8"), parse_constant=lambda text: (_ for _ in ()).throw(ValueError(text)))
                if not isinstance(command, dict):
                    raise ValueError("command must be an object")
            except (UnicodeError, ValueError) as exc:
                raise BridgeError("COMMAND_INVALID", f"Invalid UTF-8 NDJSON command: {exc}") from exc
            lines.append(command)
        if len(self.buffer) > MAX_COMMAND_BYTES:
            raise BridgeError("COMMAND_TOO_LARGE", "NDJSON command exceeds the byte limit")
        return lines


def report_frame(received: Frame, bridge: Bridge, echo_topic: str | None) -> None:
    emit({"event": "frame", "frame": received.frame, "raw": received.raw})
    frame = received.frame
    body = frame.get("body")
    if (echo_topic and frame.get("type") == "delivery" and frame.get("topic") == echo_topic
            and frame.get("operation") == "request" and isinstance(body, dict)
            and body.get("fixture") == "phase7" and isinstance(body.get("steps"), list)):
        # This is this program's test business; it isn't a Bridge or Hub rule.
        bridge.send({"type": "respond", "requestSeq": frame["seq"], "requestToken": str(uuid.uuid4()),
                     "body": {"fixture": "phase7", "runId": body.get("runId"),
                              "steps": [*body["steps"], "python"], "payload": body.get("payload")}})
        emit({"event": "fixture-response", "requestSeq": frame["seq"]})


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--bridge", required=True)
    parser.add_argument("--credential")
    parser.add_argument("--token")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--echo-topic")
    args = parser.parse_args()
    bridge: Bridge | None = None
    try:
        inputs = InputLines()
        bridge = Bridge(args.url, args.bridge, credential=args.credential, token=args.token, timeout=args.timeout)
        welcome = bridge.connect()
        report_frame(welcome, bridge, None)
        if args.echo_topic:
            token = str(uuid.uuid4())
            bridge.send({"type": "subscribe", "token": token, "filters": [args.echo_topic],
                         "from": "now", "operations": ["request"]})
            subscription = None
            deadline = time.monotonic() + args.timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BridgeError("SERVICE_TIMEOUT", "Timed out establishing fixture subscription")
                received = bridge.receive(timeout=remaining)
                report_frame(received, bridge, args.echo_topic)
                frame = received.frame
                if frame.get("type") in ("denied", "error"):
                    raise BridgeError(str(frame.get("code", "SERVICE_DENIED")), "Fixture subscription failed", frame)
                if frame.get("type") == "subscribed" and frame.get("token") == token:
                    subscription = frame["subscription"]
                if frame.get("type") == "caught_up" and subscription is not None and frame.get("subscription") == subscription:
                    break
        emit({"event": "ready", "language": "python", "pid": os.getpid(),
              "version": sys.version.split()[0], "dependencyVersion": websockets.__version__, "welcome": welcome.frame})
        while True:
            for command in inputs.poll():
                command_id = command.get("id")
                action = command.get("action")
                if action == "close":
                    bridge.close()
                    emit({"id": command_id, "ok": True})
                    return 0
                if action != "send" or ("raw" in command) == ("frame" in command):
                    emit({"id": command_id, "ok": False, "error": {"code": "COMMAND_INVALID", "message": "Expected send with exactly one frame/raw, or close"}})
                    continue
                if ("raw" in command and not isinstance(command["raw"], str)) or ("frame" in command and not isinstance(command["frame"], dict)):
                    emit({"id": command_id, "ok": False, "error": {"code": "COMMAND_INVALID", "message": "raw must be text; frame must be an object"}})
                    continue
                try:
                    bridge.send(command["raw"] if "raw" in command else command["frame"])
                    emit({"id": command_id, "ok": True})
                except BridgeError as exc:
                    emit({"id": command_id, "ok": False, "error": {"code": exc.code, "message": str(exc)}})
                    if exc.code in ("TRANSPORT_FAILED", "SEND_FAILED", "SEND_TIMEOUT"):
                        raise
            if inputs.eof and not inputs.buffer:
                return 0
            try:
                report_frame(bridge.receive(timeout=0.02), bridge, args.echo_topic)
            except TimeoutError:
                pass
            except BridgeClosed as exc:
                if exc.normal:
                    emit({"event": "closed", "normal": True})
                    return 0
                raise
    except (BridgeError, TimeoutError, ValueError, OSError) as exc:
        if getattr(exc, "raw", None) is not None and getattr(exc, "frame", None) is not None:
            # connect consumes its first frame before worker can report it.
            # Service errors are already emitted by the receive loop and don't
            # carry raw here, so this doesn't repeat an emitted Hub frame.
            emit({"event": "frame", "frame": exc.frame, "raw": exc.raw})
        failure = {"code": getattr(exc, "code", "WORKER_FAILED"), "message": str(exc)}
        if getattr(exc, "frame", None) is not None:
            failure["frame"] = exc.frame
        emit({"event": "error", "error": failure})
        sys.stderr.write(f"{failure['code']}: {failure['message']}\n")
        return 1
    finally:
        if bridge is not None:
            bridge.close()


if __name__ == "__main__":
    raise SystemExit(main())
