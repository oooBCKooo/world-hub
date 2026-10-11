"""Independent public-vector check using Python cryptography; not a product dependency."""
import base64
import hashlib
import json
import pathlib
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

PREFIX = b"WORLD-HUB-PUBLISHER-EVIDENCE/1\n"


def canonical(value):
    # All closed-schema keys are ASCII. Unicode values remain exact scalars,
    # with no NFC conversion or replacement of invalid input.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def main():
    vectors = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    matched = verified = rejected = 0
    for entry in vectors["vectors"]:
        evidence = entry["evidence"]
        signing_bytes = PREFIX + canonical(evidence["payload"])
        assert signing_bytes.hex() == entry["signingBytesHex"]
        matched += 1
        keys = {}
        for supplied in evidence["publicKeys"]:
            raw = base64.b64decode(supplied["publicKey"], validate=True)
            assert len(raw) == 32
            assert "ed25519-sha256:" + hashlib.sha256(raw).hexdigest() == supplied["keyId"]
            keys[supplied["keyId"]] = Ed25519PublicKey.from_public_bytes(raw)
        for statement in evidence["signatures"]:
            assert statement["algorithm"] == "Ed25519"
            signature = base64.b64decode(statement["value"], validate=True)
            keys[statement["keyId"]].verify(signature, signing_bytes)
            verified += 1
            damaged = bytes([signature[0] ^ 1]) + signature[1:]
            try:
                keys[statement["keyId"]].verify(damaged, signing_bytes)
            except InvalidSignature:
                rejected += 1
            else:
                raise AssertionError("Tampered signature was accepted")
            try:
                keys[statement["keyId"]].verify(signature, signing_bytes + b" ")
            except InvalidSignature:
                pass
            else:
                raise AssertionError("Changed canonical bytes were accepted")
    print(json.dumps({"independentLanguage": "Python", "canonicalBytesMatched": matched,
                      "signaturesVerified": verified, "tamperedSignaturesRejected": rejected}))


if __name__ == "__main__":
    main()
