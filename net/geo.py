from typing import Optional


def locale_from_country(country_code: Optional[str]) -> str:
    cc = (country_code or "US").upper()
    mapping = {
        "US": "en-US",
        "GB": "en-GB",
        "CA": "en-CA",
        "AU": "en-AU",
        "NZ": "en-NZ",
        "IE": "en-IE",
        "SG": "en-SG",
        "AE": "ar-AE",
        "SA": "ar-SA",
        "QA": "ar-QA",
        "KW": "ar-KW",
        "SE": "sv-SE",
        "FI": "fi-FI",
        "NO": "nb-NO",
        "DK": "da-DK",
        "NL": "nl-NL",
        "DE": "de-DE",
        "AT": "de-AT",
        "CH": "de-CH",
        "FR": "fr-FR",
        "ES": "es-ES",
        "MX": "es-MX",
        "PT": "pt-PT",
        "BR": "pt-BR",
        "IT": "it-IT",
        "PL": "pl-PL",
        "JP": "ja-JP",
        "KR": "ko-KR",
        "HK": "zh-HK",
        "TW": "zh-TW",
        "IL": "he-IL",
        "BE": "nl-BE",
    }
    if cc in mapping:
        return mapping[cc]
    return f"en-{cc}"


def accept_language_header_from_locale(locale: str) -> str:
    # Compose header like "fr-FR,fr;q=0.9" or fallback to en
    try:
        lang = locale.split("-")[0]
        return f"{locale},{lang};q=0.9"
    except Exception:
        return "en-US,en;q=0.9"


