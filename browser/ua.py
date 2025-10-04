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


def _rand_with_seed(seed: str) -> random.Random:
    return random.Random(seed)


def _fallback_chrome_140(port: int) -> str:
    rng = _rand_with_seed(f"ua-{port}-{time.time_ns()}")
    major = 140
    minor = rng.randint(0, 0)
    build = rng.randint(5112, 6099)
    patch = rng.randint(10, 199)
    return WINDOWS_CHROME_140_TEMPLATE.format(
        major=major, minor=minor, build=build, patch=patch
    )


def _pick_from_fake_useragent(port: int) -> str | None:
    global _FAKE_UA
    if _FAKE_UA is False:
        return None
    try:
        if _FAKE_UA is None:
            # Only Chrome, to match rnet emulation and sec-ch headers
            _FAKE_UA = FakeUserAgent(browsers=["chrome"])  # type: ignore
        mode = os.environ.get("UA_MODE", "random").lower()
        if mode == "port":
            # Deterministic per-port by seeding random before picking
            rng = _rand_with_seed(str(port))
            # FakeUserAgent does not expose seeded selection, emulate by sampling several and choose
            candidates = [getattr(_FAKE_UA, "chrome") for _ in range(5)]  # type: ignore
            return rng.choice(candidates)
        return getattr(_FAKE_UA, "chrome")  # type: ignore
    except Exception:
        _FAKE_UA = False
        return None


def _derive_meta(ua: str) -> dict:
    # Defaults
    major = 140
    platform = "Windows"
    mobile = "?0"
    try:
        if parse_ua:
            parsed = parse_ua(ua)
            major_str = (
                parsed.get("user_agent", {}).get("major")
                or parsed.get("user_agent", {}).get("family")
            )
            if isinstance(major_str, str) and major_str.isdigit():
                major = int(major_str)
            os_family = parsed.get("os", {}).get("family", "Windows")
            if "Windows" in os_family:
                platform = "Windows"
            elif os_family in ("Mac OS X", "Mac OS", "Mac OS X" ) or "Mac" in os_family:
                platform = "macOS"
            elif "Android" in os_family:
                platform = "Android"
                mobile = "?1"
            else:
                platform = "Linux"
        else:
            # Lightweight regex fallback to extract major
            m = re.search(r"Chrome/(\d{2,3})", ua)
            if m:
                major = int(m.group(1))
            if "Windows" in ua:
                platform = "Windows"
            elif "Mac OS X" in ua or "Macintosh" in ua:
                platform = "macOS"
            elif "Android" in ua:
                platform = "Android"
                mobile = "?1"
            else:
                platform = "Linux"
    except Exception:
        pass
    return {"major": major, "platform": platform, "mobile": mobile}


def generate_user_agent(port: int) -> tuple[str, dict]:
    """
    Returns a tuple of (ua_string, ua_meta) where ua_meta includes:
      - major: int (browser major version)
      - platform: str for sec-ch-ua-platform (e.g., "Windows", "macOS", "Linux", "Android")
      - mobile: str ("?0" or "?1") for sec-ch-ua-mobile
    Honors UA_MODE env ("random" or "port").
    Ensures Chrome family to align with emulation.
    """
    ua = _pick_from_fake_useragent(port)
    if not ua or "Chrome/" not in ua or "Mozilla/5.0" not in ua:
        ua = _fallback_chrome_140(port)
    meta = _derive_meta(ua)
    # If emulation is Chrome 140, gently coerce sec-ch-ua to 140 for consistency
    target_major = int(os.environ.get("UA_CHROME_MAJOR", "140"))
    meta["major"] = target_major
    # Keep Windows platform unless explicitly overridden
    if os.environ.get("UA_PLATFORM"):
        meta["platform"] = os.environ.get("UA_PLATFORM")  # type: ignore
    return ua, meta


