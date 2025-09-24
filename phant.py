#!/usr/bin/env python3
import os, time, random, base64, re, urllib.parse as u, asyncio
from urllib.parse import urlparse

from rnet import Client as RnetClient, Emulation as RnetEmulation

TARGET = os.environ.get("TARGET_URL", "https://eus.lat/")

def make_go(target):
    esc = u.quote(target.encode('latin-1','backslashreplace').decode(),
                  safe="~()*!.'")
    b64 = base64.b64encode(esc.encode()).decode()
    cb  = f"{int(time.time()*1000)}.{random.randint(0,1_000_000)}"
    return f"http://p.pcdelv.com/go/495017/746000/{b64}?cb={cb}"

pu, pp, ph = (
    os.environ.get("PROXY_USER"),
    os.environ.get("PROXY_PASS"),
    os.environ.get("PROXY_HOST"),
)

BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

async def rnet_get(url: str, headers: dict) -> dict:
    # rnet (currently) doesn't accept a redirect flag; we rely on manual parsing
    client = RnetClient(emulation=RnetEmulation.Chrome124)
    resp = await client.get(url, headers=headers, timeout=10)
    try:
        body = await resp.read()
    except Exception:
        try:
            body = (await resp.bytes())
        except Exception:
            body = b''
    try:
        text = await resp.text()
    except Exception:
        try:
            text = body.decode('utf-8', errors='ignore')
        except Exception:
            text = ''
    try:
        hdrs = dict(resp.headers)
    except Exception:
        hdrs = {}
    try:
        final_url = str(resp.url)
    except Exception:
        final_url = url
    status = getattr(resp, 'status', None)
    return { 'status': status, 'url': final_url, 'headers': hdrs, 'content': body, 'text': text }

# Iterate proxy ports 10000..20000 and attempt the route on each
for port in range(10000, 20001):
    print(f"\n=== PORT {port} ===")

    # configure proxy via env for rnet
    if pu and pp and ph and port:
        proxy = f"http://{pu}:{pp}@{ph}:{port}"
        os.environ['HTTP_PROXY'] = proxy
        os.environ['HTTPS_PROXY'] = proxy
    else:
        os.environ.pop('HTTP_PROXY', None)
        os.environ.pop('HTTPS_PROXY', None)

    url = make_go(TARGET)
    chain = []

    while True:
        print(f"=> GET {url}")
        r = asyncio.run(rnet_get(url, BASE_HEADERS))
        loc = r['headers'].get('location') or r['headers'].get('Location')
        ctype = r['headers'].get('content-type') or r['headers'].get('Content-Type')
        print(f"<= {r['status']} {r['url']} len={len(r['content'])} ct={ctype or '-'}{f' loc={loc[:50]}' if loc else ''}")
        chain.append(r['status'])

        next_url = None
        if loc:
            next_url = u.urljoin(r['url'], loc)
        else:
            m = re.search(r"top\.location\.href\s*=\s*['\"]([^'\"]+)", r['text'] or '')
            if m:
                next_url = u.urljoin(r['url'], m.group(1))

        if not next_url:
            break

        # Continue only while staying on p.pcdelv.com; stop once it points elsewhere
        if urlparse(next_url).netloc.endswith('p.pcdelv.com'):
            url = next_url
            continue
        break

    print("Status chain:", " → ".join(map(str, chain)))
    print("Final URL   :", r['url'])
