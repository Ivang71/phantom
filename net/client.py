import os, asyncio


class TlsBrowser:
    def __init__(self, user_agent: str, proxy: str | None):
        self.user_agent = user_agent
        self.proxy = proxy
        try:
            import tls_client  # type: ignore
        except Exception as e:
            raise RuntimeError("tls-client python bindings are required. Install with: pip install tls-client") from e
        profile = os.environ.get("TLS_CLIENT_PROFILE", "chrome_120")
        self._tls_mod = tls_client  # type: ignore
        self.session = tls_client.Session(
            client_identifier=profile,
            random_tls_extension_order=True,
        )

    async def _do(self, method: str, url: str, headers: dict, timeout: int, follow: bool) -> dict:
        h = dict(headers)
        h['User-Agent'] = self.user_agent
        kwargs = {
            'headers': h,
            'allow_redirects': follow,
            'timeout_seconds': timeout,
        }
        if self.proxy:
            kwargs['proxy'] = self.proxy
        resp = await asyncio.to_thread(getattr(self.session, method), url, **kwargs)
        try:
            body = bytes(resp.content) if resp.content is not None else b''
        except Exception:
            body = b''
        try:
            text = str(resp.text)
        except Exception:
            try:
                text = body.decode('utf-8', errors='ignore')
            except Exception:
                text = ''
        hdrs = {}
        try:
            for k, v in resp.headers.items():
                hdrs[str(k).lower()] = v
        except Exception:
            pass
        try:
            final_url = str(resp.url)
        except Exception:
            final_url = url
        status = getattr(resp, 'status_code', None)
        return { 'status': status, 'url': final_url, 'headers': hdrs, 'content': body, 'text': text }

    async def get(self, url: str, headers: dict, timeout: int = 10) -> dict:
        return await self._do('get', url, headers, timeout, follow=False)

    async def get_follow(self, url: str, headers: dict, timeout: int = 10) -> dict:
        return await self._do('get', url, headers, timeout, follow=True)
