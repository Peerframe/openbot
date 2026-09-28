"""Regression for shared ECMAScript whitespace and UTF-16 unit counting."""
import subprocess
import sys
from pathlib import Path

import pytest

from openbot_server.text_compat import (
    ECMASCRIPT_WHITESPACE,
    utf16_unit_count,
    utf16_unit_count_surrogatepass,
)

# Exact String.prototype.trim set (25 characters).
_TRIM_CHARS = (
    "\u0009",
    "\u000a",
    "\u000b",
    "\u000c",
    "\u000d",
    "\u0020",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u2001",
    "\u2002",
    "\u2003",
    "\u2004",
    "\u2005",
    "\u2006",
    "\u2007",
    "\u2008",
    "\u2009",
    "\u200a",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
)

# Present in Unicode / Python strip lore but NOT ECMAScript trim.
_EXCLUDED = ("\u0085", "\u180e", "\u200b")


def test_ecmascript_whitespace_is_exactly_the_twenty_five_trim_characters():
    assert len(_TRIM_CHARS) == 25
    assert len(set(_TRIM_CHARS)) == 25
    assert ECMASCRIPT_WHITESPACE == "".join(_TRIM_CHARS)
    for character in _TRIM_CHARS:
        assert character in ECMASCRIPT_WHITESPACE, f"U+{ord(character):04X}"
        assert f"{character}x{character}".strip(ECMASCRIPT_WHITESPACE) == "x"
    for character in _EXCLUDED:
        assert character not in ECMASCRIPT_WHITESPACE, f"U+{ord(character):04X}"
        assert f"{character}x{character}".strip(ECMASCRIPT_WHITESPACE) == f"{character}x{character}"


def test_utf16_unit_count_bmp_and_astral():
    assert utf16_unit_count("") == 0
    assert utf16_unit_count("a") == 1
    assert utf16_unit_count("中") == 1
    assert utf16_unit_count("\U0001f600") == 2
    assert utf16_unit_count("a\U0001f600b") == 4
    assert utf16_unit_count_surrogatepass("\U0001f600") == 2


def test_utf16_unit_count_rejects_lone_and_paired_surrogates_strict():
    high = "\ud800"
    low = "\udc00"
    paired = "\ud800\udc00"
    for sample in (high, low, paired):
        with pytest.raises(UnicodeEncodeError):
            utf16_unit_count(sample)


def test_utf16_unit_count_surrogatepass_counts_lone_and_paired_surrogates():
    assert utf16_unit_count_surrogatepass("\ud800") == 1
    assert utf16_unit_count_surrogatepass("\udc00") == 1
    assert utf16_unit_count_surrogatepass("\ud800\udc00") == 2
    assert utf16_unit_count_surrogatepass("a\ud800b") == 3


def test_non_string_keeps_original_errors():
    for bad in (None, 1, b"a", ["a"]):
        with pytest.raises(AttributeError):
            utf16_unit_count(bad)  # type: ignore[arg-type]
        with pytest.raises(AttributeError):
            utf16_unit_count_surrogatepass(bad)  # type: ignore[arg-type]


def test_python_dash_S_imports_text_compat_and_runtime_process_without_pydantic():
    """``python -S`` must load these without site-packages (no Pydantic contagion)."""
    root = Path(__file__).resolve().parents[1] / "src"
    program = (
        "import sys;"
        f"sys.path.insert(0, {str(root)!r});"
        "import openbot_server.text_compat;"
        "import openbot_server.runtime_process;"
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-S", "-c", program],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
