import os, asyncio


class TlsBrowser:
    def __init__(self, user_agent: str, proxy: str | None):
        self.user_agent = user_agent
        self.proxy = proxy
        try:
            import tls_client  # type: ignore
        except Exception as e:
            raise RuntimeError("tls-client python bindings are required. Install with: pip install tls-client") from e
        profile = os.environ.get("TLS_CLIENT_PROFILE", "chrome_140")
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
        MAX_BYTES = 8192
        # Try streaming if library supports it; fall back to full fetch
        body = b''
        text = ''
        resp = None
        aborted_at_cap = False
        try:
            # Attempt streaming mode akin to requests; tls-client may support stream
            resp = await asyncio.to_thread(getattr(self.session, method), url, stream=True, **kwargs)
            try:
                iter_content = getattr(resp, 'iter_content', None)
                if callable(iter_content):
                    for chunk in iter_content(chunk_size=2048):
                        if not chunk:
                            break
                        # Accumulate up to MAX_BYTES, then stop
                        remaining = MAX_BYTES - len(body)
                        if remaining <= 0:
                            aborted_at_cap = True
                            break
                        body += bytes(chunk[:remaining])
                        if len(body) >= MAX_BYTES:
                            aborted_at_cap = True
                            break
                    # Ensure underlying connection is closed if there is any remaining
                    try:
                        close = getattr(resp, 'close', None)
                        if callable(close):
                            close()
                    except Exception:
                        pass
                else:
                    # Fallback to non-streaming if iter_content unavailable
                    raise RuntimeError('streaming_not_supported')
            except Exception:
                # Fallback: perform normal request and slice
                resp = await asyncio.to_thread(getattr(self.session, method), url, **kwargs)
                try:
                    content = resp.content if getattr(resp, 'content', None) is not None else b''
                except Exception:
                    content = b''
                try:
                    body = bytes(content[:MAX_BYTES])
                except Exception:
                    body = b''
                try:
                    aborted_at_cap = isinstance(content, (bytes, bytearray)) and len(content) > MAX_BYTES
                except Exception:
                    aborted_at_cap = False
        except Exception:
            # Ultimate fallback if streaming kw not accepted
            resp = await asyncio.to_thread(getattr(self.session, method), url, **kwargs)
            try:
                content = resp.content if getattr(resp, 'content', None) is not None else b''
            except Exception:
                content = b''
            try:
                body = bytes(content[:MAX_BYTES])
            except Exception:
                body = b''
            try:
                aborted_at_cap = isinstance(content, (bytes, bytearray)) and len(content) > MAX_BYTES
            except Exception:
                aborted_at_cap = False
        # Derive text cheaply from capped body
        try:
            text = str(getattr(resp, 'text'))
        except Exception:
            try:
                text = body.decode('utf-8', errors='ignore')
            except Exception:
                text = ''
        hdrs = {}
        set_cookie_values: list[str] = []
        try:
            # collect headers (lowercased) and try to preserve multiple Set-Cookie
            get_all = getattr(resp.headers, 'get_all', None)
            if callable(get_all):
                sc_list = get_all('set-cookie') or get_all('Set-Cookie') or []
                set_cookie_values.extend([str(x) for x in sc_list])
            for k, v in resp.headers.items():
                kl = str(k).lower()
                hdrs[kl] = v
                if kl == 'set-cookie':
                    if isinstance(v, (list, tuple)):
                        set_cookie_values.extend([str(x) for x in v])
                    elif v is not None:
                        set_cookie_values.append(str(v))
        except Exception:
            pass
        try:
            final_url = str(resp.url)
        except Exception:
            final_url = url
        status = getattr(resp, 'status_code', None)
        # Best-effort dump of cookie jar
        jar_cookies: list[str] = []
        try:
            jar = getattr(self.session, 'cookies', None)
            if isinstance(jar, dict):
                for k, v in jar.items():
                    jar_cookies.append(f"{k}={v}")
            elif jar is not None:
                # try iterable of cookie-like objects
                for c in jar:
                    try:
                        name = getattr(c, 'name', None)
                        value = getattr(c, 'value', None)
                        if name is not None and value is not None:
                            jar_cookies.append(f"{name}={value}")
                    except Exception:
                        continue
        except Exception:
            pass
        return { 'status': status, 'url': final_url, 'headers': hdrs, 'content': body, 'text': text, 'set_cookies': set_cookie_values, 'jar_cookies': jar_cookies, 'aborted_at_cap': aborted_at_cap }

    async def get(self, url: str, headers: dict, timeout: int = 10) -> dict:
        return await self._do('get', url, headers, timeout, follow=False)

    # follow variant currently unused; keep minimal surface
