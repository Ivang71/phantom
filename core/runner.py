import os, time, json, asyncio, contextlib
import concurrent.futures as _futures
from urllib.parse import urlparse
from core.config import LOG_DIR, NUMBER_OF_WORKERS, VERBOSE, SILENT, MAX_THREADS
from core.blacklist import BLACKLIST_DOMAINS, save_blacklist
from core.engine import run_cycle


def _p(msg):
    if SILENT:
        return
    try:
        out = msg() if callable(msg) else msg
        if not isinstance(out, str):
            out = str(out)
    except Exception:
        return
    print(out)


def parse_sites() -> list[dict]:
    s = os.environ.get("TARGETS")
    if s:
        try:
            arr = json.loads(s)
            res = []
            for it in arr:
                t = (it.get("TARGET_URL") or it.get("target") or it.get("url") or "").strip()
                uid = (it.get("POP_UID") or it.get("uid") or "").strip()
                wid = (it.get("POP_WID") or it.get("wid") or "").strip()
                if t and uid and wid:
                    res.append({"TARGET_URL": t, "POP_UID": uid, "POP_WID": wid})
            if res:
                return res
        except Exception:
            pass
    t = (os.environ.get("TARGET_URL") or "").strip()
    uid = (os.environ.get("POP_UID") or "").strip()
    wid = (os.environ.get("POP_WID") or "").strip()
    return ([{"TARGET_URL": t, "POP_UID": uid, "POP_WID": wid}] if t and uid and wid else [])


async def main():
    loop = asyncio.get_running_loop()
    try:
        loop.set_default_executor(_futures.ThreadPoolExecutor(max_workers=MAX_THREADS))
    except Exception:
        pass

    sites = parse_sites()
    clicks_per_day = int(os.environ.get("CLICKS_PER_DAY"))
    if not sites or clicks_per_day <= 0:
        raise RuntimeError("No valid SITES or CLICKS_PER_DAY not set > 0")

    sem = asyncio.Semaphore(max(1, NUMBER_OF_WORKERS))
    state_lock = asyncio.Lock()
    site_seq: list[int] = [0 for _ in sites]

    def _date_key(ts: float | None = None) -> str:
        t = time.localtime(ts or time.time())
        return f"{t.tm_mon}_{t.tm_mday}_{t.tm_year}"

    def _today_path() -> str:
        return os.path.join(LOG_DIR, f"{_date_key()}.json")

    def _canonical_sites() -> list[dict]:
        return [
            {"TARGET_URL": s["TARGET_URL"], "POP_UID": s["POP_UID"], "POP_WID": s["POP_WID"], "clicks_done": 0}
            for s in sites
        ]

    async def _load_or_init_state() -> dict:
        path = _today_path()
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    d = json.load(f)
                    if d.get("date") == _date_key():
                        d.setdefault("one_hop_counts", {})
                        d.setdefault("one_hop_sizes", {})
                        d.setdefault("one_hop_urls", [])
                        d.setdefault("dropped_clicks", 0)
                        d.setdefault("clicks_done_total", 0)
                        return d
        except Exception:
            pass
        return {
            "date": _date_key(),
            "clicks_per_day": int(clicks_per_day) * max(1, len(sites)),
            "sites": _canonical_sites(),
            "last_updated": int(time.time()),
            "one_hop_counts": {},
            "one_hop_urls": [],
            "one_hop_sizes": {},
            "dropped_clicks": 0,
            "clicks_done_total": 0,
        }

    state = await _load_or_init_state()
    try:
        if not isinstance(state.get("sites"), list) or len(state["sites"]) != len(sites):
            state["sites"] = _canonical_sites()
            state["clicks_per_day"] = int(clicks_per_day) * max(1, len(sites))
    except Exception:
        state["sites"] = _canonical_sites()
        state["clicks_per_day"] = int(clicks_per_day) * max(1, len(sites))

    def _midnight_ts(t: float | None = None) -> float:
        lt = time.localtime(t or time.time())
        return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, lt.tm_wday, lt.tm_yday, lt.tm_isdst))

    async def daily_reporter():
        while True:
            try:
                async with state_lock:
                    cur_key = _date_key()
                    if state.get("date") != cur_key:
                        state["date"] = cur_key
                        state["clicks_per_day"] = int(clicks_per_day) * max(1, len(sites))
                        if not isinstance(state.get("sites"), list) or len(state["sites"]) != len(sites):
                            state["sites"] = _canonical_sites()
                        else:
                            for it in state["sites"]:
                                it["clicks_done"] = 0
                        for i in range(len(site_seq)):
                            site_seq[i] = 0
                        state["one_hop_counts"] = {}
                        state["one_hop_sizes"] = {}
                        state["one_hop_urls"] = []
                        state["dropped_clicks"] = 0
                        state["clicks_done_total"] = 0
                    counts = state.get("one_hop_counts", {})
                    sizes = state.get("one_hop_sizes", {})
                    try:
                        items = sorted(counts.items(), key=lambda kv: (-int(kv[1]), kv[0]))
                    except Exception:
                        items = list(counts.items())
                        items.sort(key=lambda kv: (-int(kv[1]) if str(kv[1]).isdigit() else 0, kv[0]))
                    lst = []
                    for domain, v in items:
                        c = int(v)
                        sb = int(sizes.get(domain, 0))
                        kb_total = round(sb / 1024.0, 2)
                        kb_avg = round((sb / 1024.0) / c, 2) if c > 0 else 0.0
                        lst.append({"domain": domain, "count": c, "kb_total": kb_total, "kb_avg": kb_avg})
                    state["one_hop_urls"] = lst
                    state["last_updated"] = int(time.time())
                    try:
                        successes = int(state.get("clicks_done_total", 0))
                        dropped = int(state.get("dropped_clicks", 0))
                        attempts = successes + dropped
                        pct = (float(dropped) / float(attempts) * 100.0) if attempts > 0 else 0.0
                        state["dropped_percentage"] = round(pct, 2)
                    except Exception:
                        state["dropped_percentage"] = 0.0
                    tmp = _today_path() + ".tmp"
                    out_state = dict(state)
                    out_state.pop("one_hop_counts", None)
                    out_state.pop("one_hop_sizes", None)
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(out_state, f, ensure_ascii=False, indent=2, sort_keys=True)
                        f.write("\n")
                    os.replace(tmp, _today_path())
            except Exception:
                pass
            await asyncio.sleep(60)

    async def site_worker(idx: int, site: dict):
        interval = 86400.0 / float(clicks_per_day)
        cycle = 0
        while True:
            async with state_lock:
                cur_key = _date_key()
                if state.get("date") != cur_key:
                    state["date"] = cur_key
                    state["clicks_per_day"] = int(clicks_per_day) * max(1, len(sites))
                    if not isinstance(state.get("sites"), list) or len(state["sites"]) != len(sites):
                        state["sites"] = _canonical_sites()
                    else:
                        for it in state["sites"]:
                            it["clicks_done"] = 0
                    state["one_hop_counts"] = {}
                    state["one_hop_sizes"] = {}
                    state["one_hop_urls"] = []
                    for i in range(len(site_seq)):
                        site_seq[i] = 0
                base = _midnight_ts()
                now = time.time()
                desired_min_seq = int((now - base) / interval) + 1
                seq = site_seq[idx]
                cd = int(state["sites"][idx]["clicks_done"])
                slot = max(seq, cd, desired_min_seq)
                site_seq[idx] = slot + 1
            next_ts = base + (slot * interval)
            delay = max(0.0, next_ts - now)
            if delay > 0:
                await asyncio.sleep(delay)
            async with sem:
                try:
                    one_hop_url, one_hop_size, blacklisted_domain, dropped = await run_cycle(cycle, site["TARGET_URL"], site["POP_UID"], site["POP_WID"], _p)
                    success = True
                except Exception:
                    success = False
                finally:
                    cycle += 1
            if success:
                async with state_lock:
                    try:
                        if dropped:
                            state["dropped_clicks"] = int(state.get("dropped_clicks", 0)) + 1
                            if blacklisted_domain and blacklisted_domain not in BLACKLIST_DOMAINS:
                                BLACKLIST_DOMAINS.add(blacklisted_domain)
                                save_blacklist(BLACKLIST_DOMAINS)
                        else:
                            state["sites"][idx]["clicks_done"] = int(state["sites"][idx]["clicks_done"]) + 1
                            state["clicks_done_total"] = int(state.get("clicks_done_total", 0)) + 1
                            if one_hop_url:
                                try:
                                    dom = urlparse(one_hop_url).netloc
                                except Exception:
                                    dom = one_hop_url
                                d = state.setdefault("one_hop_counts", {})
                                d[dom] = int(d.get(dom, 0)) + 1
                                s = state.setdefault("one_hop_sizes", {})
                                s[dom] = int(s.get(dom, 0)) + int(one_hop_size or 0)
                            if blacklisted_domain and blacklisted_domain not in BLACKLIST_DOMAINS:
                                BLACKLIST_DOMAINS.add(blacklisted_domain)
                                save_blacklist(BLACKLIST_DOMAINS)
                    except Exception:
                        pass
            await asyncio.sleep(0.5)


    lanes_per_site = max(1, NUMBER_OF_WORKERS // max(1, len(sites)))
    tasks = [
        asyncio.create_task(site_worker(i, s))
        for i, s in enumerate(sites)
        for _ in range(lanes_per_site)
    ]
    rep = asyncio.create_task(daily_reporter())
    # CPM removed
    stop_event = asyncio.Event()

    def _signal_stop() -> None:
        try:
            _p("[EXIT] Signal received, shutting down...")
        except Exception:
            pass
        stop_event.set()

    try:
        asyncio.get_running_loop().add_signal_handler(2, _signal_stop)  # SIGINT
        asyncio.get_running_loop().add_signal_handler(15, _signal_stop) # SIGTERM
    except Exception:
        pass

    await stop_event.wait()
    for t in tasks + [rep]:
        try:
            t.cancel()
        except Exception:
            pass
    with contextlib.suppress(Exception):
        await asyncio.gather(*tasks, rep, cpm, return_exceptions=True)


