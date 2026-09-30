"""ECMAScript text primitives; stdlib-only for the subprocess supervision seam."""

# String.prototype.trim includes BOM but excludes U+0085, U+180E and U+200B.
ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def utf16_unit_count(text: str) -> int:
    """Count UTF-16 units, preserving strict rejection of surrogate code points."""
    return len(text.encode("utf-16-le")) // 2


def utf16_unit_count_surrogatepass(text: str) -> int:
    """Count UTF-16 units including lone surrogates, as JS string length does."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2
