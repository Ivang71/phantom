import { webkit, devices, Browser } from 'playwright'
import { config as loadEnv } from 'dotenv'
import { parse as parseUrl } from 'node:url'

loadEnv()
const PROXY_USER = process.env.PROXY_USER
const PROXY_PASS = process.env.PROXY_PASS
const PROXY_HOST = process.env.PROXY_HOST
const PROXY_PORT = process.env.PROXY_PORT

let proxyConfig: any = undefined
if (PROXY_HOST && PROXY_PORT) {
  proxyConfig = {
    server: `http://${PROXY_HOST}:${PROXY_PORT}`,
    ...(PROXY_USER && PROXY_PASS && {
      username: PROXY_USER,
      password: PROXY_PASS
    })
  }
}

const START =
  'http://p.pcdelv.com/go/495017/746009/aHR0cHMlM0EvL2dsb2JhbHN0cmVhbWluZy5sb2wv?cb=9658968775861596'

async function main(): Promise<void> {
  /* --- launch lightweight WebKit with proxy --- */
  const browser = await webkit.launch({
    headless: false,
    ...(proxyConfig && { proxy: proxyConfig })
  })

  /* emulate minimal desktop UA (optional, but avoids "Mobile Safari" look) */
  const desktop = devices['Desktop Safari'] || devices['Desktop Chrome']   // built-in desktop profile
  const context = await browser.newContext({
    ...desktop, // only userAgent/viewport/headers keeps the context lean
  })

  const page = await context.newPage()

  await page.goto(START, { waitUntil: 'domcontentloaded' })

  /* follow redirects until host !== p.pcdelv.com */
  await page.waitForURL(url => parseUrl(url.toString(), true).hostname !== 'p.pcdelv.com', {
    waitUntil: 'commit'
  })

  console.log('✅ final URL:', page.url())
  await browser.close()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
