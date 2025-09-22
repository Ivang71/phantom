import asyncio, os, re, time, random, base64, urllib.parse
from urllib.parse import urljoin
from rnet import Client, Impersonate                # pip install rnet
from dotenv import load_dotenv

load_dotenv()

UID = "495017"
WID = "746009"
TARGET = "https://globalstreaming.lol/"

# Flow summary:
# 1.   GET main site         → sets PopCash context (not strictly needed)
# 2.   GET /go               → 200 (inline JS)  *or* 303→200 (cookie gate)
# 3.   Extract /v2/.../cl    → same-origin GET → 302 to advertiser
# 4.   Stop here (bandwidth saved)

# Navigation headers that make PCDelv treat this as a real browser navigation
NAV_HEADERS = {
    # -- the five that flip PCDelv into "navigation" mode --
    "Referer": TARGET,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",

    # -- make it look like Chrome DevTools copied headers --
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,image/apng,*/*;q=0.8,"
               "application/signed-exchange;v=b3;q=0.7"),
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    # rnet already adds Accept-Encoding, Host and User-Agent for you.
}

# Pre-built header variations
CROSS_SITE = {**NAV_HEADERS}
SAME_ORIGIN = {**NAV_HEADERS, 'Sec-Fetch-Site': 'same-origin'}

def js_escape(url: str) -> str:
    out = []
    for ch in url:
        c = ord(ch)
        if 0x30 <= c <= 0x39 or 0x41 <= c <= 0x5a or 0x61 <= c <= 0x7a or ch in "@*_+-./":
            out.append(ch)
        elif c < 256:
            out.append("%%%02X" % c)
        else:
            out.append("%%u%04X" % c)
    return "".join(out)

def wrap_url(target: str) -> str:
    esc = js_escape(target)
    b64 = base64.b64encode(esc.encode()).decode()
    cb  = f"{int(time.time()*1000)}.{random.randint(0,999999):06d}"
    return f"https://p.pcdelv.com/go/{UID}/{WID}/{b64}?cb={cb}"  # Start with HTTPS

async def main():
    # --- Rnet client with Chrome137 JA3 / ALPN ---
    # Use desktop fingerprinting only
    c = Client(impersonate=Impersonate.Chrome137, proxy=os.getenv('PROXY'))
    print("   Using Chrome137 desktop fingerprint")

    # 1  load globalstreaming.lol, popcash script sends empty XHR
    print("1. Loading globalstreaming.lol...")
    r1 = await c.get(TARGET)
    print(f"   Status: {r1.status_code}")
    
    print("2. Sending empty XHR to znWaa3gu...")
    r2 = await c.get("https://dcba.popcash.net/znWaa3gu")
    print(f"   Status: {r2.status_code}")

    print("3. User clicks, new tab opens...")
    r3 = await c.get(TARGET)
    print(f"   Status: {r3.status_code}")

    # 4  GET /go with proper navigation headers (may redirect or return JS directly)  
    go_url = wrap_url(TARGET)  # start with HTTPS (HSTS preload behavior)
    print(f"4. GET /go: {go_url}")
    
    print("   Waiting for 2 seconds...")
    time.sleep(2)
    r_go = await c.get(go_url, headers=NAV_HEADERS, allow_redirects=False)
    print(f"   go() status: {r_go.status_code} → {r_go.headers.get('Location')}")
    
    # Check if we got a redirect or direct JS content
    status = int(str(r_go.status_code))
    if status in [301, 302, 303, 307, 308]:
        location = r_go.headers.get("Location")
        if isinstance(location, bytes):
            location = location.decode('utf-8')
        https_url = location
        print(f"   ✅ Got redirect! Following to: {https_url}")
        need_redirect_follow = True
    elif status == 200:
        print("   ✅ Got direct JS response!")
        text = await r_go.text()
        if 'top.location.href' in text:
            print(f"   Response length: {len(text)} chars")
            need_redirect_follow = False
            https_url = go_url  # Use original URL as base
        else:
            print("   No JS found in 200 response")
            print(f"   Response: {text[:200]}...")
            return
    else:
        print(f"   ⚠️ Unexpected status: {status}")
        text = await r_go.text()
        print(f"   Response: {text[:200]}...")
        return

    # 5  follow redirects if needed, otherwise use direct JS response
    if need_redirect_follow:
        print("5. Following redirect chain...")
        current_url = https_url
        redirect_count = 0
        
        while redirect_count < 2:  # Reduced max redirects for faster failure
            # Update headers for each hop
            cross_site_headers = {**CROSS_SITE, "Referer": go_url}
            r_js = await c.get(current_url, headers=cross_site_headers, allow_redirects=False)
            print(f"   Hop {redirect_count + 1}: {r_js.status_code} from {current_url}")
            
            # Read the body once so rnet commits Set-Cookie
            await r_js.read()
            
            if 300 <= int(str(r_js.status_code)) < 400:
                # Another redirect
                next_location = r_js.headers.get("Location")
                if isinstance(next_location, bytes):
                    next_location = next_location.decode('utf-8')
                print(f"     → Redirects to: {next_location}")
                    
                current_url = next_location
                redirect_count += 1
            else:
                # Got final content
                break
        
        if redirect_count >= 2:
            print("   ⚠️ Too many redirects, stopping")
            return
        
        text = await r_js.text()
        print(f"   Final response length: {len(text)} chars")
        https_url = current_url  # Use final URL as base
    else:
        print("5. Using direct JS response...")
        # text is already set from step 4
    
    # Look for the JS redirect
    path_match = re.search(r'top\.location\.href="([^"]+)"', text)
    if not path_match:
        path_match = re.search(r'href="([^"]+)"', text)
    
    if path_match:
        path = path_match.group(1)
        print(f"   Extracted path: {path}")
    else:
        print("   ERROR: Could not extract path from JS")
        print(f"   Response content: {text[:200]}...")
        return

    # 6  GET to /cl with same-origin headers (302 redirect to advertiser)
    cl_url = urljoin(https_url, path)
    print(f"6. Making request to /cl: {cl_url}")
    
    # Second hop: same-origin, so flip Sec-Fetch-Site
    same_origin_headers = {**SAME_ORIGIN, "Referer": https_url}
    r_cl = await c.get(cl_url, headers=same_origin_headers, allow_redirects=False)
    print(f"   cl() status: {r_cl.status_code} → {r_cl.headers.get('Location')[:70]}")
    
    # Check Content-Length before reading body
    content_length_header = r_cl.headers.get('Content-Length', b'0')
    if isinstance(content_length_header, bytes):
        content_length_header = content_length_header.decode('utf-8')
    content_length = int(content_length_header)
    if content_length > 50_000:
        print("Landing page too large – aborting")
        return

    # 7  skip advertiser redirect to save bandwidth
    location = r_cl.headers.get('Location')
    if isinstance(location, bytes):
        location = location.decode('utf-8')
    if int(str(r_cl.status_code)) in [301, 302, 303, 307, 308] and location:
        print(f"   Would redirect to: {location[:70]}")
    else:
        print(f"   Unexpected response: {r_cl.status_code}")
    
    print("Flow completed")

if __name__ == "__main__":
    asyncio.run(main())