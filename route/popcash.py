import re, time, random
import urllib.parse as u

CL_RE = re.compile(r'https?://p\.pcdelv\.com/v2/[^"\']+/cl\b', re.I)
TOP_LOC_RE = re.compile(r"top\.location\.href\s*=\s*['\"]([^'\"]+)['\"]", re.I)
DCBA_RE = re.compile(r"https?://dcba\.popcash\.net/[A-Za-z0-9]+", re.I)

def build_go(target: str, uid: str, wid: str) -> str:
    esc = u.quote(target.encode('latin-1','backslashreplace').decode(), safe="~()*!.'")
    import base64
    b64 = base64.b64encode(esc.encode()).decode()
    cb  = f"{int(time.time()*1000)}.{random.randint(0,1_000_000)}"
    return f"https://p.pcdelv.com/go/{uid}/{wid}/{b64}?cb={cb}"

def next_url_from(resp_url: str, headers: dict, text: str) -> str | None:
    loc = headers.get('location') or headers.get('Location')
    if loc:
        return u.urljoin(resp_url, loc)
    m = TOP_LOC_RE.search(text or '')
    if m:
        return u.urljoin(resp_url, m.group(1))
    return None

def extract_probe(text: str) -> str | None:
    m = DCBA_RE.search(text or '')
    return m.group(0) if m else None


