#!/usr/bin/env python3
import os, time, random, asyncio
import urllib.parse as u
from urllib.parse import urlparse

from net.client import RnetBrowser
from browser.headers import chrome_nav_headers
from route.popcash import build_go, next_url_from

TARGET = os.environ.get("TARGET_URL", "https://eus.lat/")
UID = os.environ.get("POP_UID", "495017")
WID = os.environ.get("POP_WID", "746000")
UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

async def run_port(port: int):
    proxy = None
    pu, pp, ph = (
        os.environ.get("PROXY_USER"),
        os.environ.get("PROXY_PASS"),
        os.environ.get("PROXY_HOST"),
    )
    if pu and pp and ph and port:
        proxy = f"http://{pu}:{pp}@{ph}:{port}"
    b = RnetBrowser(UA, proxy)

    url = build_go(TARGET, UID, WID)
    chain = []
    referer = TARGET

    while True:
        h = chrome_nav_headers(referer, 'cross-site') if referer == TARGET else chrome_nav_headers(referer, 'same-origin')
        print(f"=> GET {url}")
        r = await b.get(url, h, timeout=10)
        loc = r['headers'].get('location') or r['headers'].get('Location')
        ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
        print(f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc[:50]}' if loc else ''}")
        chain.append(r['status'])

        nxt = next_url_from(r['url'], r['headers'], r['text'])
        if not nxt:
            break
        if urlparse(nxt).netloc.endswith('p.pcdelv.com'):
            referer = r['url']
            url = nxt
            await asyncio.sleep(random.uniform(0.05, 0.15))
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
