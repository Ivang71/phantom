import os

ACCEPT_LANGUAGE = os.environ.get('ACCEPT_LANGUAGE', 'en-US,en;q=0.9')

def set_accept_language(value: str) -> None:
    global ACCEPT_LANGUAGE
    ACCEPT_LANGUAGE = value or 'en-US,en;q=0.9'


def _sec_ch_headers(major: int, platform: str, mobile: str) -> dict:
    include_google = os.environ.get('SECCH_GOOGLE_BRAND', '0') == '1'
    if include_google:
        secch = f'"Chromium";v="{major}", "Not=A?Brand";v="24", "Google Chrome";v="{major}"'
    else:
        secch = f'"Not=A?Brand";v="24", "Chromium";v="{major}"'
    return {
        'sec-ch-ua': secch,
        'sec-ch-ua-mobile': mobile,
        'sec-ch-ua-platform': f'"{platform}"',
    }


def chrome_nav_headers(referer: str, site: str, major: int = 140, platform: str = 'Windows', mobile: str = '?0') -> dict:
    base = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': ACCEPT_LANGUAGE,
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
    base.update(_sec_ch_headers(major, platform, mobile))
    return base


def chrome_script_headers(referer: str, major: int = 140, platform: str = 'Windows', mobile: str = '?0') -> dict:
    base = {
        'Accept': '*/*',
        'Accept-Language': ACCEPT_LANGUAGE,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-fetch-dest': 'script',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-storage-access': 'none',
        'Referer': referer,
    }
    base.update(_sec_ch_headers(major, platform, mobile))
    return base


def chrome_xhr_headers(referer: str, origin: str, site: str, major: int = 140, platform: str = 'Windows', mobile: str = '?0') -> dict:
    base = {
        'Accept': '*/*',
        'Accept-Language': ACCEPT_LANGUAGE,
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
    base.update(_sec_ch_headers(major, platform, mobile))
    return base


