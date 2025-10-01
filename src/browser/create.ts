import { chromium } from 'playwright-extra'
import { PROXY_HOST, PROXY_PASS, PROXY_PORT, PROXY_USER } from '@/config'

export async function createBrowserWithProxy(proxyPort: number) {
  const proxyConfig: any = {
    server: `http://${PROXY_HOST}:${proxyPort}`,
    ...(PROXY_USER && PROXY_PASS && { username: PROXY_USER, password: PROXY_PASS })
  }

  return await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-variations',
      '--disable-quic',
      '--dns-prefetch-disable',
      '--disable-features=PreconnectToOrigins,PrefetchPrivacyChanges',
      '--disable-features=DnsOverHttps,AsyncDns',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-extensions',
      '--disable-web-security',
      '--fast-start',
      '--disable-blink-features=AutomationControlled',
      '--enable-blink-features=IdleDetection',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=VizDisplayCompositor',
      '--ignore-certificate-errors'
    ],
    proxy: proxyConfig
  })
}


