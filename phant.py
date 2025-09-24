#!/usr/bin/env python3
import os, time, random, base64, re, urllib.parse as u, requests as R

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

def create_session(port: int) -> R.Session:
    s = R.Session()
    if pu and pp and ph and port:
        proxy = f"http://{pu}:{pp}@{ph}:{port}"
        s.proxies.update({"http": proxy, "https": proxy})
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    return s

# Iterate proxy ports 10000..20000 and attempt the route on each
for port in range(10000, 20001):
    print(f"\n=== PORT {port} ===")
    session = create_session(port)
    url = make_go(TARGET)
    chain = []

    while True:
        print(f"=> GET {url}")
        resp = session.get(url, timeout=5, allow_redirects=False)
        loc = resp.headers.get('location') or resp.headers.get('Location')
        ctype = resp.headers.get('content-type') or resp.headers.get('Content-Type')
        print(f"<= {resp.status_code} {resp.url} len={len(resp.content)} ct={ctype or '-'}{f' loc={loc[:50]}' if loc else ''}")
        chain.append(resp.status_code)

        next_url = None
        if loc:
            next_url = u.urljoin(resp.url, loc)
        else:
            text = resp.text or ""
            m = re.search(r"top\.location\.href\s*=\s*['\"]([^'\"]+)", text)
            if m:
                next_url = u.urljoin(resp.url, m.group(1))

        if not next_url:
            break

        # Continue only while staying on p.pcdelv.com; stop once it points elsewhere
        if u.urlparse(next_url).netloc.endswith('p.pcdelv.com'):
            url = next_url
            continue
        break

    print("Status chain:", " → ".join(map(str, chain)))
    print("Final URL   :", resp.url)
