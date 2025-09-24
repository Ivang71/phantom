#!/usr/bin/env python3
import time, random, base64, re, urllib.parse as u, requests as R

# <<< your landing page >>>
TARGET = "https://eus.lat/"

def make_go(target):
    esc = u.quote(target.encode('latin-1','backslashreplace').decode(),
                  safe="~()*!.'")
    b64 = base64.b64encode(esc.encode()).decode()
    cb  = f"{int(time.time()*1000)}.{random.randint(0,1_000_000)}"
    return f"http://p.pcdelv.com/go/495017/746000/{b64}?cb={cb}"

session = R.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
})
url = make_go(TARGET)
chain = []

while True:
    print(f"=> GET {url}")
    resp = session.get(url, timeout=20)
    loc = resp.headers.get('location') or resp.headers.get('Location')
    ctype = resp.headers.get('content-type') or resp.headers.get('Content-Type')
    print(f"<= {resp.status_code} {resp.url} len={len(resp.content)} ct={ctype or '-'}{f' loc={loc}' if loc else ''}")
    chain.append(resp.status_code)
    text = resp.text or ""
    m = re.search(r'top\.location\.href\s*=\s*[\'"]([^\'"]+)', text)
    if not m:
        break
    # follow the script redirect
    url = u.urljoin(resp.url, m.group(1))

print("Status chain:", " → ".join(map(str, chain)))
print("Final URL   :", resp.url)
