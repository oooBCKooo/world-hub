"""Independent AI implementation of the public text.statistics@1.0.0 contract.

Business processing is independent of the Hub's transport identity and ACL.
Only the public Python SDK carries frames; this module owns the application.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import json
import math
from pathlib import Path
import queue
import re
import sys
import threading
import time
import uuid
from typing import Any


CONTRACT = {"id": "text.statistics", "version": "1.0.0"}
RESULT_KIND = "demo.capability-result"
MAX_TEXT_BYTES = 16384
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
VERSION_PATTERN = re.compile(r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}\Z")


class ProviderError(Exception):
    """A bounded configuration, transport or directory failure."""


class JsonNumber:
    """A JSON numeric literal whose type must not become a diagnostic string."""

    def __init__(self, literal: str):
        self.literal = literal


def application_frame(raw: str) -> dict[str, Any]:
    # The SDK's parsed value is diagnostic: it represents huge integers and
    # non-finite floats as strings. Parse raw separately for business type checks.
    def parse_integer(literal: str) -> int | JsonNumber:
        return int(literal) if len(literal.lstrip("-")) <= 4000 else JsonNumber(literal)

    def reject_constant(_literal: str) -> None:
        raise ValueError("Non-JSON numeric constant")

    value = json.loads(raw, parse_int=parse_integer, parse_float=JsonNumber,
                       parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ProviderError("Hub sent a non-object frame")
    return value


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def emit(event: str, **values: Any) -> None:
    print(json_text({"event": event, "type": event, **values}), flush=True)


def echoed_invocation(body: Any) -> str:
    value = body.get("invocationId") if isinstance(body, dict) else None
    return value if isinstance(value, str) and 1 <= len(value) <= 256 else ""


def failure(module_id: str, body: Any, code: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "kind": RESULT_KIND,
        "contract": dict(CONTRACT),
        "invocationId": echoed_invocation(body),
        "status": "failed",
        "provider": module_id,
        "error": {"code": code, "message": message, "retryable": False},
    }


def process_request(module_id: str, allowed_callers: set[str], from_principal: Any,
                    body: Any) -> dict[str, Any]:
    """Authorize trusted delivery identity, then contract, then strict input."""
    if not isinstance(from_principal, str) or from_principal not in allowed_callers:
        return failure(module_id, body, "PERMISSION_DENIED",
                       "The provider has not authorized this caller.")
    requested = body.get("contract") if isinstance(body, dict) else None
    if (not isinstance(requested, dict) or requested.get("id") != CONTRACT["id"]
            or requested.get("version") != CONTRACT["version"]):
        return failure(module_id, body, "CONTRACT_MISMATCH",
                       "The provider supports only text.statistics@1.0.0.")
    if (set(body) != {"contract", "invocationId", "text"}
            or set(requested) != {"id", "version"}):
        return failure(module_id, body, "INPUT_INVALID", "Input fields do not match the contract.")
    invocation = body["invocationId"]
    text = body["text"]
    if not isinstance(invocation, str) or not 1 <= len(invocation) <= 256:
        return failure(module_id, body, "INPUT_INVALID", "invocationId must contain 1 to 256 code points.")
    if not isinstance(text, str) or len(text) > MAX_TEXT_BYTES:
        return failure(module_id, body, "INPUT_INVALID", "text must be a bounded string.")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in text):
        return failure(module_id, body, "INPUT_INVALID", "text contains an unpaired Unicode surrogate.")
    encoded = text.encode("utf-8", errors="strict")
    if len(encoded) > MAX_TEXT_BYTES:
        return failure(module_id, body, "INPUT_INVALID", "text exceeds the 16384-byte UTF-8 limit.")
    return {
        "ok": True,
        "kind": RESULT_KIND,
        "contract": dict(CONTRACT),
        "invocationId": invocation,
        "status": "completed",
        "provider": module_id,
        "executionId": str(uuid.uuid4()),
        "output": {
            "codePoints": len(text),
            "lines": text.count("\n") + 1,
            "utf8Bytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
        },
    }


def integer(value: Any, minimum: int, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def resolved_config_path(base: Path, value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ProviderError(f"{name} must name a path")
    path = Path(value)
    return (base / path).resolve() if not path.is_absolute() else path.resolve()


def load_config(config_file: Path) -> dict[str, Any]:
    config_file = config_file.resolve()
    try:
        config = json.loads(config_file.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ProviderError("Cannot read the JSON wiring configuration") from exc
    if not isinstance(config, dict):
        raise ProviderError("Configuration must be an object")
    for name in ("endpoint", "bridgeId", "principal", "token", "moduleId", "moduleVersion", "businessTopic"):
        if not isinstance(config.get(name), str) or not config[name]:
            raise ProviderError(f"{name} must be a nonempty string")
    if not config["endpoint"].startswith(("ws://", "wss://")):
        raise ProviderError("endpoint must be a WebSocket URL")
    for name in ("bridgeId", "moduleId", "principal"):
        if ID_PATTERN.fullmatch(config[name]) is None:
            raise ProviderError(f"{name} must match the public bounded identity format")
    if VERSION_PATTERN.fullmatch(config["moduleVersion"]) is None:
        raise ProviderError("moduleVersion must contain three bounded numeric components")
    directory = config.get("directory")
    if not isinstance(directory, dict):
        raise ProviderError("directory must supply principal and registerTopic")
    if (not isinstance(directory.get("principal"), str)
            or ID_PATTERN.fullmatch(directory["principal"]) is None):
        raise ProviderError("directory.principal is invalid")
    for topic in (config["businessTopic"], directory.get("registerTopic")):
        if (not isinstance(topic, str) or not 1 <= len(topic.encode("utf-16-le", errors="surrogatepass")) // 2 <= 200
                or any(character.isspace() or character in "#+" or 0xD800 <= ord(character) <= 0xDFFF for character in topic)
                or any(not segment for segment in topic.split("/"))):
            raise ProviderError("Topics must be nonempty bounded concrete topics")
    if config["businessTopic"] == directory["registerTopic"]:
        raise ProviderError("Business and directory registration topics must differ")
    callers = config.get("allowedCallers")
    if (not isinstance(callers, list)
            or any(not isinstance(caller, str) or ID_PATTERN.fullmatch(caller) is None for caller in callers)):
        raise ProviderError("allowedCallers must contain bounded principal strings")
    config["allowedCallers"] = set(callers)
    lease = config.get("leaseMs", 1800)
    cadence = config.get("renewEveryMs", 600)
    if not integer(lease, 300, 10000) or not integer(cadence, 1, lease - 1):
        raise ProviderError("leaseMs must be 300..10000 and renewEveryMs must be positive and below leaseMs")
    config["leaseMs"], config["renewEveryMs"] = lease, cadence
    root = Path(__file__).resolve().parents[2]
    config["sdkDirectory"] = resolved_config_path(config_file.parent, config.get("sdkDirectory", str(root / "sdk/python")), "sdkDirectory")
    config["contractPath"] = resolved_config_path(config_file.parent, config.get("contractPath", str(root / "docs/modules/text-statistics.contract.json")), "contractPath")
    return config


def load_contract(path: Path) -> dict[str, Any]:
    try:
        contract = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ProviderError("Cannot read the public machine contract") from exc
    if (not isinstance(contract, dict) or contract.get("contract") != CONTRACT
            or contract.get("semantics") != "utf8-exact-unicode-v1"
            or contract.get("effects") != "read-only" or contract.get("permissions") != ["text.read"]
            or not isinstance(contract.get("inputSchema"), dict)
            or not isinstance(contract.get("outputSchema"), dict)):
        raise ProviderError("contractPath must provide the supported public text.statistics@1.0.0 contract")
    return contract


def build_manifest(config: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    manifest = {
        "manifestVersion": 1,
        "module": {"id": config["moduleId"], "version": config["moduleVersion"]},
        "capabilities": [{
            "id": contract["contract"]["id"],
            "contract": copy.deepcopy(contract["contract"]),
            "inputSchema": copy.deepcopy(contract["inputSchema"]),
            "outputSchema": copy.deepcopy(contract["outputSchema"]),
            "semantics": contract["semantics"],
            "topic": config["businessTopic"],
            "effects": contract["effects"],
            "permissions": copy.deepcopy(contract["permissions"]),
        }],
        "leaseMs": config["leaseMs"],
    }
    # Compact UTF-8 serialization mirrors the directory's parsed-JSON bound.
    encoded = json.dumps(manifest, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 24000:
        raise ProviderError("Manifest exceeds the public directory byte limit")
    return manifest


def protocol_integer(value: Any, *, positive: bool = False) -> bool:
    return integer(value, 1 if positive else 0, 9007199254740991)


def uuid_string(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def validate_registration(body: Any, manifest: dict[str, Any], principal: str,
                          session: str) -> dict[str, Any]:
    if (not isinstance(body, dict) or body.get("ok") is not True
            or body.get("kind") != "demo.capability-registration"
            or not uuid_string(body.get("epoch"))):
        raise ProviderError("Directory did not return a valid registration result")
    entry = body.get("entry")
    if (not isinstance(entry, dict) or entry.get("module") != manifest["module"]
            or entry.get("capabilities") != manifest["capabilities"]
            or entry.get("principal") != principal or entry.get("session") != session
            or entry.get("state") != "lease-valid"
            or not protocol_integer(entry.get("registeredAt"))
            or not protocol_integer(entry.get("expiresAt"))
            or entry["expiresAt"] - entry["registeredAt"] != manifest["leaseMs"]):
        raise ProviderError("Directory registration entry is incomplete or differs from the advertisement")
    return body


class WireProvider:
    """Single finite-time receiver; receipt correlation is independent of order."""

    REQUEST_TIMEOUT = 1.5
    CONTROL_TIMEOUT = 3.0
    MAX_PENDING_RESPONSES = 256

    def __init__(self, bridge: Any, config: dict[str, Any], manifest: dict[str, Any],
                 stop: threading.Event):
        self.bridge, self.config, self.manifest, self.stop = bridge, config, manifest, stop
        self.welcome: dict[str, Any] = {}
        self.business_subscription: str | None = None
        self.directory_subscription: str | None = None
        self.pending: dict[str, dict[str, Any]] = {}
        self.registration: dict[str, Any] | None = None
        self.control: dict[str, Any] | None = None
        self.control_result: dict[str, Any] | None = None
        self.next_registration = 0.0
        self.ready = False

    @staticmethod
    def unique_token() -> str:
        return str(uuid.uuid4())

    def ack(self, frame: dict[str, Any]) -> None:
        if not protocol_integer(frame.get("seq"), positive=True):
            raise ProviderError("Delivery contains an invalid protocol sequence")
        self.bridge.send({"type": "ack", "subscription": frame["subscription"], "seq": [frame["seq"]]})

    def pump(self, deadline: float | None = None) -> None:
        if self.stop.is_set():
            return
        timeout = 0.05
        if deadline is not None:
            timeout = max(0.0, min(timeout, deadline - time.monotonic()))
        try:
            received = self.bridge.receive(timeout=timeout)
        except TimeoutError:
            return
        self.dispatch(application_frame(received.raw))

    def control_exchange(self, frame: dict[str, Any], expected: str,
                         correlation_field: str) -> dict[str, Any]:
        identifier = self.unique_token()
        frame[correlation_field] = identifier
        self.control = {"expected": expected, "field": correlation_field, "id": identifier}
        self.control_result = None
        self.bridge.send(frame)
        deadline = time.monotonic() + self.CONTROL_TIMEOUT
        try:
            while self.control_result is None and not self.stop.is_set():
                if time.monotonic() >= deadline:
                    raise ProviderError(f"Timed out waiting for {expected}")
                self.pump(deadline)
                self.check_deadlines()
            if self.stop.is_set():
                raise ProviderError("Stopped while establishing communication")
            assert self.control_result is not None
            return self.control_result
        finally:
            self.control = None
            self.control_result = None

    def subscribe(self, topic: str, operation: str) -> str:
        receipt = self.control_exchange({
            "type": "subscribe", "filters": [topic],
            "operations": [operation], "from": self.welcome["lastSeq"],
            "delivery": "bounded_ack",
        }, "subscribed", "token")
        subscription = receipt.get("subscription")
        if (not isinstance(subscription, str) or not subscription
                or receipt.get("filters") != [topic]
                or not protocol_integer(receipt.get("cursor"))):
            raise ProviderError("Hub returned an invalid subscription receipt")
        return subscription

    def start_registration(self) -> None:
        if self.registration is not None:
            return
        token = self.unique_token()
        pending = {
            "kind": "registration", "token": token,
            "deadline": time.monotonic() + self.REQUEST_TIMEOUT,
            "requestSeq": None, "candidates": [],
        }
        self.registration = pending
        self.pending[token] = pending
        self.bridge.send({
            "type": "request", "requestToken": token,
            "target": {"principal": self.config["directory"]["principal"]},
            "topic": self.config["directory"]["registerTopic"], "body": self.manifest,
        })

    def registration_failed(self, reason: str) -> None:
        if self.registration is not None:
            self.pending.pop(self.registration["token"], None)
            for frame in self.registration["candidates"]:
                self.ack(frame)
        self.registration = None
        self.next_registration = time.monotonic() + self.config["renewEveryMs"] / 1000.0
        emit("registration-error", reason=reason)

    def consider_registration_response(self, frame: dict[str, Any]) -> None:
        pending = self.registration
        if pending is None:
            self.ack(frame)
            return
        request_seq = frame.get("requestSeq")
        if not protocol_integer(request_seq, positive=True):
            self.ack(frame)
            return
        if pending["requestSeq"] is None:
            if len(pending["candidates"]) >= 32:
                self.ack(frame)
            else:
                pending["candidates"].append(frame)
            return
        if request_seq != pending["requestSeq"]:
            self.ack(frame)
            return
        self.ack(frame)
        try:
            result = validate_registration(frame.get("body"), self.manifest,
                                           self.welcome["principal"], self.welcome["session"])
        except ProviderError:
            self.registration_failed("directory-result-invalid-or-denied")
            return
        self.pending.pop(pending["token"], None)
        self.registration = None
        self.next_registration = time.monotonic() + self.config["renewEveryMs"] / 1000.0
        if not self.ready:
            self.ready = True
            emit("ready", principal=self.welcome["principal"], session=self.welcome["session"],
                 moduleId=self.config["moduleId"])
        emit("registered", epoch=result["epoch"], expiresAt=result["entry"]["expiresAt"])

    def delivery(self, frame: dict[str, Any]) -> None:
        subscription = frame.get("subscription")
        if subscription not in (self.business_subscription, self.directory_subscription):
            raise ProviderError("Delivery is not associated with an established subscription")
        if not protocol_integer(frame.get("seq"), positive=True):
            raise ProviderError("Delivery sequence is not a positive safe integer")
        if subscription == self.business_subscription:
            if frame.get("operation") != "request" or frame.get("topic") != self.config["businessTopic"]:
                raise ProviderError("Hub delivered a different operation or business topic")
            if not uuid_string(frame.get("senderSession")):
                raise ProviderError("Directed request has no valid sender session")
            if len(self.pending) >= self.MAX_PENDING_RESPONSES:
                raise ProviderError("Too many responses awaiting Hub acceptance")
            result = process_request(self.config["moduleId"], self.config["allowedCallers"],
                                     frame.get("fromPrincipal"), frame.get("body"))
            token = self.unique_token()
            self.pending[token] = {
                "kind": "response", "deadline": time.monotonic() + self.REQUEST_TIMEOUT,
                "delivery": frame,
            }
            # The Hub derives return identity/topic from the original request.
            self.bridge.send({"type": "respond", "requestSeq": frame["seq"],
                              "body": result, "requestToken": token})
        else:
            if (frame.get("operation") != "response"
                    or frame.get("topic") != self.config["directory"]["registerTopic"]):
                raise ProviderError("Hub delivered a different directory operation or topic")
            if (frame.get("fromPrincipal") != self.config["directory"]["principal"]
                    or not uuid_string(frame.get("senderSession"))):
                self.ack(frame)
                emit("directory-response-ignored", reason="untrusted-source")
                return
            self.consider_registration_response(frame)

    def dispatch(self, frame: dict[str, Any]) -> None:
        kind = frame.get("type")
        if self.control is not None and kind == self.control["expected"]:
            if frame.get(self.control["field"]) == self.control["id"]:
                self.control_result = frame
                return
        if kind == "delivery":
            self.delivery(frame)
            return
        if kind == "published":
            token = frame.get("requestToken")
            pending = self.pending.get(token) if isinstance(token, str) else None
            if pending is None:
                return  # A receipt arriving after a local deadline is retained by Hub.
            if not protocol_integer(frame.get("seq"), positive=True):
                raise ProviderError("Hub acceptance receipt has an invalid sequence")
            if pending["kind"] == "response":
                self.pending.pop(token)
                self.ack(pending["delivery"])
            else:
                pending["requestSeq"] = frame["seq"]
                candidates, pending["candidates"] = pending["candidates"], []
                for candidate in candidates:
                    self.consider_registration_response(candidate)
            return
        if kind in ("denied", "error"):
            token = frame.get("requestToken")
            pending = self.pending.get(token) if isinstance(token, str) else None
            if pending is not None and pending["kind"] == "registration":
                self.registration_failed("hub-registration-request-rejected")
                return
            # Some Hub rejections have no correlation token. Stop rather than
            # assigning an uncorrelated failure to an arbitrary pending request.
            raise ProviderError("Hub rejected a communication operation: " + str(frame.get("code", "UNKNOWN")))
        if kind in ("overflow", "catchup_truncated"):
            raise ProviderError("Hub reported a delivery loss or retained-history gap")
        if kind in ("caught_up", "registered", "subscribed", "unsubscribed"):
            return
        raise ProviderError("Hub returned an unsupported control frame")

    def check_deadlines(self) -> None:
        now = time.monotonic()
        for pending in list(self.pending.values()):
            if now < pending["deadline"]:
                continue
            if pending["kind"] == "registration":
                self.registration_failed("registration-deadline-exceeded")
            else:
                raise ProviderError("Response acceptance is uncertain after a finite deadline")

    def run(self) -> None:
        self.welcome = self.bridge.connect().frame
        features = self.welcome.get("features", [])
        directed = ((isinstance(features, list) and "directed-v1" in features)
                    or (isinstance(features, dict) and features.get("directed-v1") is True))
        if (self.welcome.get("authenticated") is not True
                or self.welcome.get("principal") != self.config["principal"]
                or not uuid_string(self.welcome.get("session"))
                or not protocol_integer(self.welcome.get("lastSeq")) or not directed):
            raise ProviderError("Authenticated welcome identity or directed-v1 feature does not match wiring")
        topics = [self.config["businessTopic"], self.config["directory"]["registerTopic"]]
        receipt = self.control_exchange({"type": "register", "channels": [
            {"name": topic, "publish": True, "subscribe": True} for topic in topics
        ]}, "registered", "requestToken")
        registered = receipt.get("channels")
        if not isinstance(registered, list) or any(
                not any(isinstance(channel, dict) and channel.get("name") == topic
                        and channel.get("publish") is True and channel.get("subscribe") is True
                        for channel in registered) for topic in topics):
            raise ProviderError("Hub channel registration does not confirm both directions")
        self.business_subscription = self.subscribe(self.config["businessTopic"], "request")
        self.directory_subscription = self.subscribe(self.config["directory"]["registerTopic"], "response")
        self.start_registration()
        while not self.stop.is_set():
            self.pump()
            self.check_deadlines()
            if self.registration is None and time.monotonic() >= self.next_registration:
                self.start_registration()


def schema_matches(schema: dict[str, Any], value: Any) -> bool:
    """Local verifier for only the JSON Schema keywords used by this contract."""
    if "oneOf" in schema:
        return sum(schema_matches(branch, value) for branch in schema["oneOf"]) == 1
    if "const" in schema:
        expected = schema["const"]
        if value != expected or (isinstance(expected, bool) and type(value) is not bool):
            return False
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return False
        if any(name not in value for name in schema.get("required", [])):
            return False
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False and any(name not in properties for name in value):
            return False
        return all(schema_matches(properties[name], item) for name, item in value.items() if name in properties)
    if kind == "string":
        if not isinstance(value, str):
            return False
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", math.inf):
            return False
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            return False
        if schema.get("format") == "uuid":
            try:
                uuid.UUID(value)
            except (ValueError, AttributeError):
                return False
    if kind == "integer":
        if not integer(value, schema.get("minimum", -(2 ** 100)), schema.get("maximum", 2 ** 100)):
            return False
    return True


def self_check(contract_path: Path) -> None:
    contract = load_contract(contract_path)
    results: list[dict[str, Any]] = []
    executions: set[str] = set()
    module = "independent.python.statistics"
    allowed = {"consumer.allowed"}

    def verify(name: str, body: Any, *, caller: str = "consumer.allowed",
               expected_error: str | None = None, expected: tuple[int, int, int, str] | None = None) -> None:
        result = process_request(module, allowed, caller, body)
        assert schema_matches(contract["outputSchema"], result), (name, result)
        assert result["provider"] == module and result["contract"] == CONTRACT
        assert result["invocationId"] == echoed_invocation(body)
        if expected_error:
            assert result["ok"] is False and result["error"]["code"] == expected_error, name
        else:
            assert schema_matches(contract["inputSchema"], body), name
            assert result["ok"] is True and expected is not None, name
            statistics = result["output"]
            actual = tuple(statistics[key] for key in ("codePoints", "lines", "utf8Bytes", "sha256"))
            assert actual == expected, (name, actual, expected)
            assert result["executionId"] not in executions, name
            executions.add(result["executionId"])
        results.append({"name": name, "passed": True})

    def request(text: Any, invocation: Any = "self-check") -> dict[str, Any]:
        return {"contract": dict(CONTRACT), "invocationId": invocation, "text": text}

    vectors = [
        ("empty", "", 0, 1, 0),
        ("emoji", "Hello\n世界 🌍", 10, 2, 17),
        ("decomposed", "e\u0301", 2, 1, 3),
        ("precomposed", "é", 1, 1, 2),
        ("crlf-and-whitespace", " \r\n\t\n", 5, 3, 5),
        ("lf-final-empty-segment", "\n", 1, 2, 1),
        ("ascii-byte-boundary", "a" * 16384, 16384, 1, 16384),
        ("emoji-byte-boundary", "🌍" * 4096, 4096, 1, 16384),
        ("lf-count-boundary", "\n" * 16384, 16384, 16385, 16384),
    ]
    for name, text, points, lines, byte_count in vectors:
        # The scalar, line and byte counts are explicit independent expectations.
        verify(name, request(text), expected=(points, lines, byte_count, hashlib.sha256(text.encode("utf-8")).hexdigest()))
    parsed_pair = json.loads('{"contract":{"id":"text.statistics","version":"1.0.0"},"invocationId":"pair","text":"\\ud83c\\udf0d"}')
    verify("escaped-surrogate-pair", parsed_pair, expected=(1, 1, 4, hashlib.sha256(bytes([240, 159, 140, 141])).hexdigest()))
    verify("invocation-256-code-points", request("", "🌍" * 256), expected=(0, 1, 0, hashlib.sha256(b"").hexdigest()))
    for name, body in [
        ("ascii-over-limit", request("a" * 16385)),
        ("utf8-over-limit", request("🌍" * 4097)),
        ("isolated-high-surrogate", request("\ud800")),
        ("isolated-low-surrogate", request("\udfff")),
        ("extra-top-field", {**request(""), "unexpected": True}),
        ("extra-contract-field", {**request(""), "contract": {**CONTRACT, "extra": True}}),
        ("missing-text", {"contract": dict(CONTRACT), "invocationId": "missing"}),
        ("text-not-string", request(17)),
        ("invocation-not-string", request("", 17)),
        ("invocation-empty", request("", "")),
        ("invocation-over-limit", request("", "🌍" * 257)),
    ]:
        verify(name, body, expected_error="INPUT_INVALID")
    verify("contract-version-mismatch", {**request(""), "contract": {"id": "text.statistics", "version": "2.0.0"}}, expected_error="CONTRACT_MISMATCH")
    verify("non-object-body", [1, 2], expected_error="CONTRACT_MISMATCH")
    verify("unauthorized", request(""), caller="consumer.denied", expected_error="PERMISSION_DENIED")
    verify("authorization-before-validation", {"contract": {}}, caller="consumer.denied", expected_error="PERMISSION_DENIED")
    verify("body-identity-cannot-authorize", {**request(""), "fromPrincipal": "consumer.allowed"}, caller="consumer.denied", expected_error="PERMISSION_DENIED")
    numeric_prefix = '{"contract":{"id":"text.statistics","version":"1.0.0"},"invocationId":"numeric","text":'
    for name, literal in [("numeric-overflow-is-not-text", "1e400"), ("huge-numeric-literal-is-not-text", "7" * 4001)]:
        raw = '{"type":"delivery","body":' + numeric_prefix + literal + '}}'
        verify(name, application_frame(raw)["body"], expected_error="INPUT_INVALID")
    sample_config = {"moduleId": module, "moduleVersion": "1.2.3", "businessTopic": "independent/python/statistics", "leaseMs": 1800}
    manifest = build_manifest(sample_config, contract)
    assert manifest["capabilities"][0]["inputSchema"] == contract["inputSchema"]
    assert manifest["capabilities"][0]["outputSchema"] == contract["outputSchema"]
    assert not any(key in manifest for key in ("principal", "session", "endpoint"))
    results.append({"name": "complete-schema-advertisement", "passed": True})
    session = str(uuid.uuid4())
    registration = {
        "ok": True, "kind": "demo.capability-registration", "epoch": str(uuid.uuid4()),
        "entry": {"module": copy.deepcopy(manifest["module"]), "capabilities": copy.deepcopy(manifest["capabilities"]),
                  "principal": "provider.allowed", "session": session, "registeredAt": 1791500000000,
                  "expiresAt": 1791500001800, "state": "lease-valid"},
    }
    validate_registration(registration, manifest, "provider.allowed", session)
    results.append({"name": "complete-directory-confirmation", "passed": True})
    for name, changed in [
        ("directory-wrong-principal", {**registration["entry"], "principal": "provider.other"}),
        ("directory-wrong-session", {**registration["entry"], "session": str(uuid.uuid4())}),
        ("directory-wrong-expiry", {**registration["entry"], "expiresAt": 1791500001799}),
        ("directory-truncated-schemas", {**registration["entry"], "capabilities": []}),
    ]:
        try:
            validate_registration({**registration, "entry": changed}, manifest, "provider.allowed", session)
        except ProviderError:
            results.append({"name": name, "passed": True})
        else:
            raise AssertionError(name)
    assert results and len(executions) == 11
    print(json_text({"event": "self-check", "type": "self-check", "passed": True, "count": len(results), "checks": results}), flush=True)


def stdin_control(stop: threading.Event) -> None:
    for line in sys.stdin:
        if line.strip() == "stop":
            stop.set()
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Public-contract Python text.statistics provider")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--config", type=Path, help="Private JSON wiring file; relative paths resolve from this file")
    mode.add_argument("--self-check", action="store_true", help="Run this author's local machine-contract checks")
    parser.add_argument("--contract-path", type=Path, help="Public machine contract path for --self-check")
    arguments = parser.parse_args(argv)
    if arguments.self_check:
        contract_path = arguments.contract_path or Path(__file__).resolve().parents[2] / "docs/modules/text-statistics.contract.json"
        self_check(contract_path.resolve())
        return 0
    stop = threading.Event()
    bridge = None
    exit_code = 0
    try:
        config = load_config(arguments.config)
        contract = load_contract(config["contractPath"])
        manifest = build_manifest(config, contract)
        # Import only the public SDK. Avoid creating bytecode in its directory.
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(config["sdkDirectory"]))
        try:
            sdk = importlib.import_module("hub_bridge")
        except (ImportError, OSError) as exc:
            raise ProviderError("Public Python SDK or websockets dependency is unavailable") from exc
        bridge = sdk.Bridge(config["endpoint"], config["bridgeId"],
                            credential=config.get("credential", config["principal"]),
                            token=config["token"], timeout=2.0)
        threading.Thread(target=stdin_control, args=(stop,), daemon=True,
                         name="provider-stdin-control").start()
        import signal
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda _number, _frame: stop.set())
        WireProvider(bridge, config, manifest, stop).run()
    except ProviderError as exc:
        if not stop.is_set():
            emit("error", code="PROVIDER_FAILED", reason=str(exc))
            exit_code = 1
    except Exception as exc:
        if not stop.is_set():
            # SDK errors are diagnostic; never expose raw frames or private tokens.
            emit("error", code=str(getattr(exc, "code", "RUNTIME_FAILED")),
                 reason="A dependency or transport operation failed.")
            exit_code = 1
    finally:
        if bridge is not None:
            try:
                bridge.close()
            except Exception:
                emit("error", code="CLOSE_FAILED", reason="Bridge shutdown did not complete normally.")
                exit_code = 1
    emit("stopped", reason="stop" if stop.is_set() else "failure")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

