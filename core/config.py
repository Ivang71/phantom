import os, time


def env_flag(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
LOG_DIR = os.path.join(ROOT_DIR, "logs")
try:
    os.makedirs(LOG_DIR, exist_ok=True)
except Exception:
    pass


def date_iso(ts: float | None = None) -> str:
    t = time.localtime(ts or time.time())
    return f"{t.tm_year:04d}-{t.tm_mon:02d}-{t.tm_mday:02d}"


def yesterday_iso() -> str:
    return date_iso((time.time() - 86400))


def _int(name: str, default: int | None = None) -> int:
    if default is None:
        v = os.environ.get(name)
    else:
        v = os.environ.get(name, str(default))
    return int(v)


LOG_HEADERS = env_flag('LOG_HEADERS', False)
LOG_COOKIES = env_flag('LOG_COOKIES', False)
DWELL_PRE_MS = _int('DWELL_PRE_MS', 0)
DWELL_POST_MS = _int('DWELL_POST_MS', 0)
NUMBER_OF_WORKERS = _int('NUMBER_OF_WORKERS')
_cores = (os.cpu_count() or 4)
_auto_threads = min(4096, max(_cores * 8, NUMBER_OF_WORKERS * 8))
MAX_THREADS = int(os.environ.get('MAX_THREADS') or _auto_threads)
STAGGER_START_MS = _int('STAGGER_START_MS', 15000)
VERBOSE = env_flag('VERBOSE', False)
SILENT = env_flag('SILENT', False)
HTTP_TIMEOUT = _int('HTTP_TIMEOUT', 60)


