"""Role-separated Compact JWS using released joserfc; verification is not Work authorization."""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
import re

from joserfc import jws
from joserfc.jwk import OKPKey

from .work_command_contract import (
    CommandBinding, CommandContractError, Identity, MAX_TOKEN_BYTES, PURPOSE_ROLE, TOKEN_TYPES,
    bounded_value, parse, strict_json, validate_claims)
from pydantic import TypeAdapter


def _invalid():
    raise CommandContractError("invalid_command_token")


def _identity(value):
    try:
        return TypeAdapter(Identity).validate_python(value, strict=True)
    except Exception:
        _invalid()


def _key(pem, *, private):
    if type(pem) is not bytes or not 32 <= len(pem) <= 4096:
        _invalid()
    try:
        key = OKPKey.import_key(pem)
        if key.curve_name != "Ed25519" or key.is_private != private:
            _invalid()
        return key
    except Exception:
        raise CommandContractError("invalid_command_token") from None


def _segment(value, maximum):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        _invalid()
    try:
        data = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        if len(data) > maximum or base64.urlsafe_b64encode(data).decode("ascii").rstrip("=") != value:
            _invalid()
        return data
    except Exception:
        raise CommandContractError("invalid_command_token") from None


def _parts(token):
    if type(token) is not str or len(token) > MAX_TOKEN_BYTES or not token.isascii():
        _invalid()
    parts = token.split(".")
    if len(parts) != 3:
        _invalid()
    header = strict_json(_segment(parts[0], 512), maximum=512)
    payload = strict_json(_segment(parts[1], MAX_TOKEN_BYTES), maximum=MAX_TOKEN_BYTES)
    if (len(_segment(parts[2], 64)) != 64 or type(header) is not dict
            or set(header) != {"alg", "typ", "kid"} or header["alg"] != "Ed25519"):
        _invalid()
    _identity(header["kid"])
    return header, payload


def _registry():
    result = jws.JWSRegistry(algorithms=["Ed25519"])
    result.max_header_length = 512
    result.max_payload_length = MAX_TOKEN_BYTES
    # joserfc bounds the encoded signature segment; our preflight requires 64 decoded bytes.
    result.max_signature_length = 86
    return result


@dataclass(frozen=True)
class VerificationPin:
    issuer: str
    kid: str
    role: str
    public_pem: bytes = field(repr=False)
    _key: OKPKey = field(init=False, repr=False, compare=False)

    def __post_init__(self):
        _identity(self.issuer); _identity(self.kid)
        if self.role not in ("control", "enforcement"):
            _invalid()
        object.__setattr__(self, "_key", _key(self.public_pem, private=False))


class TokenSigner:
    def __init__(self, *, issuer, kid, role, private_pem):
        self.issuer, self.kid = _identity(issuer), _identity(kid)
        if role not in ("control", "enforcement"):
            _invalid()
        self.role, self._key = role, _key(private_pem, private=True)

    def sign(self, value, *, purpose, now_ms):
        try:
            if PURPOSE_ROLE.get(purpose) != self.role:
                _invalid()
            claims = validate_claims(value, purpose=purpose, now_ms=now_ms)
            if (claims.iss != self.issuer
                    or self.role == "enforcement" and claims.enforcementKeyId != self.kid):
                _invalid()
            token = jws.serialize_compact(
                {"alg": "Ed25519", "typ": TOKEN_TYPES[purpose], "kid": self.kid},
                bounded_value(claims.model_dump(), maximum=MAX_TOKEN_BYTES),
                self._key, registry=_registry())
            _parts(token)
            return token
        except Exception:
            raise CommandContractError("invalid_command_token") from None


class TokenVerifier:
    def __init__(self, pins):
        if type(pins) not in (list, tuple) or not 1 <= len(pins) <= 16:
            _invalid()
        self._pins = {}
        key_roles = {}
        for pin in pins:
            if not isinstance(pin, VerificationPin) or (pin.issuer, pin.kid) in self._pins:
                _invalid()
            self._pins[pin.issuer, pin.kid] = pin
            key_identity = pin._key.as_dict()["x"]
            if key_identity in key_roles and key_roles[key_identity] != pin.role:
                _invalid()
            key_roles[key_identity] = pin.role

    def verify(self, token, *, purpose, issuer, audience, expected_binding, now_ms,
               expected_request=None):
        """Caller supplies trusted identity/binding; returned claims grant no SQL authority.

        Consume, permit and receipt require the one outstanding requestId/nonce from trusted
        local state. This is not a replay store: SQL consumption and the protected host ledger
        remain mandatory after cryptographic verification.
        """
        try:
            expected = parse(CommandBinding, expected_binding)
            _identity(issuer); _identity(audience)
            header, payload = _parts(token)
            if purpose not in TOKEN_TYPES or header["typ"] != TOKEN_TYPES[purpose]:
                _invalid()
            pin = self._pins.get((issuer, header["kid"]))
            if pin is None or pin.role != PURPOSE_ROLE[purpose]:
                _invalid()
            # No callback, KeySet, JWK URL or untrusted key can reach the JOSE library.
            verified = jws.deserialize_compact(token, pin._key, registry=_registry())
            if strict_json(verified.payload, maximum=MAX_TOKEN_BYTES) != payload:
                _invalid()
            claims = validate_claims(payload, purpose=purpose, now_ms=now_ms)
            if claims.iss != issuer or claims.aud != audience:
                _invalid()
            if pin.role == "enforcement" and claims.enforcementKeyId != pin.kid:
                _invalid()
            for key, value in expected.model_dump().items():
                if getattr(claims, key) != value:
                    _invalid()
            if purpose == "work_command_dispatch":
                if expected_request is not None:
                    _invalid()
            elif (type(expected_request) is not dict or set(expected_request) != {"requestId", "nonce"}
                    or claims.requestId != expected_request["requestId"]
                    or claims.nonce != expected_request["nonce"]):
                _invalid()
            return claims
        except Exception:
            raise CommandContractError("invalid_command_token") from None
