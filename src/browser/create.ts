import { chromium } from 'playwright-extra'


export async function launchBrowserWithLocalPort(localPort: number) {
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
    proxy: { server: `http://127.0.0.1:${localPort}` }
  })
}


