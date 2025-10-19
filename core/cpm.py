import os, json
import asyncio
import urllib.request as _urlreq
import urllib.error as _urlerr
from core.config import LOG_DIR, date_iso, yesterday_iso


def _cpm_path(date_iso_str: str) -> str:
    return os.path.join(LOG_DIR, f"cpm_{date_iso_str}.json")


def _dump_json(path: str, obj: object) -> None:
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        pass


COUNTRIES = [
    "Australia", "Canada", "Czechia", "Denmark", "Finland",
    "France", "Germany", "Italy", "Norway",
    "Spain", "Sweden", "Switzerland", "UnitedKingdom",
]

NAME_TO_CC = {
    "Australia":"AU", "Canada":"CA", "Czechia":"CZ", "Denmark":"DK", "Finland":"FI", "France":"FR", "Germany":"DE",
    "Italy":"IT", "Norway":"NO", "Spain":"ES", "Sweden":"SE", "Switzerland":"CH", "UnitedKingdom":"GB",
}

CC_TO_NAME = {v: k for k, v in NAME_TO_CC.items()}

_UNIFORM_WEIGHT = 1.0 / max(1, len(COUNTRIES))
COUNTRY_WEIGHTS: list[float] = [_UNIFORM_WEIGHT for _ in COUNTRIES]
CURRENT_TOP_COUNTRY: str | None = None


def set_uniform_weights() -> None:
    w = 1.0 / max(1, len(COUNTRIES))
    for i in range(len(COUNTRY_WEIGHTS)):
        COUNTRY_WEIGHTS[i] = w


def apply_cpm_weights_from_report(rep: dict, logger) -> bool:
    try:
        rows = rep.get("report")
        if not isinstance(rows, list) or not rows:
            return False
        valid = []
        for it in rows:
            cc = str(it.get("cc") or "").upper()
            rate_str = it.get("rate")
            try:
                rate = float(rate_str)
            except Exception:
                continue
            name = CC_TO_NAME.get(cc)
            if name in COUNTRIES:
                valid.append((name, rate))
        if not valid:
            return False
        valid.sort(key=lambda x: (-x[1], x[0]))
        top_name, top_rate = valid[0][0], valid[0][1]
        try:
            global CURRENT_TOP_COUNTRY
            if CURRENT_TOP_COUNTRY != top_name:
                CURRENT_TOP_COUNTRY = top_name
                cc = NAME_TO_CC.get(top_name, "")
                logger(lambda: f"[CPM] Top country set: {top_name} ({cc}) rate={top_rate}")
        except Exception:
            pass
        n = len(COUNTRIES)
        if n <= 1:
            COUNTRY_WEIGHTS[:] = [1.0]
            return True
        k = min(3, len(valid))
        top_k = valid[:k]
        top_k_names = {name for name, _ in top_k}
        top_share = 0.95
        other_share = 1.0 - top_share
        per_top = top_share / float(k)
        others_count = max(0, n - k)
        per_other = (other_share / float(others_count)) if others_count > 0 else 0.0
        try:
            desc = []
            for name, rate in top_k:
                cc = NAME_TO_CC.get(name, "")
                desc.append(f"{name} ({cc}) rate={rate}")
            logger(lambda: f"[CPM] Top {k}: "+ ", ".join(desc) + f"; per_top={per_top:.4f} per_other={per_other:.4f}")
        except Exception:
            pass
        for i, name in enumerate(COUNTRIES):
            COUNTRY_WEIGHTS[i] = per_top if name in top_k_names else per_other
        return True
    except Exception:
        return False


def fetch_cpm_sync(for_date_iso: str, logger) -> tuple[dict | None, str | None]:
    url = "https://members.popcash.net/api/reports/publisher"
    website_id = os.environ.get("POPCASH_WEBSITE") or os.environ.get("POPCASH_WEBSITE_ID")
    csrf = os.environ.get("POPCASH_CSRF")
    cookie = os.environ.get("POPCASH_COOKIE")
    if not website_id or not csrf or not cookie:
        try:
            missing = []
            if not website_id:
                missing.append("POPCASH_WEBSITE")
            if not csrf:
                missing.append("POPCASH_CSRF")
            if not cookie:
                missing.append("POPCASH_COOKIE")
            logger(lambda: f"[CPM] Missing env: {', '.join(missing)}")
        except Exception:
            pass
        return None, json.dumps({"error":"missing_env","missing":{
            "POPCASH_WEBSITE": bool(website_id),
            "POPCASH_CSRF": bool(csrf),
            "POPCASH_COOKIE": bool(cookie),
        }})
    try:
        body = json.dumps({
            "startDate": for_date_iso,
            "endDate": for_date_iso,
            "reportType": "1",
            "website": int(website_id),
            "csrf": csrf,
        }).encode("utf-8")
    except Exception:
        return None, None
    req = _urlreq.Request(url, data=body, method="POST")
    req.add_header("accept", "application/json, text/plain, */*")
    req.add_header("content-type", "application/json")
    req.add_header("accept-language", "en-US,en;q=0.9")
    req.add_header("cache-control", "no-cache")
    req.add_header("pragma", "no-cache")
    req.add_header("origin", "https://members.popcash.net")
    req.add_header("referer", "https://members.popcash.net/reports/publisher")
    req.add_header("x-requested-with", "XMLHttpRequest")
    ua = os.environ.get("POPCASH_UA") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    req.add_header("user-agent", ua)
    req.add_header("cookie", cookie)
    try:
        with _urlreq.urlopen(req, timeout=45) as resp:
            raw = resp.read()
            try:
                code = resp.getcode()
                logger(lambda: f"[CPM] HTTP {code} len={len(raw)}")
            except Exception:
                pass
    except _urlerr.HTTPError as e:
        try:
            raw_err = e.read()
        except Exception:
            raw_err = None
        logger(lambda: f"[CPM] HTTPError {getattr(e, 'code', '?')} during fetch")
        return None, (raw_err.decode("utf-8", errors="ignore") if raw_err else None)
    except (_urlerr.URLError, TimeoutError, Exception):
        return None, None
    try:
        return json.loads(raw.decode("utf-8", errors="ignore")), raw.decode("utf-8", errors="ignore")
    except Exception:
        return None, raw.decode("utf-8", errors="ignore")


async def cpm_fetch_and_update(initial: bool, logger) -> tuple[list[float], str | None]:
    today = date_iso()
    logger(lambda: f"[CPM] Fetching report for {today}")
    rep, raw = await asyncio.to_thread(fetch_cpm_sync, today, logger)
    try:
        if raw is not None:
            try:
                _dump_json(_cpm_path(today), json.loads(raw))
            except Exception:
                _dump_json(_cpm_path(today), {"_raw": raw})
        else:
            _dump_json(_cpm_path(today), {"error":"no_response"})
    except Exception:
        pass
    if not rep or not apply_cpm_weights_from_report(rep, logger):
        if initial:
            y = yesterday_iso()
            logger(lambda: f"[CPM] No data for {today}; trying fallback {y}")
            rep_y, raw_y = await asyncio.to_thread(fetch_cpm_sync, y, logger)
            try:
                if raw_y is not None:
                    try:
                        _dump_json(_cpm_path(y), json.loads(raw_y))
                    except Exception:
                        _dump_json(_cpm_path(y), {"_raw": raw_y})
                else:
                    _dump_json(_cpm_path(y), {"error":"no_response"})
            except Exception:
                pass
            if rep_y and apply_cpm_weights_from_report(rep_y, logger):
                logger(lambda: f"[CPM] Fallback successful; weights applied")
                return COUNTRY_WEIGHTS[:], CURRENT_TOP_COUNTRY
        set_uniform_weights()
        logger("[CPM] Using uniform country weights")
        return COUNTRY_WEIGHTS[:], CURRENT_TOP_COUNTRY
    return COUNTRY_WEIGHTS[:], CURRENT_TOP_COUNTRY


async def cpm_fetcher(logger) -> None:
    while True:
        try:
            await asyncio.sleep(3600)
            logger(lambda: f"[CPM] Hourly refresh for {date_iso()}")
            await cpm_fetch_and_update(initial=False, logger=logger)
        except Exception:
            await asyncio.sleep(3600)


