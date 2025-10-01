import { ProxyAgent } from '@/network/proxy'
import { fetch } from 'undici'
import { PROXY_HOST, PROXY_PASS, PROXY_PORT, PROXY_USER } from '@/config'

export async function detectGeoViaProxy(proxyPort: number): Promise<{ countryCode: string, timezone: string, lat: number, lon: number }> {
  const url = 'http://ip-api.com/json?fields=status,countryCode,timezone,lat,lon'
  const upstreamProxyAuth = (PROXY_USER && PROXY_PASS) ? `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@` : ''
  const dispatcher = new ProxyAgent(`http://${upstreamProxyAuth}${PROXY_HOST}:${proxyPort}`)
  const response = await fetch(url, { dispatcher })
  if (!response.ok) {
    throw new Error(`Geo lookup HTTP ${response.status}`)
  }
  const info: any = await response.json()
  if (info && info.status === 'success' && info.countryCode && info.timezone) {
    return { countryCode: String(info.countryCode), timezone: String(info.timezone), lat: Number(info.lat), lon: Number(info.lon) }
  }
  throw new Error('Geo lookup failed')
}

export function localeFromCountry(countryCode: string): string {
  const cc = (countryCode || 'US').toUpperCase()
  switch (cc) {
    case 'US': return 'en-US'
    case 'GB': return 'en-GB'
    case 'CA': return 'en-CA'
    case 'AU': return 'en-AU'
    case 'NZ': return 'en-NZ'
    case 'IE': return 'en-IE'
    case 'SG': return 'en-SG'
    case 'AE': return 'ar-AE'
    case 'SA': return 'ar-SA'
    case 'QA': return 'ar-QA'
    case 'KW': return 'ar-KW'
    case 'SE': return 'sv-SE'
    case 'FI': return 'fi-FI'
    case 'NO': return 'nb-NO'
    case 'DK': return 'da-DK'
    case 'NL': return 'nl-NL'
    case 'DE': return 'de-DE'
    case 'AT': return 'de-AT'
    case 'CH': return 'de-CH'
    case 'FR': return 'fr-FR'
    case 'ES': return 'es-ES'
    case 'MX': return 'es-MX'
    case 'PT': return 'pt-PT'
    case 'BR': return 'pt-BR'
    case 'IT': return 'it-IT'
    case 'PL': return 'pl-PL'
    case 'JP': return 'ja-JP'
    case 'KR': return 'ko-KR'
    case 'HK': return 'zh-HK'
    case 'TW': return 'zh-TW'
    case 'IL': return 'he-IL'
    case 'BE': return 'nl-BE'
    default: return `en-${cc}`
  }
}


