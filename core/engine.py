import os, random, asyncio
import urllib.parse as u
from urllib.parse import urlparse
from net.client import TlsBrowser
from browser.headers import chrome_nav_headers, chrome_script_headers, chrome_xhr_headers
from browser.ua import generate_user_agent
from route.popcash import build_go, next_url_from, extract_probe
from net.geo import locale_from_country, accept_language_header_from_locale
from core.config import LOG_HEADERS, LOG_COOKIES, HTTP_TIMEOUT, VERBOSE
NAME_TO_CC = {
    "Australia":"AU", "Canada":"CA", "Czechia":"CZ", "Denmark":"DK", "Finland":"FI", "France":"FR", "Germany":"DE",
    "Italy":"IT", "Norway":"NO", "Spain":"ES", "Sweden":"SE", "Switzerland":"CH", "UnitedKingdom":"GB",
}
COUNTRIES = [
    "Australia", "Canada", "Czechia", "Denmark", "Finland",
    "France", "Germany", "Italy", "Norway",
    "Spain", "Sweden", "Switzerland", "UnitedKingdom",
]
from core.blacklist import BLACKLIST_DOMAINS


def _gen_session_token(n: int = 16) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(random.choice(alphabet) for _ in range(n))


def _pick_country() -> str:
    return random.choice(COUNTRIES)


async def run_cycle(cycle: int, target: str, uid: str, wid: str, logger) -> tuple[str | None, int, str | None, bool]:
    pu = os.environ.get("PROXY_USER")
    pp = os.environ.get("PROXY_PASS")
    ph = os.environ.get("PROXY_HOST")
    pport = os.environ.get("PROXY_PORT")
    ua, ua_meta = generate_user_agent(cycle)

    country = _pick_country()
    cc = NAME_TO_CC.get(country, "US")
    session_token = _gen_session_token()
    pwd = f"{pp}_country-{country}_session-{session_token}" if pp else None
    proxy = f"http://{pu}:{pwd}@{ph}:{pport}" if pu and pwd and ph and pport else None
    locale = locale_from_country(cc)
    al = accept_language_header_from_locale(locale)
    if VERBOSE:
        tok_disp = f"{session_token[:6]}...{session_token[-4:]}" if len(session_token) > 10 else session_token
        logger(lambda: f"[VERBOSE] cycle={cycle} country={country} cc={cc} token={tok_disp} proxy={ph}:{pport}")

    b = TlsBrowser(ua, proxy)

    try:
        _ = chrome_script_headers(target, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
    except Exception:
        pass

    try:
        tgt = urlparse(target)
        origin = f"{tgt.scheme}://{tgt.netloc}"
        xh = chrome_xhr_headers(target, origin, 'cross-site', ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        logger(lambda: f"=> GET {'https://dcba.popcash.net/znWaa3gu'}")
        _ = await b.get("https://dcba.popcash.net/znWaa3gu", xh, timeout=HTTP_TIMEOUT)
    except Exception:
        pass

    url = build_go(target, uid, wid)
    chain: list[int] = []
    referer = target
    cl_hops = 0
    no_loc_retry = False
    seen_urls: set[str] = set()
    final_one_hop_url: str | None = None
    final_one_hop_size: int = 0
    blacklisted_domain: str | None = None
    dropped_due_to_blacklist: bool = False

    while True:
        try:
            cur_host = urlparse(url).netloc
            ref_host = urlparse(referer).netloc
            site_ctx = 'same-origin' if cur_host == ref_host else 'cross-site'
        except Exception:
            site_ctx = 'cross-site'
        h = chrome_nav_headers(referer, site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
        logger(lambda: f"=> GET {url}")
        r = await b.get(url, h, timeout=HTTP_TIMEOUT)
        loc = r['headers'].get('location') or r['headers'].get('Location')
        ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
        if LOG_COOKIES:
            sc = r.get('set_cookies') or []
            if sc:
                for c in sc:
                    logger(lambda c=c: f"[SET-COOKIE] {c}")
            sc1 = r['headers'].get('set-cookie')
            if sc1:
                logger(lambda sc1=sc1: f"[SET-COOKIE] {sc1}")
            jc = r.get('jar_cookies') or []
            if jc:
                logger(lambda jc=jc: f"[JAR] {'; '.join(jc)}")
        if LOG_HEADERS:
            logger(lambda: f"[HEADERS] {r['headers']}")
        logger(lambda: f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc}' if loc else ''}")
        chain.append(r['status'])
        seen_urls.add(r['url'])

        probe = extract_probe(r['text'])
        if probe:
            logger(lambda: f"=> GET {probe}")
            _ = await b.get(probe, chrome_script_headers(target, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al), timeout=HTTP_TIMEOUT)

        if '/cl' in r['url']:
            if cl_hops == 0:
                cl_hops = 1
                nxt_from_cl = next_url_from(r['url'], r['headers'], r['text'])
                if nxt_from_cl:
                    try:
                        cur_host = urlparse(nxt_from_cl).netloc
                        ref_host = urlparse(r['url']).netloc
                        site_ctx = 'same-origin' if cur_host == ref_host else 'cross-site'
                    except Exception:
                        site_ctx = 'cross-site'
                    h = chrome_nav_headers(r['url'], site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al)
                    try:
                        dom = urlparse(nxt_from_cl).netloc
                    except Exception:
                        dom = ''
                    if dom and dom in BLACKLIST_DOMAINS:
                        logger(lambda: f"[BLACKLIST] Skipping download for domain={dom} url={nxt_from_cl}")
                        final_one_hop_url = nxt_from_cl
                        final_one_hop_size = 0
                        dropped_due_to_blacklist = True
                        break
                    h2 = dict(h)
                    h2['Range'] = 'bytes=0-8191'
                    logger(lambda: f"Following /cl once to: {nxt_from_cl}")
                    r = await b.get(nxt_from_cl, h2, timeout=HTTP_TIMEOUT)
                    final_one_hop_url = r['url']
                    try:
                        final_one_hop_size = int(len(r.get('content') or b''))
                    except Exception:
                        final_one_hop_size = 0
                    try:
                        if r.get('aborted_at_cap'):
                            if dom:
                                blacklisted_domain = dom
                            else:
                                try:
                                    blacklisted_domain = urlparse(final_one_hop_url).netloc if final_one_hop_url else None
                                except Exception:
                                    blacklisted_domain = None
                            dropped_due_to_blacklist = True
                    except Exception:
                        pass
                    try:
                        total_bytes = None
                        cr = r['headers'].get('content-range') or r['headers'].get('Content-Range')
                        if cr and '/' in str(cr):
                            total_str = str(cr).split('/')[-1].strip()
                            if total_str.isdigit():
                                total_bytes = int(total_str)
                        if total_bytes is None:
                            cl_hdr = r['headers'].get('content-length') or r['headers'].get('Content-Length')
                            if cl_hdr and str(cl_hdr).isdigit():
                                total_bytes = int(cl_hdr)
                        if total_bytes is None and int(r.get('status') or 0) == 200 and final_one_hop_size >= 8192:
                            total_bytes = final_one_hop_size
                        if (total_bytes is not None) and total_bytes > 8192:
                            blacklisted_domain = dom or (urlparse(final_one_hop_url).netloc if final_one_hop_url else None)
                    except Exception:
                        pass
                    loc_final = r['headers'].get('location') or r['headers'].get('Location')
                    ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
                    if LOG_COOKIES:
                        sc = r.get('set_cookies') or []
                        if sc:
                            for c in sc:
                                logger(lambda c=c: f"[SET-COOKIE] {c}")
                        sc1 = r['headers'].get('set-cookie')
                        if sc1:
                            logger(lambda sc1=sc1: f"[SET-COOKIE] {sc1}")
                        jc = r.get('jar_cookies') or []
                        if jc:
                            logger(lambda jc=jc: f"[JAR] {'; '.join(jc)}")
                    if LOG_HEADERS:
                        logger(lambda: f"[HEADERS] {r['headers']}")
                    logger(lambda: f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc_final}' if loc_final else ''}")
                    chain.append(r['status'])
                    try:
                        import re
                        txt = r.get('text') or ''
                        pixel_urls = set()
                        for m in re.findall(r"https?://[^'\"\s>]+", txt):
                            if ('popcash' in m or 'pcdelv' in m) and any(x in m for x in ('imp', 'impression', 'pixel', 'view', 'track')):
                                pixel_urls.add(m)
                        for pu_url in list(pixel_urls)[:5]:
                            logger(lambda pu_url=pu_url: f"=> GET {pu_url}")
                            _ = await b.get(pu_url, chrome_script_headers(r['url'], ua_meta['major'], ua_meta['platform'], ua_meta['mobile'], al), timeout=HTTP_TIMEOUT)
                    except Exception:
                        pass
                    break
                else:
                    logger("[CL] No next URL resolvable from Location/Refresh/body; stopping (no hop performed)")

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
                    logger(lambda: f"[Redirect] loop detected to same/seen URL, stopping: {next_url}")
                    break
                referer = r['url']
                url = next_url
                await asyncio.sleep(random.uniform(0.05, 0.2))
                continue
            else:
                if not no_loc_retry:
                    no_loc_retry = True
                    logger(lambda: f"[Redirect] {code} without Location; headers: {r['headers']}")
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

    try:
        await b.aclose()
    except Exception:
        pass

    return final_one_hop_url, final_one_hop_size, blacklisted_domain, dropped_due_to_blacklist


