import os, json
from core.config import LOG_DIR


BLACKLIST_FILE = os.path.join(LOG_DIR, "blacklist.json")


def _load_blacklist() -> set[str]:
    try:
        if os.path.exists(BLACKLIST_FILE):
            with open(BLACKLIST_FILE, "r", encoding="utf-8") as f:
                arr = json.load(f)
                if isinstance(arr, list):
                    return set(str(x) for x in arr if x)
    except Exception:
        pass
    return set()


def save_blacklist(domains: set[str]) -> None:
    try:
        tmp = BLACKLIST_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sorted(list(domains)), f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, BLACKLIST_FILE)
    except Exception:
        pass


BLACKLIST_DOMAINS: set[str] = _load_blacklist()


