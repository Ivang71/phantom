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
from net.geo import detect_geo_via_proxy, locale_from_country, accept_language_header_from_locale

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
SILENT = env_flag('SILENT', False)
DWELL_PRE_MS = int(os.environ.get('DWELL_PRE_MS', '0'))
DWELL_POST_MS = int(os.environ.get('DWELL_POST_MS', '0'))
NUMBER_OF_WORKERS = int(os.environ.get('NUMBER_OF_WORKERS'))
_cores = (os.cpu_count() or 4)
_auto_threads = min(4096, max(_cores * 8, NUMBER_OF_WORKERS * 8))
MAX_THREADS = int(os.environ.get('MAX_THREADS') or _auto_threads)
STAGGER_START_MS = int(os.environ.get('STAGGER_START_MS', '15000'))
STATS_FILE = os.environ.get('STATS_FILE', 'bot-stats.json')
STATS_INTERVAL_SEC = float(os.environ.get('STATS_INTERVAL_SEC', '60'))

async def run_port(port: int) -> bool:
    proxy = None
    pu, pp, ph = (
        os.environ.get("PROXY_USER"),
        os.environ.get("PROXY_PASS"),
        os.environ.get("PROXY_HOST"),
    )
    if pu and pp and ph and port:
        proxy = f"http://{pu}:{pp}@{ph}:{port}"
    ua, ua_meta = generate_user_agent(port)

    async def detect_accept_language_for_port() -> str | None:
        try:
            g = await asyncio.to_thread(
                detect_geo_via_proxy,
                os.environ.get("PROXY_HOST"),
                os.environ.get("PROXY_USER"),
                os.environ.get("PROXY_PASS"),
                port,
            )
            if g and g.get('countryCode'):
                locale = locale_from_country(g['countryCode'])
                return accept_language_header_from_locale(locale)
        except Exception:
            return None
        return None
    # Chrome-like TLS + redirect following via tls-client only
    b = TlsBrowser(ua, proxy)

    # optional: load tag script with target referer
    try:
        al = await detect_accept_language_for_port()
        sh = chrome_script_headers(TARGET, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        # print(f"=> GET https://cdn.popcash.net/show.js")
        # _ = await b.get("https://cdn.popcash.net/show.js", sh, timeout=8)
    except Exception:
        pass

    # optional: pre-flight probe as XHR like the tag
    try:
        tgt = urlparse(TARGET)
        origin = f"{tgt.scheme}://{tgt.netloc}"
        al = await detect_accept_language_for_port()
        xh = chrome_xhr_headers(TARGET, origin, 'cross-site', ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        if not SILENT:
            print(f"=> GET https://dcba.popcash.net/znWaa3gu")
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

    external_hop_done = False
    while True:
        try:
            cur_host = urlparse(url).netloc
            ref_host = urlparse(referer).netloc
            site_ctx = 'same-origin' if cur_host == ref_host else 'cross-site'
        except Exception:
            site_ctx = 'cross-site'
        # Always re-detect geo per request for per-proxy alignment
        al = await detect_accept_language_for_port()
        h = chrome_nav_headers(referer, site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        if not SILENT:
            print(f"=> GET {url}")
        r = await b.get(url, h, timeout=10)
        loc = r['headers'].get('location') or r['headers'].get('Location')
        ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
        # optional cookie/header logging
        if LOG_COOKIES and not SILENT:
            sc = r.get('set_cookies') or []
            if sc:
                for c in sc:
                    print(f"[SET-COOKIE] {c}")
            sc1 = r['headers'].get('set-cookie')
            if sc1:
                print(f"[SET-COOKIE] {sc1}")
            jc = r.get('jar_cookies') or []
            if jc:
                print(f"[JAR] {'; '.join(jc)}")
        if LOG_HEADERS and not SILENT:
            print(f"[HEADERS] {r['headers']}")
        if not SILENT:
            print(f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc[:50]}' if loc else ''}")
        chain.append(r['status'])
        seen_urls.add(r['url'])

        # try probe if present to emulate page behaviour
        probe = extract_probe(r['text'])
        if probe:
            if not SILENT:
                print(f"=> GET {probe}")
            al_probe = await detect_accept_language_for_port()
            _ = await b.get(probe, chrome_script_headers(TARGET, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al_probe), timeout=5)

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
                    al_cl = await detect_accept_language_for_port()
                    h = chrome_nav_headers(r['url'], site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al_cl)
                    if not SILENT:
                        print(f"Following /cl once to: {nxt_from_cl}")
                    # EXACTLY one hop after /cl: do not auto-follow more.
                    r = await b.get(nxt_from_cl, h, timeout=10)
                    loc_final = r['headers'].get('location') or r['headers'].get('Location')
                    ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
                    if LOG_COOKIES and not SILENT:
                        sc = r.get('set_cookies') or []
                        if sc:
                            for c in sc:
                                print(f"[SET-COOKIE] {c}")
                        sc1 = r['headers'].get('set-cookie')
                        if sc1:
                            print(f"[SET-COOKIE] {sc1}")
                        jc = r.get('jar_cookies') or []
                        if jc:
                            print(f"[JAR] {'; '.join(jc)}")
                    if LOG_HEADERS and not SILENT:
                        print(f"[HEADERS] {r['headers']}")
                    if not SILENT:
                        print(f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc_final[:50]}' if loc_final else ''}")
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
                            if not SILENT:
                                print(f"=> GET {pu_url}")
                            al_px = await detect_accept_language_for_port()
                            _ = await b.get(pu_url, chrome_script_headers(r['url'], ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al_px), timeout=5)
                    except Exception:
                        pass
                    external_hop_done = True
                    break
                else:
                    if not SILENT:
                        print("[CL] No next URL resolvable from Location/Refresh/body; stopping (no hop performed)")

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
                    if not SILENT:
                        print(f"[Redirect] loop detected to same/seen URL, stopping: {next_url}")
                    break
                referer = r['url']
                url = next_url
                await asyncio.sleep(random.uniform(0.05, 0.2))
                continue
            else:
                if not no_loc_retry:
                    # Some variants issue a cookie-setting 3xx without Location first; retry once
                    no_loc_retry = True
                    if not SILENT:
                        print(f"[Redirect] {code} without Location; headers: {r['headers']}")
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
    if not SILENT:
        print("Status chain:", " → ".join(map(str, chain)))
        print("Final URL   :", r['url'])
    return external_hop_done

async def main():
    # Ensure enough threads for asyncio.to_thread (geo lookups, tls-client calls)
    loop = asyncio.get_running_loop()
    try:
        loop.set_default_executor(_futures.ThreadPoolExecutor(max_workers=MAX_THREADS))
    except Exception:
        pass
    PORT_START = 10000
    PORT_END = 20000
    next_port = PORT_START
    lock = asyncio.Lock()
    num_workers = max(1, NUMBER_OF_WORKERS)
    worker_cycles = [0] * num_workers

    async def get_next_port() -> int:
        nonlocal next_port
        async with lock:
            p = next_port
            next_port = PORT_START if p >= PORT_END else p + 1
            return p

    async def worker(worker_id: int):
        if STAGGER_START_MS > 0:
            delay_s = (STAGGER_START_MS / max(1, NUMBER_OF_WORKERS)) * worker_id / 1000.0
            await asyncio.sleep(delay_s)
        while True:
            port = await get_next_port()
            if not SILENT:
                print(f"\n=== PORT {port} ===")
            success = False
            try:
                success = await run_port(port)
            except Exception as e:
                if not SILENT:
                    print(f"[PORT {port}] error: {e}")
            finally:
                if success:
                    worker_cycles[worker_id] += 1
            await asyncio.sleep(0.05)

    async def stats_reporter():
        while True:
            await asyncio.sleep(max(1.0, STATS_INTERVAL_SEC))
            total = sum(worker_cycles)
            try:
                with open(STATS_FILE, 'a') as f:
                    f.write(json.dumps({"ts": int(time.time()), "total_cycles": total}) + "\n")
            except Exception:
                pass

    workers = [asyncio.create_task(worker(i)) for i in range(num_workers)]
    reporter = asyncio.create_task(stats_reporter())
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.gather(*workers, reporter)

if __name__ == '__main__':
    asyncio.run(main())
