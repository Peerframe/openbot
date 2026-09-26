import asyncio
from datetime import datetime, timezone
import hashlib
from unittest.mock import AsyncMock

import pytest

from openbot_server.auth import (
    AttemptResult, InvalidClientIdentity, InvalidCredentials, OwnerAuthentication, RateLimited,
    client_digest,
)
from openbot_server.database import StoreUnavailable

PASSWORD = "synthetic-owner-passphrase"
EXPIRES = datetime(2030, 1, 1, tzinfo=timezone.utc)


def service(outcome):
    persistence = AsyncMock()
    persistence.attempt.return_value = outcome
    return OwnerAuthentication(persistence, owner_name="Owner", password=PASSWORD), persistence


def test_tokens_use_existing_wire_digest_without_storing_or_printing_plaintext():
    auth, persistence = service(AttemptResult("issued", EXPIRES))
    issued = asyncio.run(auth.login(PASSWORD, "127.0.0.1"))
    assert len(issued.token) == 43
    assert issued.token not in repr(issued)
    assert issued.session.model_dump()["owner"] == {"id": "owner", "name": "Owner"}
    kwargs = persistence.attempt.call_args.kwargs
    assert kwargs["token_digest"] == hashlib.sha256(issued.token.encode()).hexdigest()
    assert kwargs["valid_password"] is True
    assert PASSWORD not in repr(kwargs)
    assert PASSWORD not in repr(vars(auth))


def test_wrong_password_is_reserved_and_never_trimmed_or_ignored():
    auth, persistence = service(AttemptResult("invalid"))
    with pytest.raises(InvalidCredentials):
        asyncio.run(auth.login(" " + PASSWORD, "127.0.0.1"))
    assert persistence.attempt.call_args.kwargs["valid_password"] is False


def test_throttle_survives_correct_password_and_storage_error_never_issues_token():
    auth, persistence = service(AttemptResult("throttled", retry_after=280))
    with pytest.raises(RateLimited) as limited:
        asyncio.run(auth.login(PASSWORD, "127.0.0.1"))
    assert limited.value.retry_after == 280
    persistence.attempt.side_effect = StoreUnavailable("fixed")
    with pytest.raises(StoreUnavailable):
        asyncio.run(auth.login(PASSWORD, "127.0.0.1"))


@pytest.mark.parametrize("address", [None, "hostname", "127.1", "fe80::1%en0", "127.0.0.1:1234"])
def test_noncanonical_direct_identity_never_reaches_store(address):
    auth, persistence = service(AttemptResult("issued", EXPIRES))
    with pytest.raises(InvalidClientIdentity):
        asyncio.run(auth.login(PASSWORD, address))
    persistence.attempt.assert_not_called()


def test_equivalent_ipv6_peers_share_the_legacy_digest_namespace():
    assert client_digest("2001:0DB8:0:0:0:0:0:1") == client_digest("2001:db8::1")
    assert client_digest("::ffff:127.0.0.1") == hashlib.sha256(
        b"openbot:client-network:v1\0::ffff:7f00:1").hexdigest()


@pytest.mark.parametrize("password", ["short", "replace-with-a-long-random-owner-password", "x" * 1025])
def test_unsafe_password_configuration_is_rejected(password):
    with pytest.raises(ValueError):
        OwnerAuthentication(AsyncMock(), owner_name="Owner", password=password)


@pytest.mark.parametrize("ttl", [0, 169, True, 1.5, "12"])
def test_invalid_ttl_is_not_coerced(ttl):
    with pytest.raises(ValueError):
        OwnerAuthentication(AsyncMock(), owner_name="Owner", password=PASSWORD, ttl_hours=ttl)


@pytest.mark.parametrize("count", [15, 513, 1024])
def test_astral_passwords_use_retained_zod_codepoint_bound(count):
    persistence = AsyncMock()
    persistence.attempt.return_value = AttemptResult("issued", EXPIRES)
    password = "🙂" * count
    auth = OwnerAuthentication(persistence, owner_name="Owner", password=password)
    assert asyncio.run(auth.login(password, "127.0.0.1")).session.authenticated is True
    assert persistence.attempt.call_args.kwargs["valid_password"] is True


@pytest.mark.parametrize("count", [8, 14, 1025])
def test_astral_password_configuration_rejects_short_or_unusable_values(count):
    with pytest.raises(ValueError):
        OwnerAuthentication(AsyncMock(), owner_name="Owner", password="🙂" * count)
