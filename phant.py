#!/usr/bin/env python3
import os, time, random, asyncio
import urllib.parse as u
from urllib.parse import urlparse

from net.client import TlsBrowser
from browser.headers import chrome_nav_headers, chrome_script_headers, chrome_xhr_headers, set_accept_language
from browser.ua import generate_user_agent
from route.popcash import build_go, next_url_from, extract_probe
from net.geo import detect_geo_via_proxy, locale_from_country, accept_language_header_from_locale

TARGET = os.environ.get("TARGET_URL", "https://industrial-gaming.sbs/")
UID = os.environ.get("POP_UID", "495426")
WID = os.environ.get("POP_WID", "746571")

async def run_port(port: int):
    proxy = None
    pu, pp, ph = (
        os.environ.get("PROXY_USER"),
        os.environ.get("PROXY_PASS"),
        os.environ.get("PROXY_HOST"),
    )
    if pu and pp and ph and port:
        proxy = f"http://{pu}:{pp}@{ph}:{port}"
    ua, ua_meta = generate_user_agent(port)

    # Detect GEO via current proxy and set Accept-Language accordingly
    try:
        g = detect_geo_via_proxy(os.environ.get("PROXY_HOST"), os.environ.get("PROXY_USER"), os.environ.get("PROXY_PASS"), port)
        if g and g.get('countryCode'):
            locale = locale_from_country(g['countryCode'])
            set_accept_language(accept_language_header_from_locale(locale))
    except Exception:
        pass
    # Chrome-like TLS + redirect following via tls-client only
    b = TlsBrowser(ua, proxy)

    # optional: load tag script with target referer
    try:
        sh = chrome_script_headers(TARGET, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'])
        # print(f"=> GET https://cdn.popcash.net/show.js")
        # _ = await b.get("https://cdn.popcash.net/show.js", sh, timeout=8)
    except Exception:
        pass

    # optional: pre-flight probe as XHR like the tag
    try:
        tgt = urlparse(TARGET)
        origin = f"{tgt.scheme}://{tgt.netloc}"
        xh = chrome_xhr_headers(TARGET, origin, 'cross-site', ua_meta['major'], ua_meta['platform'], ua_meta['mobile'])
        print(f"=> GET https://dcba.popcash.net/znWaa3gu")
        _ = await b.get("https://dcba.popcash.net/znWaa3gu", xh, timeout=5)
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
        h = chrome_nav_headers(referer, site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'])
        print(f"=> GET {url}")
        r = await b.get(url, h, timeout=10)
        loc = r['headers'].get('location') or r['headers'].get('Location')
        ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
        print(f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc[:50]}' if loc else ''}")
        chain.append(r['status'])
        seen_urls.add(r['url'])

        # try probe if present to emulate page behaviour
        probe = extract_probe(r['text'])
        if probe:
            print(f"=> GET {probe}")
            _ = await b.get(probe, chrome_script_headers(TARGET, ua_meta['major'], ua_meta['platform'], ua_meta['mobile']), timeout=5)

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
                    h = chrome_nav_headers(r['url'], site_ctx, ua_meta['major'], ua_meta['platform'], ua_meta['mobile'])
                    print(f"Following /cl once to: {nxt_from_cl}")
                    # EXACTLY one hop after /cl: do not auto-follow more.
                    r = await b.get(nxt_from_cl, h, timeout=10)
                    loc_final = r['headers'].get('location') or r['headers'].get('Location')
                    ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
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
                            print(f"=> GET {pu_url}")
                            _ = await b.get(pu_url, chrome_script_headers(r['url'], ua_meta['major'], ua_meta['platform'], ua_meta['mobile']), timeout=5)
                    except Exception:
                        pass
                    break
                else:
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

    print("Status chain:", " → ".join(map(str, chain)))
    print("Final URL   :", r['url'])

async def main():
    for port in range(10000, 20001):
        print(f"\n=== PORT {port} ===")
        try:
            await run_port(port)
        except Exception as e:
            print(f"[PORT {port}] error: {e}")
        await asyncio.sleep(0.05)

if __name__ == '__main__':
    asyncio.run(main())
