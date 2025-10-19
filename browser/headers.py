import os

def _effective_accept_language(override: str | None) -> str:
    if override and override.strip():
        return override
    return os.environ.get('ACCEPT_LANGUAGE', 'en-US,en;q=0.9')


def _sec_ch_headers(major: int, platform: str, mobile: str) -> dict:
    # Hardcode Android Chrome brands format akin to HAR
    secch = f'"Google Chrome";v="{major}", "Not?A_Brand";v="8", "Chromium";v="{major}"'
    return {
        'sec-ch-ua': secch,
        'sec-ch-ua-mobile': mobile,
        'sec-ch-ua-platform': f'"{platform}"',
    }


def chrome_nav_headers(referer: str, site: str, major: int = 140, platform: str = 'Windows', mobile: str = '?0', accept_language: str | None = None) -> dict:
    base = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': _effective_accept_language(accept_language),
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': site,
        'sec-fetch-user': '?1',
        'priority': 'u=0, i',
        'upgrade-insecure-requests': '1',
        'Referer': referer,
    }
    # Always send DNT for Android flow
    base['DNT'] = '1'
    base.update(_sec_ch_headers(major, platform, mobile))
    return base


def chrome_script_headers(referer: str, major: int = 140, platform: str = 'Windows', mobile: str = '?0', accept_language: str | None = None) -> dict:
    base = {
        'Accept': '*/*',
        'Accept-Language': _effective_accept_language(accept_language),
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-fetch-dest': 'script',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-storage-access': 'none',
        'Referer': referer,
    }
    base['DNT'] = '1'
    base.update(_sec_ch_headers(major, platform, mobile))
    return base


def chrome_xhr_headers(referer: str, origin: str, site: str, major: int = 140, platform: str = 'Windows', mobile: str = '?0', accept_language: str | None = None) -> dict:
    base = {
        'Accept': '*/*',
        'Accept-Language': _effective_accept_language(accept_language),
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': site,
        'Origin': origin,
        'Referer': referer,
        'priority': 'u=1, i',
    }
    base['DNT'] = '1'
    base.update(_sec_ch_headers(major, platform, mobile))
    return base


