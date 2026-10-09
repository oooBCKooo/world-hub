"""Independent Python WebSocket mod bridge for World Hub wire 0.1.

The bridge only carries frames. ACK, release, retries and business processing
belong to its caller. Received raw text is never rebuilt from parsed JSON.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import socket
import threading
from typing import Any

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import ClientConnection, connect as websocket_connect


MAX_FRAME_BYTES = 4 * 1024 * 1024


class BridgeError(Exception):
    def __init__(self, code: str, message: str, frame: dict | None = None, raw: str | None = None):
        super().__init__(message)
        self.code = code
        self.frame = frame
        self.raw = raw


class BridgeClosed(BridgeError):
    def __init__(self, message: str, *, normal: bool):
        super().__init__("CONNECTION_CLOSED" if normal else "TRANSPORT_FAILED", message)
        self.normal = normal


@dataclass(frozen=True)
class Frame:
    raw: str
    frame: dict[str, Any]


def _diagnostic_float(text: str) -> float | str:
    value = float(text)
    return value if math.isfinite(value) else text


def _diagnostic_int(text: str) -> int | str:
    # Keep huge legal JSON numbers in raw; avoid Python's integer digit limit.
    return int(text) if len(text.lstrip("-")) <= 4000 else text


def _reject_constant(text: str) -> None:
    raise ValueError(f"non-JSON number: {text}")


def parse_frame(raw: str) -> Frame:
    try:
        value = json.loads(raw, parse_float=_diagnostic_float,
                           parse_int=_diagnostic_int, parse_constant=_reject_constant)
    except (ValueError, TypeError) as exc:
        raise BridgeError("FRAME_NOT_JSON", "Hub sent invalid JSON text") from exc
    if not isinstance(value, dict):
        raise BridgeError("FRAME_INVALID", "Hub frame must be a JSON object")
    return Frame(raw=raw, frame=value)


class Bridge:
    """One connection; concurrent send and receive are supported.

    send calls serialize under a finite lock; only one receive may run at a time.
    connect returns the welcome frame, which isn't repeated by receive.
    """

    def __init__(self, url: str, bridge: str, *, credential: str | None = None,
                 token: str | None = None, timeout: float = 10.0,
                 max_frame_bytes: int = MAX_FRAME_BYTES):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        if max_frame_bytes <= 0:
            raise ValueError("max_frame_bytes must be positive")
        self.url, self.bridge = url, bridge
        self.credential, self.token = credential, token
        self.timeout, self.max_frame_bytes = timeout, max_frame_bytes
        self._ws: ClientConnection | None = None
        self._send_lock = threading.Lock()
        self._receive_lock = threading.Lock()

    def connect(self) -> Frame:
        if self._ws is not None:
            raise BridgeError("ALREADY_CONNECTED", "Bridge is already connected")
        try:
            self._ws = websocket_connect(
                self.url, proxy=None, compression=None,
                open_timeout=self.timeout, close_timeout=min(self.timeout, 3.0),
                max_size=self.max_frame_bytes, max_queue=8,
                ping_interval=20, ping_timeout=self.timeout,
            )
            hello: dict[str, Any] = {"type": "hello", "wire": "0.1", "bridge": self.bridge}
            if self.credential is not None:
                hello["credential"] = self.credential
            if self.token is not None:
                hello["token"] = self.token
            self.send(hello)
            welcome = self.receive(timeout=self.timeout)
            if welcome.frame.get("type") == "denied":
                raise BridgeError(str(welcome.frame.get("code", "HANDSHAKE_DENIED")),
                                  "Hub denied the handshake", welcome.frame, welcome.raw)
            if welcome.frame.get("type") != "welcome":
                raise BridgeError("HANDSHAKE_INVALID", "Expected welcome from Hub", welcome.frame, welcome.raw)
            return welcome
        except BridgeError:
            self.close()
            raise
        except TimeoutError as exc:
            self.close()
            raise BridgeError("HANDSHAKE_TIMEOUT", "Timed out connecting or waiting for welcome") from exc
        except Exception as exc:
            self.close()
            raise BridgeError("CONNECT_FAILED", f"WebSocket connection failed: {exc}") from exc

    @staticmethod
    def _abort_socket(ws: ClientConnection) -> None:
        # Interrupt a blocked sendall without waiting for the protocol send lock.
        # close() below still performs the library's thread cleanup.
        try:
            ws.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def send(self, frame: dict[str, Any] | str) -> None:
        ws = self._ws
        if ws is None:
            raise BridgeError("NOT_CONNECTED", "Bridge is not connected")
        if isinstance(frame, str):
            raw = frame
        elif isinstance(frame, dict):
            try:
                raw = json.dumps(frame, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
            except (TypeError, ValueError) as exc:
                raise BridgeError("FRAME_INVALID", "Frame cannot be encoded as JSON") from exc
        else:
            raise BridgeError("FRAME_INVALID", "send accepts a JSON object or raw text")
        try:
            encoded_size = len(raw.encode("utf-8"))
        except UnicodeError as exc:
            raise BridgeError("FRAME_INVALID", "Raw frame text must encode as UTF-8; escape surrogate code units in JSON") from exc
        if encoded_size > self.max_frame_bytes:
            raise BridgeError("FRAME_TOO_LARGE", "Outgoing frame exceeds the configured byte limit")
        if not self._send_lock.acquire(timeout=self.timeout):
            raise BridgeError("SEND_TIMEOUT", "Timed out waiting for another sender")
        deadline = threading.Timer(self.timeout, self._abort_socket, args=(ws,))
        try:
            deadline.start()
            ws.send(raw)
        except ConnectionClosed as exc:
            raise BridgeClosed(str(exc), normal=False) from exc
        except Exception as exc:
            raise BridgeError("SEND_FAILED", f"Frame send failed: {exc}") from exc
        finally:
            deadline.cancel()
            deadline.join()
            self._send_lock.release()

    def receive(self, timeout: float | None = None) -> Frame:
        ws = self._ws
        if ws is None:
            raise BridgeError("NOT_CONNECTED", "Bridge is not connected")
        wait = self.timeout if timeout is None else timeout
        if not math.isfinite(wait) or wait < 0:
            raise ValueError("receive timeout must be finite and nonnegative")
        if not self._receive_lock.acquire(blocking=False):
            raise BridgeError("RECEIVER_BUSY", "Only one receive may run at a time")
        try:
            raw = ws.recv(timeout=wait)
            if not isinstance(raw, str):
                raise BridgeError("BINARY_FRAME", "Current Hub binding requires UTF-8 JSON text")
            return parse_frame(raw)
        except ConnectionClosed as exc:
            # A peer's normal close is a stream end, not a transport failure.
            from websockets.exceptions import ConnectionClosedOK
            raise BridgeClosed(str(exc), normal=isinstance(exc, ConnectionClosedOK)) from exc
        finally:
            self._receive_lock.release()

    def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is None:
            return
        if not self._send_lock.acquire(timeout=self.timeout):
            self._abort_socket(ws)
            if not self._send_lock.acquire(timeout=self.timeout):
                raise BridgeError("CLOSE_TIMEOUT", "Sender did not stop after socket shutdown")
        try:
            ws.close()
        finally:
            self._send_lock.release()
