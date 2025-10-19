import os, re, time, random

try:
    # Preferred: widely used UA generator with large catalog
    from fake_useragent import FakeUserAgent  # type: ignore
    _FAKE_UA = None  # lazy init
except Exception:
    _FAKE_UA = False  # unavailable

try:
    from ua_parser.user_agent_parser import Parse as parse_ua  # type: ignore
except Exception:
    parse_ua = None


WINDOWS_CHROME_140_TEMPLATE = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/{major}.{minor}.{build}.{patch} Safari/537.36"
)

# Static Android UA template for hardcoded Android traffic
ANDROID_CHROME_140_TEMPLATE = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/{major}.0.0.0 Mobile Safari/537.36"
)


def _rand_with_seed(seed: str) -> random.Random:
    return random.Random(seed)


def _fallback_chrome_140(port: int) -> str:
    # Hardcode Android Chrome 140 UA; no env or randomness needed
    major = 140
    return ANDROID_CHROME_140_TEMPLATE.format(major=major)


def _pick_from_fake_useragent(port: int) -> str | None:
    # Disabled: we hardcode Android UA
    return None


def _derive_meta(ua: str) -> dict:
    # Hardcode Android meta matching UA
    return {"major": 140, "platform": "Android", "mobile": "?1"}


def generate_user_agent(port: int) -> tuple[str, dict]:
    # Always Android Chrome 140
    ua = _fallback_chrome_140(port)
    meta = _derive_meta(ua)
    return ua, meta


