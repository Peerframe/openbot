"""Independent regression tests for the public read projections in ``openbot_server.models``.

These tests pin the public JSON produced by the frozen projection API against the behaviour of the
existing TypeScript projections they mirror: ``Bot`` / ``Channel`` / ``BotAppearance`` /
``AuthSessionSnapshot`` in ``packages/domain/src/index.ts`` and ``toBot``, ``toBotAppearance`` and
``listChannels`` in ``apps/server/src/postgres-store.ts``.

Every assertion is made on the serialized public payload (``model_dump(mode="json",
exclude_none=True)``), never merely on the fact that a model instantiates. The tests claim nothing
about HTTP, authentication, authorization, SQL ordering or database behaviour; the projection layer
receives already-authorized, already-ordered rows.
"""
import copy
import json
import os
import time as time_module
from datetime import datetime, timedelta, timezone, tzinfo

import pytest
from pydantic import TypeAdapter

from openbot_server import models

# Enum literals copied verbatim from packages/domain/src/index.ts.
BOT_STATUSES = [
    "idle",
    "running",
    "waiting_approval",
    "blocked",
    "human_takeover",
    "offline",
    "completed",
    "failed",
]
COMPUTER_PROFILES = ["none", "docker-linux", "macos-cua", "lume-vm", "coder"]
HEAD_SHAPES = ["round", "square", "cat"]
BODY_SHAPES = ["classic", "tall", "cape", "armor", "storage", "quadruped"]
MOBILITIES = ["feet", "single-wheel", "dual-wheel", "hover", "four-legs"]
ACCESSORIES = ["none", "headphones", "backpack", "trench", "arm", "toolbox"]
ACCENTS = ["green", "yellow", "red", "blue"]

BOT_PUBLIC_FIELDS = {"id", "name", "role", "status", "computerProfile", "appearance", "createdAt"}
BOT_REQUIRED_FIELDS = BOT_PUBLIC_FIELDS - {"appearance"}
CHANNEL_PUBLIC_FIELDS = {"id", "name", "description", "botIds", "directBotId", "createdAt"}
CHANNEL_REQUIRED_FIELDS = CHANNEL_PUBLIC_FIELDS - {"directBotId"}


def public_json(model):
    """The exact payload the read routes hand to the client."""
    return model.model_dump(mode="json", exclude_none=True)


def bot_row(**overrides):
    """A ``bots`` row as a snake_case PostgreSQL mapping."""
    row = {
        "id": "bot-1",
        "name": "巡检机器人",
        "role": "维护员",
        "status": "idle",
        "computer_profile": "docker-linux",
        "configuration": {},
        "created_at": datetime(2026, 1, 2, 3, 4, 5, 123000, tzinfo=timezone.utc),
    }
    row.update(overrides)
    return row


def channel_row(channel_id, **overrides):
    """One flat ``channels LEFT JOIN channel_bots`` row."""
    row = {
        "id": channel_id,
        "name": f"channel {channel_id}",
        "description": f"description {channel_id}",
        "direct_bot_id": None,
        "created_at": datetime(2026, 1, 2, 3, 4, 5, 123000, tzinfo=timezone.utc),
        "bot_id": None,
    }
    row.update(overrides)
    return row


def appearance(**overrides):
    value = {
        "head": "round",
        "body": "cape",
        "mobility": "hover",
        "accessory": "backpack",
        "accent": "red",
    }
    value.update(overrides)
    return value


# ---------------------------------------------------------------------------
# iso_timestamp: UTC conversion and exact millisecond precision
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("microsecond", "expected"),
    [
        (0, "2026-01-02T03:04:05.000Z"),
        (1, "2026-01-02T03:04:05.000Z"),
        (999, "2026-01-02T03:04:05.000Z"),
        (1000, "2026-01-02T03:04:05.001Z"),
        (123456, "2026-01-02T03:04:05.123Z"),
        (123999, "2026-01-02T03:04:05.123Z"),
        (999999, "2026-01-02T03:04:05.999Z"),
    ],
)
def test_iso_timestamp_truncates_to_exact_milliseconds(microsecond, expected):
    """Sub-millisecond digits are truncated, never rounded up (JS Date has ms precision only)."""
    value = datetime(2026, 1, 2, 3, 4, 5, microsecond, tzinfo=timezone.utc)
    assert models.iso_timestamp(value) == expected
    assert len(expected) == 24 and expected.endswith("Z")


@pytest.mark.parametrize(
    ("offset", "expected"),
    [
        # 2026-01-02 11:04:05.123 at the listed offset, stated as the same instant in UTC.
        (timedelta(hours=8), "2026-01-02T03:04:05.123Z"),
        (timedelta(hours=14), "2026-01-01T21:04:05.123Z"),
        (timedelta(hours=-12), "2026-01-02T23:04:05.123Z"),
        (timedelta(hours=-5, minutes=-30), "2026-01-02T16:34:05.123Z"),
        (timedelta(hours=5, minutes=45), "2026-01-02T05:19:05.123Z"),
        (timedelta(0), "2026-01-02T11:04:05.123Z"),
    ],
)
def test_iso_timestamp_converts_any_offset_to_utc(offset, expected):
    """A database offset is normalised to UTC, including day-boundary crossings."""
    value = datetime(2026, 1, 2, 11, 4, 5, 123000, tzinfo=timezone(offset))
    assert models.iso_timestamp(value) == expected


def test_iso_timestamp_keeps_four_digit_years_that_js_also_pads():
    assert models.iso_timestamp(datetime(1, 1, 1, tzinfo=timezone.utc)) == "0001-01-01T00:00:00.000Z"
    assert models.iso_timestamp(datetime(999, 12, 31, 23, 59, 59, tzinfo=timezone.utc)) == (
        "0999-12-31T23:59:59.000Z"
    )


class _NullOffset(tzinfo):
    def utcoffset(self, _):
        return None

    def dst(self, _):
        return None

    def tzname(self, _):
        return "NULL"


@pytest.mark.parametrize(
    "value",
    [
        datetime(2026, 1, 2, 3, 4, 5),
        datetime(2026, 1, 2, 3, 4, 5, 123000),
        datetime(2026, 1, 2, tzinfo=_NullOffset()),
        "2026-01-02T03:04:05.123Z",
        "2026-01-02T03:04:05+00:00",
        None,
        5,
        0.0,
        {"year": 2026},
        b"2026-01-02",
    ],
)
def test_iso_timestamp_rejects_every_non_aware_datetime(value):
    """Naive datetimes and non-datetime inputs fail closed instead of silently using a local zone."""
    with pytest.raises(ValueError, match="timezone-aware"):
        models.iso_timestamp(value)


def test_timestamps_do_not_depend_on_the_process_local_zone(monkeypatch):
    """An aware value converts through UTC no matter what TZ the process runs under."""
    if not hasattr(time_module, "tzset"):
        pytest.skip("platform has no time.tzset")
    original = os.environ.get("TZ")
    shifted = datetime(2026, 1, 2, 11, 4, 5, 123000, tzinfo=timezone(timedelta(hours=8)))
    naive = datetime(2026, 1, 2, 3, 4, 5, 123000)
    try:
        monkeypatch.setenv("TZ", "Pacific/Kiritimati")
        time_module.tzset()
        assert models.iso_timestamp(shifted) == "2026-01-02T03:04:05.123Z"
        with pytest.raises(ValueError, match="timezone-aware"):
            models.iso_timestamp(naive)
    finally:
        if original is None:
            monkeypatch.delenv("TZ", raising=False)
        else:
            monkeypatch.setenv("TZ", original)
        time_module.tzset()


# ---------------------------------------------------------------------------
# project_bot: whitelisted public projection
# ---------------------------------------------------------------------------


def test_project_bot_emits_exactly_the_public_field_names():
    projected = public_json(models.project_bot(bot_row()))
    assert set(projected) == BOT_REQUIRED_FIELDS
    assert "description" not in projected
    assert "configuration" not in projected
    assert "profileRevision" not in projected
    assert "profile_revision" not in projected


def test_project_bot_omits_absent_optional_fields_instead_of_serializing_null():
    projected = public_json(models.project_bot(bot_row()))
    assert "appearance" not in projected
    assert "null" not in json.dumps(projected)
    # exclude_none is what removes the key; the raw dump still carries a null placeholder.
    assert models.project_bot(bot_row()).model_dump(mode="json")["appearance"] is None


@pytest.mark.parametrize(
    "name",
    [
        "巡检机器人",
        "巡檢機器人",
        "قسم المراقبة",
        "مراقب",
        "🛠️ maintenance bot",
        "cafe\u0301 bot",
        "\u200bzero-width",
        "bots/fleet-1",
        "名前\twith\ttabs",
    ],
)
def test_project_bot_preserves_unicode_names_without_escaping_or_mangling(name):
    row = bot_row(name=name)
    projected = models.project_bot(row)
    assert projected.name == name
    assert json.dumps(public_json(projected), ensure_ascii=False) == json.dumps(
        {
            "id": "bot-1",
            "name": name,
            "role": "维护员",
            "status": "idle",
            "computerProfile": "docker-linux",
            "createdAt": "2026-01-02T03:04:05.123Z",
        },
        ensure_ascii=False,
    )


@pytest.mark.parametrize(
    "configuration",
    [
        {},
        None,
        [],
        [appearance()],
        "appearance",
        7,
        {"appearance": None},
        {"appearance": "round"},
        {"appearance": []},
        {"other": appearance()},
    ],
)
def test_project_bot_omits_appearance_for_non_object_configuration(configuration):
    """``asRecord``-equivalent handling: anything that is not an object has no appearance."""
    projected = public_json(models.project_bot(bot_row(configuration=configuration)))
    assert "appearance" not in projected


def test_project_bot_omits_configuration_key_absent_from_the_row():
    row = bot_row()
    del row["configuration"]
    projected = public_json(models.project_bot(row))
    assert "appearance" not in projected
    assert set(projected) == BOT_REQUIRED_FIELDS


def test_project_bot_keeps_a_fully_valid_appearance_verbatim():
    projected = public_json(models.project_bot(bot_row(configuration={"appearance": appearance()})))
    assert projected["appearance"] == appearance()


def test_project_bot_drops_unknown_appearance_keys_and_does_not_leak_configuration():
    row = bot_row(
        configuration={
            "appearance": {**appearance(), "unknown": "x", "prompt": "private"},
            "apiKey": "sk-secret",
            "password": "hunter2",
            "systemPrompt": "do not expose",
        }
    )
    projected = public_json(models.project_bot(row))
    assert projected["appearance"] == appearance()
    serialized = json.dumps(projected, ensure_ascii=False)
    for secret in ("apiKey", "sk-secret", "password", "hunter2", "systemPrompt", "private", "unknown"):
        assert secret not in serialized


def test_project_bot_does_not_expose_extra_row_columns():
    row = bot_row()
    row["secret_column"] = "s3cr3t"
    row["description"] = "internal description"
    projected = public_json(models.project_bot(row))
    assert set(projected) == BOT_REQUIRED_FIELDS
    assert "s3cr3t" not in json.dumps(projected)
    assert "internal description" not in json.dumps(projected)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("head", "cone"),
        ("head", None),
        ("head", 1),
        ("head", ""),
        ("body", "huge"),
        ("mobility", "wheels"),
        ("accessory", "hat"),
        ("accent", "purple"),
        ("accent", True),
    ],
)
def test_project_bot_omits_appearance_when_any_shape_value_is_invalid(field, value):
    """``toBotAppearance`` returns undefined for an out-of-enum member, so the key disappears."""
    projected = public_json(
        models.project_bot(bot_row(configuration={"appearance": appearance(**{field: value})}))
    )
    assert "appearance" not in projected


@pytest.mark.parametrize("missing", HEAD_SHAPES)
def test_project_bot_omits_partial_appearance(missing):
    partial = {key: value for key, value in appearance().items() if key != "accent"}
    partial.pop(missing, None)
    projected = public_json(models.project_bot(bot_row(configuration={"appearance": partial})))
    assert "appearance" not in projected


def test_project_bot_is_stricter_than_the_ts_string_coercion_for_contrived_members():
    """Documented divergence, recorded in TASK_006_RESULT.md.

    ``toBotAppearance`` compares ``String(candidate.head)`` against the enum, so a single-element
    array such as ``["round"]`` is accepted by TypeScript. The strict Pydantic model rejects any
    non-string member and the appearance is omitted. This is a fail-closed difference on a shape no
    real configuration can produce; it is pinned here so the intent is explicit.
    """
    row = bot_row(configuration={"appearance": appearance(head=["round"])})
    assert "appearance" not in public_json(models.project_bot(row))


def test_project_bot_covers_every_status_and_profile_combination():
    for status in BOT_STATUSES:
        for profile in COMPUTER_PROFILES:
            row = bot_row(status=status, computer_profile=profile, configuration={"appearance": appearance()})
            projected = public_json(models.project_bot(row))
            assert projected["status"] == status
            assert projected["computerProfile"] == profile
            assert projected["appearance"] == appearance()


def test_project_bot_covers_every_appearance_combination():
    combinations = 0
    for head in HEAD_SHAPES:
        for body in BODY_SHAPES:
            for mobility in MOBILITIES:
                for accessory in ACCESSORIES:
                    for accent in ACCENTS:
                        candidate = {
                            "head": head,
                            "body": body,
                            "mobility": mobility,
                            "accessory": accessory,
                            "accent": accent,
                        }
                        projected = public_json(
                            models.project_bot(bot_row(configuration={"appearance": candidate}))
                        )
                        assert projected["appearance"] == candidate
                        combinations += 1
    assert combinations == 3 * 6 * 5 * 6 * 4 == 2160


@pytest.mark.parametrize("status", ["thinking", "idle ", "IDLE", "waiting-approval", ""])
def test_project_bot_rejects_unknown_status_values(status):
    """``bots.status`` is unconstrained text; the model refuses to publish an unknown enum."""
    with pytest.raises(models.ValidationError):
        models.project_bot(bot_row(status=status))


@pytest.mark.parametrize("profile", ["windows", "docker", "MACOS-CUA", ""])
def test_project_bot_rejects_unknown_computer_profiles(profile):
    with pytest.raises(models.ValidationError):
        models.project_bot(bot_row(computer_profile=profile))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("name", 3),
        ("role", None),
        ("id", 3),
        ("status", 3),
        ("computer_profile", ["none"]),
    ],
)
def test_project_bot_rejects_non_string_and_wrongly_typed_columns(field, value):
    with pytest.raises(models.ValidationError):
        models.project_bot(bot_row(**{field: value}))


@pytest.mark.parametrize(
    "created_at",
    [
        datetime(2026, 1, 2, 3, 4, 5),
        "2026-01-02T03:04:05.000Z",
        None,
        1767323045,
    ],
)
def test_project_bot_rejects_invalid_created_at_values(created_at):
    with pytest.raises(ValueError, match="timezone-aware"):
        models.project_bot(bot_row(created_at=created_at))


def test_project_bot_requires_every_mandatory_column():
    for column in ("id", "name", "role", "status", "computer_profile", "created_at"):
        row = bot_row()
        del row[column]
        with pytest.raises((KeyError, ValueError)):
            models.project_bot(row)


def test_project_bot_only_reads_and_never_mutates_the_row():
    row = bot_row(configuration={"appearance": appearance(), "apiKey": "sk-secret"})
    snapshot = copy.deepcopy(row)
    models.project_bot(row)
    assert row == snapshot


# ---------------------------------------------------------------------------
# project_channels: flat LEFT JOIN rows grouped in first-occurrence order
# ---------------------------------------------------------------------------


def test_project_channels_returns_an_empty_list_for_no_rows():
    assert models.project_channels([]) == []


def test_project_channels_groups_by_first_occurrence_and_preserves_membership_order():
    rows = [
        channel_row("c2", bot_id="b1"),
        channel_row("c1", bot_id="b1", direct_bot_id="b9"),
        channel_row("c2", bot_id="b2"),
        channel_row("c2", bot_id="b1"),
        channel_row("c3", direct_bot_id="b7"),
    ]
    projected = [public_json(channel) for channel in models.project_channels(rows)]
    assert [channel["id"] for channel in projected] == ["c2", "c1", "c3"]
    assert projected[0]["botIds"] == ["b1", "b2", "b1"]
    assert projected[1]["botIds"] == ["b1"]
    assert projected[2]["botIds"] == []


def test_project_channels_does_not_reorder_rows_by_timestamp():
    """Ordering is the SQL caller's responsibility; the projection keeps the given row order."""
    rows = [
        channel_row("newest", created_at=datetime(2030, 1, 1, tzinfo=timezone.utc)),
        channel_row("oldest", created_at=datetime(1999, 1, 1, tzinfo=timezone.utc)),
        channel_row("middle", created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)),
    ]
    assert [channel.id for channel in models.project_channels(rows)] == ["newest", "oldest", "middle"]


def test_project_channels_uses_the_first_row_for_name_description_and_created_at():
    rows = [
        channel_row("c1", name="first", description="d1", created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)),
        channel_row("c1", name="second", description="d2", created_at=datetime(2027, 1, 1, tzinfo=timezone.utc), bot_id="b1"),
        channel_row("c1", name="third", description="d3", created_at=datetime(2028, 1, 1, tzinfo=timezone.utc), bot_id="b2"),
    ]
    projected = public_json(models.project_channels(rows)[0])
    assert projected["name"] == "first"
    assert projected["description"] == "d1"
    assert projected["createdAt"] == "2026-01-01T00:00:00.000Z"
    assert projected["botIds"] == ["b1", "b2"]


def test_project_channels_ignores_a_late_direct_bot_id():
    """``directBotId`` is only taken from the first occurrence, exactly as the TS map does."""
    rows = [
        channel_row("c1", bot_id="b1"),
        channel_row("c1", bot_id="b1", direct_bot_id="b2"),
    ]
    projected = public_json(models.project_channels(rows)[0])
    assert "directBotId" not in projected
    assert projected["botIds"] == ["b1", "b1"]


@pytest.mark.parametrize("direct_bot_id", [None])
def test_project_channels_omits_absent_direct_bot_id_without_null(direct_bot_id):
    projected = public_json(models.project_channels([channel_row("c1", direct_bot_id=direct_bot_id)])[0])
    assert set(projected) == CHANNEL_REQUIRED_FIELDS
    assert "null" not in json.dumps(projected)


def test_project_channels_keeps_a_present_direct_bot_id():
    projected = public_json(models.project_channels([channel_row("c1", direct_bot_id="bot-9")])[0])
    assert projected["directBotId"] == "bot-9"
    assert set(projected) == CHANNEL_PUBLIC_FIELDS


def test_project_channels_null_membership_yields_an_empty_list():
    projected = public_json(models.project_channels([channel_row("c1", bot_id=None)])[0])
    assert projected["botIds"] == []


def test_project_channels_preserves_unicode_names_and_descriptions():
    rows = [
        channel_row("c1", name="研发频道 🚀", description="描述：包含中文、emoji 和 قناة", bot_id="bot-1"),
    ]
    projected = public_json(models.project_channels(rows)[0])
    assert projected["name"] == "研发频道 🚀"
    assert projected["description"] == "描述：包含中文、emoji 和 قناة"
    assert json.loads(json.dumps(projected, ensure_ascii=False)) == projected


def test_project_channels_converts_each_row_timestamp_independently():
    rows = [
        channel_row("c1", created_at=datetime(2026, 1, 2, 11, 4, 5, 123456, tzinfo=timezone(timedelta(hours=8)))),
        channel_row("c2", created_at=datetime(2026, 6, 1, 0, 0, tzinfo=timezone(timedelta(hours=-5, minutes=-30)))),
    ]
    projected = [public_json(channel) for channel in models.project_channels(rows)]
    assert [channel["createdAt"] for channel in projected] == [
        "2026-01-02T03:04:05.123Z",
        "2026-06-01T05:30:00.000Z",
    ]


def test_project_channels_does_not_expose_extra_row_columns():
    row = channel_row("c1", bot_id="b1")
    row["secret_column"] = "s3cr3t"
    projected = public_json(models.project_channels([row])[0])
    assert set(projected) == CHANNEL_REQUIRED_FIELDS
    assert "s3cr3t" not in json.dumps(projected)


def test_project_channels_rejects_invalid_timestamps_and_missing_columns():
    with pytest.raises(ValueError, match="timezone-aware"):
        models.project_channels([channel_row("c1", created_at=datetime(2026, 1, 1))])
    for column in ("id", "name", "description", "created_at", "bot_id", "direct_bot_id"):
        row = channel_row("c1")
        del row[column]
        with pytest.raises((KeyError, ValueError, models.ValidationError)):
            models.project_channels([row])


@pytest.mark.parametrize("bot_id", [7, True, ["b1"], {"id": "b1"}, ""])
def test_project_channels_rejects_non_string_membership(bot_id):
    if bot_id == "":
        assert public_json(models.project_channels([channel_row("c1", bot_id=bot_id)])[0])["botIds"] == [""]
        return
    with pytest.raises(ValueError, match="Invalid channel membership"):
        models.project_channels([channel_row("c1", bot_id=bot_id)])


@pytest.mark.parametrize("direct_bot_id", [7, True, ["b9"], {"id": "b9"}])
def test_project_channels_rejects_non_string_direct_bot_id(direct_bot_id):
    with pytest.raises(models.ValidationError):
        models.project_channels([channel_row("c1", direct_bot_id=direct_bot_id)])


def test_project_channels_only_reads_and_never_mutates_the_rows():
    rows = [channel_row("c1", bot_id="b1"), channel_row("c1", bot_id="b2")]
    snapshot = copy.deepcopy(rows)
    models.project_channels(rows)
    assert rows == snapshot


def test_model_enum_literals_match_the_typescript_unions_exactly():
    """No invented status, profile or appearance member, and none of the TS members missing."""
    from typing import get_args

    assert list(get_args(models.Bot.model_fields["status"].annotation)) == BOT_STATUSES
    assert list(get_args(models.Bot.model_fields["computerProfile"].annotation)) == COMPUTER_PROFILES
    assert list(get_args(models.BotAppearance.model_fields["head"].annotation)) == HEAD_SHAPES
    assert list(get_args(models.BotAppearance.model_fields["body"].annotation)) == BODY_SHAPES
    assert list(get_args(models.BotAppearance.model_fields["mobility"].annotation)) == MOBILITIES
    assert list(get_args(models.BotAppearance.model_fields["accessory"].annotation)) == ACCESSORIES
    assert list(get_args(models.BotAppearance.model_fields["accent"].annotation)) == ACCENTS
    assert len(BOT_STATUSES) == 8 and len(COMPUTER_PROFILES) == 5


def test_public_models_declare_exactly_the_public_fields():
    """The frozen contracts must not grow description, configuration or revision fields."""
    assert set(models.Bot.model_fields) == BOT_PUBLIC_FIELDS
    assert set(models.Channel.model_fields) == CHANNEL_PUBLIC_FIELDS
    assert set(models.BotAppearance.model_fields) == {
        "head",
        "body",
        "mobility",
        "accessory",
        "accent",
    }
    assert set(models.BotsResponse.model_fields) == {"bots"}
    assert set(models.ChannelsResponse.model_fields) == {"channels"}
    assert set(models.Owner.model_fields) == {"id", "name"}
    assert set(models.AnonymousSession.model_fields) == {"authenticated"}
    assert set(models.AuthenticatedSession.model_fields) == {"authenticated", "owner", "expiresAt"}


# ---------------------------------------------------------------------------
# Envelopes and strict model contracts
# ---------------------------------------------------------------------------


def test_response_envelopes_serialize_only_their_list():
    bot = models.project_bot(bot_row())
    assert json.dumps(public_json(models.BotsResponse(bots=[bot])), ensure_ascii=False) == json.dumps(
        {"bots": [{**public_json(bot)}]}, ensure_ascii=False
    )
    assert public_json(models.BotsResponse(bots=[])) == {"bots": []}
    assert public_json(models.ChannelsResponse(channels=[])) == {"channels": []}


def test_response_envelopes_reject_unexpected_fields():
    with pytest.raises(models.ValidationError):
        models.BotsResponse(bots=[], total=1)
    with pytest.raises(models.ValidationError):
        models.ChannelsResponse(channels=[], revision="r1")


def test_public_models_reject_private_or_unexpected_fields():
    with pytest.raises(models.ValidationError):
        models.Bot(
            id="b",
            name="n",
            role="r",
            status="idle",
            computerProfile="none",
            createdAt="2026-01-01T00:00:00.000Z",
            description="private",
        )
    with pytest.raises(models.ValidationError):
        models.BotAppearance(**appearance(), revision=2)
    with pytest.raises(models.ValidationError):
        models.Channel(
            id="c",
            name="n",
            description="d",
            botIds=[],
            createdAt="2026-01-01T00:00:00.000Z",
            configuration={},
        )


def test_public_models_require_every_declared_field():
    with pytest.raises(models.ValidationError):
        models.Bot(id="b", name="n", role="r", status="idle", computerProfile="none")
    with pytest.raises(models.ValidationError):
        models.Channel(id="c", name="n", botIds=[], createdAt="2026-01-01T00:00:00.000Z")
    with pytest.raises(models.ValidationError):
        models.Owner(id="owner")


def test_public_models_are_strict_about_container_types():
    """strict=True means no silent tuple/str to list coercion for the public contract."""
    with pytest.raises(models.ValidationError):
        models.Channel(id="c", name="n", description="d", botIds=("b1",), createdAt="x")
    with pytest.raises(models.ValidationError):
        models.Channel(id="c", name="n", description="d", botIds="b1", createdAt="x")
    with pytest.raises(models.ValidationError):
        models.BotsResponse(bots=())


def test_owner_identity_is_pinned_to_the_owner_literal():
    assert public_json(models.Owner(id="owner", name="运维")) == {"id": "owner", "name": "运维"}
    with pytest.raises(models.ValidationError):
        models.Owner(id="admin", name="运维")


def test_anonymous_session_is_exactly_unauthenticated():
    session = TypeAdapter(models.AuthSession)
    anonymous = session.validate_python({"authenticated": False})
    assert isinstance(anonymous, models.AnonymousSession)
    payload = session.dump_python(anonymous, mode="json", exclude_none=True)
    assert payload == {"authenticated": False}


def test_authenticated_session_carries_the_owner_and_expiry_only():
    session = TypeAdapter(models.AuthSession)
    expected = {
        "authenticated": True,
        "owner": {"id": "owner", "name": "管理员"},
        "expiresAt": "2026-01-02T03:04:05.000Z",
    }
    authenticated = session.validate_python(expected)
    assert isinstance(authenticated, models.AuthenticatedSession)
    payload = session.dump_python(authenticated, mode="json", exclude_none=True)
    assert payload == expected
    assert "null" not in json.dumps(payload)


@pytest.mark.parametrize(
    "payload",
    [
        {"authenticated": True},
        {"authenticated": True, "owner": {"id": "owner", "name": "n"}},
        {"authenticated": True, "expiresAt": "2026-01-02T03:04:05.000Z"},
        {"authenticated": True, "owner": {"id": "someone", "name": "n"}, "expiresAt": "x"},
        {"authenticated": False, "owner": {"id": "owner", "name": "n"}},
        {"authenticated": False, "expiresAt": "2026-01-02T03:04:05.000Z"},
        {"authenticated": False, "token": "secret"},
        {"authenticated": "yes"},
        {"authenticated": 1},
        {"authenticated": None},
        {},
    ],
)
def test_auth_session_union_rejects_malformed_snapshots(payload):
    """The discriminated union never degrades a malformed snapshot into an anonymous success."""
    session = TypeAdapter(models.AuthSession)
    with pytest.raises(models.ValidationError):
        session.validate_python(payload)


@pytest.mark.parametrize("flag", [0, 1, 0.0, 1.0])
def test_session_literal_never_coerces_numeric_flags(flag):
    payload = {"authenticated": flag}
    if flag:
        payload.update(owner={"id": "owner", "name": "Owner"}, expiresAt="2030-01-01T00:00:00.000Z")
    with pytest.raises(models.ValidationError):
        TypeAdapter(models.AuthSession).validate_python(payload)
