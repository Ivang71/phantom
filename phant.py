#!/usr/bin/env python3
import os, time, random, asyncio, contextlib, json
try:
    from dotenv import load_dotenv, find_dotenv  # type: ignore
    from pathlib import Path
    # Priority: ENV_PATH -> nearest .env from CWD -> .env next to this file -> ~/.env
    _ENV_CANDIDATE = os.environ.get('ENV_PATH')
    if _ENV_CANDIDATE:
        load_dotenv(dotenv_path=_ENV_CANDIDATE, override=True)
    else:
        _FOUND = find_dotenv(usecwd=True)
        if _FOUND:
            load_dotenv(dotenv_path=_FOUND, override=True)
        load_dotenv(dotenv_path=Path(__file__).resolve().parent / '.env', override=False)
        load_dotenv(dotenv_path=Path.home() / '.env', override=False)
except Exception:
    # Fallback minimal .env loader (KEY=VALUE) if python-dotenv is unavailable
    try:
        from pathlib import Path
        def _load_env_file(p: 'Path') -> None:
            if not p.exists():
                return
            try:
                for line in p.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
            except Exception:
                pass
        _load_env_file(Path.cwd() / '.env')
        _load_env_file(Path(__file__).resolve().parent / '.env')
        _load_env_file(Path.home() / '.env')
    except Exception:
        pass
import urllib.parse as u
from urllib.parse import urlparse
import concurrent.futures as _futures

from net.client import TlsBrowser
from browser.headers import chrome_nav_headers, chrome_script_headers, chrome_xhr_headers
from browser.ua import generate_user_agent
from route.popcash import build_go, next_url_from, extract_probe
from net.geo import locale_from_country, accept_language_header_from_locale

TARGET = os.environ.get("TARGET_URL")
UID = os.environ.get("POP_UID")
WID = os.environ.get("POP_WID")

def env_flag(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")

LOG_HEADERS = env_flag('LOG_HEADERS', False)
LOG_COOKIES = env_flag('LOG_COOKIES', False)
DWELL_PRE_MS = int(os.environ.get('DWELL_PRE_MS', '0'))
DWELL_POST_MS = int(os.environ.get('DWELL_POST_MS', '0'))
NUMBER_OF_WORKERS = int(os.environ.get('NUMBER_OF_WORKERS'))
_cores = (os.cpu_count() or 4)
_auto_threads = min(4096, max(_cores * 8, NUMBER_OF_WORKERS * 8))
MAX_THREADS = int(os.environ.get('MAX_THREADS') or _auto_threads)
STAGGER_START_MS = int(os.environ.get('STAGGER_START_MS', '15000'))
VERBOSE = env_flag('VERBOSE', False)
SILENT = env_flag('SILENT', False)

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

def _u(s: str) -> str:
    try:
        s = str(s)
    except Exception:
        return ""
    return s if len(s) <= 70 else f"{s[:67]}..."

COUNTRIES = [
    "Australia", "Austria", "Belgium", "Canada", "Czechia", "Denmark", "Finland",
    "France", "Germany", "HongKong", "Ireland", "Israel", "Italy", "Japan",
    "Liechtenstein", "Luxembourg", "Netherlands", "NewZealand", "Norway", "Singapore",
    "Spain", "Sweden", "Switzerland", "Taiwan", "UnitedArabEmirates", "UnitedKingdom",
    "UnitedStates",
]

NAME_TO_CC = {
    "Australia": "AU", "Austria": "AT", "Belgium": "BE", "Canada": "CA", "Czechia": "CZ",
    "Denmark": "DK", "Finland": "FI", "France": "FR", "Germany": "DE", "HongKong": "HK",
    "Ireland": "IE", "Israel": "IL", "Italy": "IT", "Japan": "JP", "Liechtenstein": "LI",
    "Luxembourg": "LU", "Netherlands": "NL", "NewZealand": "NZ", "Norway": "NO",
    "Singapore": "SG", "Spain": "ES", "Sweden": "SE", "Switzerland": "CH", "Taiwan": "TW",
    "UnitedArabEmirates": "AE", "UnitedKingdom": "GB", "UnitedStates": "US",
}

def _gen_session_token(n: int = 16) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(random.choice(alphabet) for _ in range(n))

async def run_cycle(cycle: int):
    pu = os.environ.get("PROXY_USER")
    pp = os.environ.get("PROXY_PASS")
    ph = os.environ.get("PROXY_HOST")
    pport = os.environ.get("PROXY_PORT")
    ua, ua_meta = generate_user_agent(cycle)

    country = random.choice(COUNTRIES)
    cc = NAME_TO_CC.get(country, "US")
    session_token = _gen_session_token()
    pwd = f"{pp}_country-{country}_session-{session_token}" if pp else None
    proxy = f"http://{pu}:{pwd}@{ph}:{pport}" if pu and pwd and ph and pport else None
    locale = locale_from_country(cc)
    al = accept_language_header_from_locale(locale)
    if VERBOSE:
        tok_disp = f"{session_token[:6]}...{session_token[-4:]}" if len(session_token) > 10 else session_token
        _p(lambda: f"[VERBOSE] cycle={cycle} country={country} cc={cc} token={tok_disp} proxy={ph}:{pport}")

    b = TlsBrowser(ua, proxy)

    # optional: load tag script with target referer
    try:
        sh = chrome_script_headers(TARGET, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        # print(f"=> GET https://cdn.popcash.net/show.js")
        # _ = await b.get("https://cdn.popcash.net/show.js", sh, timeout=8)
    except Exception:
        pass

    # optional: pre-flight probe as XHR like the tag
    try:
        tgt = urlparse(TARGET)
        origin = f"{tgt.scheme}://{tgt.netloc}"
        xh = chrome_xhr_headers(TARGET, origin, 'cross-site', ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        _p(lambda: f"=> GET {_u('https://dcba.popcash.net/znWaa3gu')}")
        _ = await b.get("https://dcba.popcash.net/znWaa3gu", xh, timeout=5)
    except Exception:
        pass
    # Optional dwell before launching the redirect chain
    try:
        if DWELL_PRE_MS > 0:
            await asyncio.sleep(DWELL_PRE_MS / 1000.0)
    except Exception:
        pass

    url = build_go(TARGET, UID, WID)
    chain = []
    referer = TARGET
    cl_hops = 0  # Track hops after /cl
    no_loc_retry = False  # Retry once if 3xx without Location
    seen_urls: set[str] = set()

    while True:
        try:
            cur_host = urlparse(url).netloc
            ref_host = urlparse(referer).netloc
            site_ctx = 'same-origin' if cur_host == ref_host else 'cross-site'
        except Exception:
            site_ctx = 'cross-site'
        h = chrome_nav_headers(referer, site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        _p(lambda: f"=> GET {_u(url)}")
        r = await b.get(url, h, timeout=10)
        loc = r['headers'].get('location') or r['headers'].get('Location')
        ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
        # optional cookie/header logging
        if LOG_COOKIES:
            sc = r.get('set_cookies') or []
            if sc:
                for c in sc:
                    _p(lambda: f"[SET-COOKIE] {c}")
            sc1 = r['headers'].get('set-cookie')
            if sc1:
                _p(lambda: f"[SET-COOKIE] {sc1}")
            jc = r.get('jar_cookies') or []
            if jc:
                _p(lambda: f"[JAR] {'; '.join(jc)}")
        if LOG_HEADERS:
            _p(lambda: f"[HEADERS] {r['headers']}")
        _p(lambda: f"<= {r['status']} {_u(r['url'])} len={len(r['content'])} ct={ctype or '-'}{f' loc={_u(loc)}' if loc else ''}")
        chain.append(r['status'])
        seen_urls.add(r['url'])

        # try probe if present to emulate page behaviour
        probe = extract_probe(r['text'])
        if probe:
            _p(lambda: f"=> GET {_u(probe)}")
            _ = await b.get(probe, chrome_script_headers(TARGET, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al), timeout=5)

        # Check if current URL contains /cl
        if '/cl' in r['url']:
            if cl_hops == 0:
                cl_hops = 1
                # Resolve next hop from headers or body (Location, Refresh, or top.location)
                nxt_from_cl = next_url_from(r['url'], r['headers'], r['text'])
                if nxt_from_cl:
                    try:
                        cur_host = urlparse(nxt_from_cl).netloc
                        ref_host = urlparse(r['url']).netloc
                        site_ctx = 'same-origin' if cur_host == ref_host else 'cross-site'
                    except Exception:
                        site_ctx = 'cross-site'
                    h = chrome_nav_headers(r['url'], site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
                    _p(lambda: f"Following /cl once to: {_u(nxt_from_cl)}")
                    # EXACTLY one hop after /cl: do not auto-follow more.
                    r = await b.get(nxt_from_cl, h, timeout=10)
                    loc_final = r['headers'].get('location') or r['headers'].get('Location')
                    ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
                    if LOG_COOKIES:
                        sc = r.get('set_cookies') or []
                        if sc:
                            for c in sc:
                                _p(lambda: f"[SET-COOKIE] {c}")
                        sc1 = r['headers'].get('set-cookie')
                        if sc1:
                            _p(lambda: f"[SET-COOKIE] {sc1}")
                        jc = r.get('jar_cookies') or []
                        if jc:
                            _p(lambda: f"[JAR] {'; '.join(jc)}")
                    if LOG_HEADERS:
                        _p(lambda: f"[HEADERS] {r['headers']}")
                    _p(lambda: f"<= {r['status']} {_u(r['url'])} len={len(r['content'])} ct={ctype or '-'}{f' loc={_u(loc_final)}' if loc_final else ''}")
                    chain.append(r['status'])
                    # Try to fire impression/view pixels referenced in final HTML
                    try:
                        import re
                        txt = r.get('text') or ''
                        pixel_urls = set()
                        for m in re.findall(r"https?://[^'\"\s>]+", txt):
                            if ('popcash' in m or 'pcdelv' in m) and any(x in m for x in ('imp', 'impression', 'pixel', 'view', 'track')):
                                pixel_urls.add(m)
                        for pu_url in list(pixel_urls)[:5]:
                            _p(lambda pu_url=pu_url: f"=> GET {_u(pu_url)}")
                            _ = await b.get(pu_url, chrome_script_headers(r['url'], ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al), timeout=5)
                    except Exception:
                        pass
                    break
                else:
                    _p("[CL] No next URL resolvable from Location/Refresh/body; stopping (no hop performed)")

        # Generic redirect handling to reach /cl when /go responds with 3xx
        try:
            status_val = r['status']
            code = int(status_val) if isinstance(status_val, int) else int(str(status_val).split()[0])
        except Exception:
            code = None
        if code in (301, 302, 303, 307, 308):
            loc = r['headers'].get('location') or r['headers'].get('Location')
            if loc:
                next_url = u.urljoin(r['url'], loc)
                if next_url == r['url'] or next_url in seen_urls:
                    _p(lambda: f"[Redirect] loop detected to same/seen URL, stopping: {_u(next_url)}")
                    break
                referer = r['url']
                url = next_url
                await asyncio.sleep(random.uniform(0.05, 0.2))
                continue
            else:
                if not no_loc_retry:
                    # Some variants issue a cookie-setting 3xx without Location first; retry once
                    no_loc_retry = True
                    _p(lambda: f"[Redirect] {code} without Location; headers: {r['headers']}")
                    await asyncio.sleep(random.uniform(0.05, 0.15))
                    continue

        nxt = next_url_from(r['url'], r['headers'], r['text'])
        if not nxt:
            break
        if urlparse(nxt).netloc.endswith('p.pcdelv.com'):
            referer = r['url']
            url = nxt
            await asyncio.sleep(random.uniform(0.05, 0.2))
            continue
        break

    # Optional dwell after final hop to allow async beacons
    try:
        if DWELL_POST_MS > 0:
            await asyncio.sleep(DWELL_POST_MS / 1000.0)
    except Exception:
        pass
    _p(lambda: "Status chain: " + " → ".join(map(str, chain)))
    _p(lambda: "Final URL   : " + _u(r['url']))

async def main():
    # Ensure enough threads for asyncio.to_thread (geo lookups, tls-client calls)
    loop = asyncio.get_running_loop()
    try:
        loop.set_default_executor(_futures.ThreadPoolExecutor(max_workers=MAX_THREADS))
    except Exception:
        pass
    num_workers = max(1, NUMBER_OF_WORKERS)
    worker_cycles = [0 for _ in range(num_workers)]

    async def reporter():
        report_path = os.environ.get("CYCLES_REPORT_PATH") or os.path.join(os.path.dirname(__file__), "cycles.json")
        while True:
            try:
                total = sum(worker_cycles)
                payload = {
                    "timestamp": int(time.time()),
                    "total": int(total),
                    "workers": int(num_workers),
                    "per_worker": list(worker_cycles),
                }
                tmp_path = report_path + ".tmp"
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
                    f.write("\n")
                os.replace(tmp_path, report_path)
            except Exception:
                pass
            await asyncio.sleep(60)

    async def worker(worker_id: int):
        if STAGGER_START_MS > 0:
            delay_s = (STAGGER_START_MS / max(1, NUMBER_OF_WORKERS)) * worker_id / 1000.0
            await asyncio.sleep(delay_s)
        cycle = 0
        while True:
            _p(lambda: f"\n=== cycle {cycle} ===")
            try:
                await run_cycle(cycle)
            except Exception as e:
                print(f"[worker {worker_id}] error: {e}")
            worker_cycles[worker_id] = cycle + 1
            await asyncio.sleep(0.05)
            cycle += 1

    workers = [asyncio.create_task(worker(i)) for i in range(num_workers)]
    rep = asyncio.create_task(reporter())
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.gather(*workers, rep)

if __name__ == '__main__':
    asyncio.run(main())
