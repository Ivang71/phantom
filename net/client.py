import os, asyncio
from rnet import Client as RnetClient, Emulation as RnetEmulation

class RnetBrowser:
    def __init__(self, user_agent: str, proxy: str | None):
        self.user_agent = user_agent
        if proxy:
            os.environ['HTTP_PROXY'] = proxy
            os.environ['HTTPS_PROXY'] = proxy
        else:
            os.environ.pop('HTTP_PROXY', None)
            os.environ.pop('HTTPS_PROXY', None)
        self.client = RnetClient(emulation=RnetEmulation.Chrome124)

    async def get(self, url: str, headers: dict, timeout: int = 10) -> dict:
        h = dict(headers)
        h['User-Agent'] = self.user_agent
        resp = await self.client.get(url, headers=h, timeout=timeout)
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


