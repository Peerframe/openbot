"""Independent regression tests for the compatible Bot/channel creation inputs.

These cases pin the *observable* contract of the installed Zod 4.6.2 schemas
(``createBotInputSchema`` / ``createChannelInputSchema`` in ``packages/protocol/src/index.ts``) as
reproduced by ``openbot_server.identity_inputs``. Expected payloads are written out explicitly so the
suite is meaningful offline; the differential runner
(``scripts/compare-identity-inputs.mjs``) is what re-derives the truth from TypeScript, against the
81-case fixture.

The suite is deliberately lean: a homogeneous sweep is one case per *property* with a labelled loop,
not one collected case per item, because the differential runner already proves each individual input
against the oracle. Every input asserted before is still asserted here.

These cases claim nothing about routes, authorization, SQL or the write transaction, and they leave
the strict public OUTPUT models in ``openbot_server.models`` untouched.
"""
import json
import pathlib
from typing import get_args

import pytest
from pydantic import ValidationError

from openbot_server import identity_inputs, models

BOT_ID = "1f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
OTHER_BOT_ID = "2f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
NIL_ID = "00000000-0000-0000-0000-000000000000"
MAX_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

APPEARANCE = {"head": "round", "body": "cape", "mobility": "hover", "accessory": "backpack", "accent": "red"}

# Enum members copied verbatim from packages/protocol/src/index.ts and packages/domain.
PROFILE_UNION = ["none", "model", "docker-linux", "macos-cua", "lume-vm", "coder"]
APPEARANCE_UNIONS = {
    "head": ["round", "square", "cat"],
    "body": ["classic", "tall", "cape", "armor", "storage", "quadruped"],
    "mobility": ["feet", "single-wheel", "dual-wheel", "hover", "four-legs"],
    "accessory": ["none", "headphones", "backpack", "trench", "arm", "toolbox"],
    "accent": ["green", "yellow", "red", "blue"],
}

# ECMAScript String.prototype.trim removes exactly these; Python's str.strip() does not agree.
JS_TRIMMED = ["\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u0020", "\u00a0", "\u1680",
              "\u2000", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]
JS_KEPT = ["\u0000", "\u001c", "\u001d", "\u001e", "\u001f", "\u0085", "\u00ad", "\u200b", "\u2060"]


def bot(value):
    return identity_inputs.parse_bot_create(value).model_dump(mode="json", exclude_none=True)


def channel(value):
    return identity_inputs.parse_channel_create(value).model_dump(mode="json", exclude_none=True)


def rejects(parser, value, label=""):
    """Assert a rejection, naming the input that was wrongly accepted."""
    try:
        parser(value)
    except ValidationError:
        return
    raise AssertionError(f"expected a rejection for {label or value!r}")


def code_point_label(value):
    return f"{len(value)} code points, {len(value.encode('utf-16-le')) // 2} UTF-16 units"


# ---------------------------------------------------------------------------
# Payload shape: defaults, omission and unknown keys
# ---------------------------------------------------------------------------


def test_the_minimal_payloads_are_exactly_the_declared_defaults():
    assert bot({"name": "a", "role": "b"}) == {"name": "a", "role": "b", "computerProfile": "none"}
    assert channel({"name": "c"}) == {"name": "c", "description": "", "botIds": []}
    assert "null" not in json.dumps(channel({"name": "c"}))


def test_unknown_keys_are_stripped_not_rejected_unlike_the_output_model():
    payload = bot({"name": "a", "role": "b", "extra": 1, "description": "private", "revision": 2, "status": "idle"})
    assert payload == {"name": "a", "role": "b", "computerProfile": "none"}
    assert channel({"name": "c", "extra": True, "directBotId": "x"}) == {"name": "c", "description": "", "botIds": []}
    stripped = bot({"name": "a", "role": "b", "appearance": {**APPEARANCE, "extra": 1, "prompt": "private"}})
    assert stripped["appearance"] == APPEARANCE
    assert json.dumps(stripped).count("extra") == 0


def test_explicit_null_is_a_type_error_wherever_a_default_or_an_omission_exists():
    """Only an absent key takes a default; null into any optional slot is a type error."""
    for value in ({"name": "a", "role": "b", "appearance": None},
                  {"name": "a", "role": "b", "computerProfile": None},
                  {"name": None, "role": "b"},
                  {"name": "a", "role": None}):
        rejects(identity_inputs.parse_bot_create, value, f"bot {value}")
    for value in ({"name": "c", "description": None}, {"name": "c", "botIds": None}, {"name": None}):
        rejects(identity_inputs.parse_channel_create, value, f"channel {value}")


def test_missing_required_fields_are_rejected():
    for value in ({"role": "b"}, {"name": "a"}, {}):
        rejects(identity_inputs.parse_bot_create, value, f"bot {value}")
    rejects(identity_inputs.parse_channel_create, {})
    rejects(identity_inputs.parse_channel_create, {"description": "d"}, "channel without a name")


def test_the_serialized_payload_keeps_the_api_key_names_and_order():
    payload = bot({"name": "a", "role": "b", "appearance": APPEARANCE})
    assert set(payload) == {"name", "role", "computerProfile", "appearance"}
    assert list(payload["appearance"]) == ["head", "body", "mobility", "accessory", "accent"]


# ---------------------------------------------------------------------------
# Types: real strings, real objects, no coercion
# ---------------------------------------------------------------------------


def test_values_of_the_wrong_type_are_rejected_without_coercion():
    for value in (1, 1.5, True, False, ["a"], {"name": "a"}, b"a"):
        rejects(identity_inputs.parse_bot_create, {"name": value, "role": "b"}, f"bot name {value!r}")
        rejects(identity_inputs.parse_channel_create, {"name": value}, f"channel name {value!r}")
    for value in (1, True, ["b"], {"role": "b"}):
        rejects(identity_inputs.parse_bot_create, {"name": "a", "role": value}, f"bot role {value!r}")
        rejects(identity_inputs.parse_channel_create, {"name": "c", "description": value}, f"description {value!r}")
    for value in ("abc", 5, {"0": BOT_ID}, [1]):
        rejects(identity_inputs.parse_channel_create, {"name": "c", "botIds": value}, f"botIds {value!r}")


def test_non_object_input_is_rejected():
    for value in ("nope", 5, None, [1, 2], {}):
        rejects(identity_inputs.parse_bot_create, value, f"bot {value!r}")
        rejects(identity_inputs.parse_channel_create, value, f"channel {value!r}")


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


def test_every_enum_member_of_the_typescript_unions_is_accepted_verbatim():
    for profile in PROFILE_UNION:
        parsed = bot({"name": "a", "role": "b", "computerProfile": profile})["computerProfile"]
        assert parsed == profile, profile
    for field, members in APPEARANCE_UNIONS.items():
        for member in members:
            expected = {**APPEARANCE, field: member}
            assert bot({"name": "a", "role": "b", "appearance": expected})["appearance"] == expected, expected


def test_unknown_enum_members_are_rejected():
    for profile in ("windows", "docker", "MACOS-CUA", "none ", "", "Linux"):
        rejects(identity_inputs.parse_bot_create, {"name": "a", "role": "b", "computerProfile": profile}, profile)
    for field in APPEARANCE_UNIONS:
        value = {"name": "a", "role": "b", "appearance": {**APPEARANCE, field: "bogus"}}
        rejects(identity_inputs.parse_bot_create, value, f"{field}=bogus")


def test_appearance_must_be_a_complete_object():
    for missing in APPEARANCE_UNIONS:
        partial = {key: value for key, value in APPEARANCE.items() if key != missing}
        rejects(identity_inputs.parse_bot_create, {"name": "a", "role": "b", "appearance": partial}, f"no {missing}")
    for value in ([], [APPEARANCE], "round", 5, {}):
        rejects(identity_inputs.parse_bot_create, {"name": "a", "role": "b", "appearance": value}, repr(value))


def test_input_enums_are_reused_by_reference_from_the_published_output_contract():
    assert list(get_args(identity_inputs.ComputerProfile)) == PROFILE_UNION
    assert list(get_args(models.Bot.model_fields["computerProfile"].annotation)) == PROFILE_UNION
    for field, members in APPEARANCE_UNIONS.items():
        assert list(get_args(identity_inputs.CreateBotAppearance.model_fields[field].annotation)) == members, field
        assert list(get_args(models.BotAppearance.model_fields[field].annotation)) == members, field
    assert set(identity_inputs.CreateBotAppearance.model_fields) == set(APPEARANCE_UNIONS)


def test_the_strict_output_model_is_not_weakened():
    """The input contract strips unknown keys; the published output model must still forbid them."""
    assert models.BotAppearance.model_config["extra"] == "forbid"
    assert models.Bot.model_config["extra"] == "forbid"
    with pytest.raises(ValidationError):
        models.BotAppearance(**APPEARANCE, extra=1)
    rejects(identity_inputs.parse_bot_create, {"name": "a", "role": "b", "appearance": {**APPEARANCE, "accent": None}})


# ---------------------------------------------------------------------------
# ECMAScript trimming
# ---------------------------------------------------------------------------


def test_the_trim_set_is_exactly_the_characters_ecmascript_removes():
    for character in JS_TRIMMED:
        label = f"U+{ord(character):04X}"
        assert bot({"name": f"{character}x{character}", "role": "b"})["name"] == "x", label
        assert channel({"name": "c", "description": f"{character}x{character}"})["description"] == "x", label


def test_characters_ecmascript_keeps_survive_the_trim():
    """Python's str.strip() would remove several of these; the schema keeps them."""
    for character in JS_KEPT:
        label = f"U+{ord(character):04X}"
        assert bot({"name": f"{character}x{character}", "role": "b"})["name"] == f"{character}x{character}", label
        assert channel({"name": character})["name"] == character, label


def test_a_name_that_trims_to_nothing_is_rejected_but_a_kept_separator_is_a_name():
    rejects(identity_inputs.parse_bot_create, {"name": "\ufeff", "role": "b"}, "BOM only")
    rejects(identity_inputs.parse_bot_create, {"name": "\ufeff\ufeff", "role": "b"}, "two BOMs")
    assert bot({"name": "\u001c", "role": "b"})["name"] == "\u001c"
    assert bot({"name": "\u001c\u001c", "role": "b"})["name"] == "\u001c\u001c"


def test_inner_whitespace_is_preserved():
    assert bot({"name": "  a  b  ", "role": "b"})["name"] == "a  b"
    assert channel({"name": "c", "description": "  keep  inner  "})["description"] == "keep  inner"
    assert channel({"name": "c", "description": "\u00a0x\u00a0"})["description"] == "x"


def test_the_required_messages_are_the_ones_the_typescript_schema_declares():
    for parser, value, message in (
        (identity_inputs.parse_bot_create, {"name": "   ", "role": "b"}, "Bot name is required."),
        (identity_inputs.parse_bot_create, {"name": "a", "role": "   "}, "Bot role is required."),
        (identity_inputs.parse_channel_create, {"name": "   "}, "Channel name is required."),
    ):
        with pytest.raises(ValidationError) as raised:
            parser(value)
        assert message in str(raised.value), message


# ---------------------------------------------------------------------------
# Length bounds are counted in code points, as the installed Zod does
# ---------------------------------------------------------------------------


def test_length_is_measured_in_unicode_code_points_not_utf16_units():
    """33 astral emoji are 66 UTF-16 units and are accepted; the task card's wording was wrong."""
    for name, accepted in (
        ("a" * 64, True),
        ("a" * 65, False),
        ("\U0001f600" * 32, True),
        ("\U0001f600" * 33, True),
        ("\U0001f600" * 64, True),
        ("\U0001f600" * 65, False),
        ("\U0001f600" * 63 + "a", True),
        ("\U0001f600" * 60 + "abcd", True),
        ("\u2764\ufe0f" * 32, True),
        ("\u2764\ufe0f" * 33, False),
    ):
        if accepted:
            assert bot({"name": name, "role": "b"})["name"] == name, code_point_label(name)
        else:
            rejects(identity_inputs.parse_bot_create, {"name": name, "role": "b"}, code_point_label(name))


def test_the_bounds_apply_to_the_trimmed_value():
    assert bot({"name": f"  {'a' * 64}  ", "role": "b"})["name"] == "a" * 64
    rejects(identity_inputs.parse_bot_create, {"name": f"  {'a' * 65}  ", "role": "b"}, "65 after trimming")


def test_the_remaining_field_bounds():
    assert len(bot({"name": "a", "role": "r" * 160})["role"]) == 160
    rejects(identity_inputs.parse_bot_create, {"name": "a", "role": "r" * 161}, "role of 161")
    assert len(channel({"name": "n" * 80})["name"]) == 80
    rejects(identity_inputs.parse_channel_create, {"name": "n" * 81}, "channel name of 81")
    assert len(channel({"name": "c", "description": "d" * 500})["description"]) == 500
    rejects(identity_inputs.parse_channel_create, {"name": "c", "description": "d" * 501}, "description of 501")
    assert channel({"name": "c", "description": "   "})["description"] == ""


# ---------------------------------------------------------------------------
# botIds: UUID pattern, cap before de-duplication, order-preserving de-duplication
# ---------------------------------------------------------------------------


def test_accepted_uuid_forms_keep_their_spelling():
    for value in (BOT_ID, BOT_ID.upper(), NIL_ID, MAX_ID, "1f8b0f1e-5e3d-1f8a-9c2b-7d6e5f4a3b2c"):
        assert channel({"name": "c", "botIds": [value]})["botIds"] == [value], value


def test_rejected_uuid_forms():
    for value in (
        "1f8b0f1e-5e3d-4f8a-0c2b-7d6e5f4a3b2c",  # variant 0
        "1f8b0f1e-5e3d-0f8a-9c2b-7d6e5f4a3b2c",  # version 0
        "1f8b0f1e-5e3d-9f8a-9c2b-7d6e5f4a3b2c",  # version 9
        "00000000-0000-0000-0000-00000000000a",  # guid shape, and not the nil literal
        "1f8b0f1e5e3d4f8a9c2b7d6e5f4a3b2c",      # no hyphens
        "{" + BOT_ID + "}",
        "urn:uuid:" + BOT_ID,
        " " + BOT_ID + " ",
        BOT_ID + "\n",
        BOT_ID + "x",
        BOT_ID[:-1],
        BOT_ID.replace("-", "_"),
    ):
        rejects(identity_inputs.parse_channel_create, {"name": "c", "botIds": [value]}, value)


def test_bot_ids_are_de_duplicated_case_sensitively_in_first_occurrence_order():
    repeated = channel({"name": "c", "botIds": [OTHER_BOT_ID, BOT_ID, OTHER_BOT_ID, BOT_ID]})["botIds"]
    assert repeated == [OTHER_BOT_ID, BOT_ID]
    assert channel({"name": "c", "botIds": [BOT_ID, BOT_ID.upper()]})["botIds"] == [BOT_ID, BOT_ID.upper()]
    assert channel({"name": "c", "botIds": [NIL_ID, NIL_ID]})["botIds"] == [NIL_ID]
    assert channel({"name": "c", "botIds": []})["botIds"] == []


def test_the_32_entry_cap_applies_to_the_input_before_de_duplication():
    assert channel({"name": "c", "botIds": [BOT_ID] * 32})["botIds"] == [BOT_ID]
    rejects(identity_inputs.parse_channel_create, {"name": "c", "botIds": [BOT_ID] * 33}, "33 identical entries")
    distinct = [f"{index:08x}-5e3d-4f8a-9c2b-7d6e5f4a3b2c" for index in range(33)]
    rejects(identity_inputs.parse_channel_create, {"name": "c", "botIds": distinct}, "33 distinct entries")
    assert len(channel({"name": "c", "botIds": distinct[:32]})["botIds"]) == 32


# ---------------------------------------------------------------------------
# Isolation from shared state, and the untouched output model
# ---------------------------------------------------------------------------


def test_default_lists_and_parsed_lists_are_never_shared_or_aliased():
    first = identity_inputs.parse_channel_create({"name": "c"})
    first.botIds.append(BOT_ID)
    assert identity_inputs.parse_channel_create({"name": "c"}).botIds == []
    assert first.botIds == [BOT_ID]

    source = {"name": "c", "botIds": [BOT_ID]}
    parsed = identity_inputs.parse_channel_create(source)
    parsed.botIds.append(OTHER_BOT_ID)
    parsed.name = "renamed"
    assert source == {"name": "c", "botIds": [BOT_ID]}


def test_an_accepted_appearance_round_trips_through_the_strict_output_model():
    """What this module accepts must survive the published output model unchanged, or a write would
    be readable as a different record than it was created with."""
    parsed = identity_inputs.parse_bot_create({"name": "a", "role": "b", "appearance": APPEARANCE})
    stored = parsed.appearance.model_dump(mode="json")
    assert stored == APPEARANCE
    assert models.BotAppearance.model_validate(stored).model_dump(mode="json") == APPEARANCE


# ---------------------------------------------------------------------------
# The published request schema (routes bind these models to OpenAPI)
# ---------------------------------------------------------------------------


def test_the_generated_request_schema_matches_the_route_openapi_contract():
    bot_schema = identity_inputs.CreateBotInput.model_json_schema()
    channel_schema = identity_inputs.CreateChannelInput.model_json_schema()
    assert bot_schema["required"] == ["name", "role"]
    assert channel_schema["required"] == ["name"]
    assert bot_schema["properties"]["computerProfile"]["enum"] == PROFILE_UNION
    assert bot_schema["$defs"]["CreateBotAppearance"]["required"] == ["head", "body", "mobility", "accessory", "accent"]
    # De-duplication is a Zod .transform, not an input constraint, so the published schema must not
    # claim uniqueItems: an input with duplicates is valid.
    assert "uniqueItems" not in channel_schema["properties"]["botIds"]


def test_the_request_schema_carries_the_bounds_an_aftervalidator_cannot_emit():
    """AfterValidator contributes no schema at all, so without these keywords the published request
    bodies would describe unbounded strings, an uncapped array and no UUID pattern."""
    bot_properties = identity_inputs.CreateBotInput.model_json_schema()["properties"]
    channel_properties = identity_inputs.CreateChannelInput.model_json_schema()["properties"]
    assert (bot_properties["name"]["minLength"], bot_properties["name"]["maxLength"]) == (1, 64)
    assert (bot_properties["role"]["minLength"], bot_properties["role"]["maxLength"]) == (1, 160)
    assert (channel_properties["name"]["minLength"], channel_properties["name"]["maxLength"]) == (1, 80)
    assert channel_properties["description"]["maxLength"] == 500
    assert "minLength" not in channel_properties["description"], "a description may trim down to empty"
    assert channel_properties["botIds"]["maxItems"] == 32
    assert channel_properties["botIds"]["items"]["pattern"] == identity_inputs._UUID_PATTERN_TEXT
    assert "format" not in channel_properties["botIds"]["items"], (
        "format: uuid denotes the whole UUID family; the enforced set is narrower, so pattern is the only claim"
    )


def test_every_emitted_bound_is_the_bound_the_validator_enforces():
    """The keywords are annotations, not enforcement, so hold them against the real boundary."""
    bot_properties = identity_inputs.CreateBotInput.model_json_schema()["properties"]
    channel_properties = identity_inputs.CreateChannelInput.model_json_schema()["properties"]

    for field, build in (("name", lambda text: {"name": text, "role": "b"}),
                         ("role", lambda text: {"name": "a", "role": text})):
        maximum = bot_properties[field]["maxLength"]
        assert bot(build("a" * maximum))[field] == "a" * maximum, field
        rejects(identity_inputs.parse_bot_create, build("a" * (maximum + 1)), f"{field} above its maxLength")

    for field, build in (("name", lambda text: {"name": text}),
                         ("description", lambda text: {"name": "c", "description": text})):
        maximum = channel_properties[field]["maxLength"]
        assert channel(build("a" * maximum))[field] == "a" * maximum, field
        rejects(identity_inputs.parse_channel_create, build("a" * (maximum + 1)), f"{field} above its maxLength")

    cap = channel_properties["botIds"]["maxItems"]
    assert channel({"name": "c", "botIds": [BOT_ID] * cap})["botIds"] == [BOT_ID]
    rejects(identity_inputs.parse_channel_create, {"name": "c", "botIds": [BOT_ID] * (cap + 1)}, "above its maxItems")

    for minimum, value, parser in (
        (bot_properties["name"]["minLength"], {"name": "\ufeff", "role": "b"}, identity_inputs.parse_bot_create),
        (bot_properties["role"]["minLength"], {"name": "a", "role": "\ufeff"}, identity_inputs.parse_bot_create),
        (channel_properties["name"]["minLength"], {"name": "\ufeff"}, identity_inputs.parse_channel_create),
    ):
        assert minimum == 1
        rejects(parser, value, "a value that trims to nothing")

    # One text is both the emitted keyword and the compiled validator, so they cannot disagree.
    assert identity_inputs._UUID_PATTERN.pattern == identity_inputs._UUID_PATTERN_TEXT


# ---------------------------------------------------------------------------
# The differential fixture (inputs and labels only)
# ---------------------------------------------------------------------------


def test_the_differential_fixture_carries_labeled_inputs_and_no_expected_outputs():
    fixture_path = pathlib.Path(__file__).resolve().parent / "fixtures" / "identity-inputs.json"
    document = json.loads(fixture_path.read_text(encoding="utf-8"))
    cases = document["cases"]
    identifiers = [case["id"] for case in cases]
    assert len(identifiers) == len(set(identifiers))
    assert {case["schema"] for case in cases} == {"bot", "channel"}
    assert all(set(case) == {"id", "schema", "input"} for case in cases)
    parsers = {"bot": identity_inputs.parse_bot_create, "channel": identity_inputs.parse_channel_create}
    for case in cases:
        try:
            parsers[case["schema"]](case["input"])
        except ValidationError:
            pass


def test_optional_appearance_schema_does_not_advertise_rejected_null():
    schema = identity_inputs.CreateBotInput.model_json_schema()
    appearance = schema["properties"]["appearance"]
    assert "appearance" not in schema["required"]
    assert appearance.get("$ref") == "#/$defs/CreateBotAppearance"
    assert "anyOf" not in appearance and "default" not in appearance
    assert identity_inputs.parse_bot_create({"name": "x", "role": "y"}).appearance is None
    with pytest.raises(ValidationError):
        identity_inputs.parse_bot_create({"name": "x", "role": "y", "appearance": None})
