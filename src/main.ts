import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
const UserAgent = require('user-agents')
import { config as loadEnv } from 'dotenv'

chromium.use(StealthPlugin())
loadEnv()

const PROXY_USER = process.env.PROXY_USER
const PROXY_PASS = process.env.PROXY_PASS
const PROXY_HOST = process.env.PROXY_HOST
const PROXY_PORT_START = 10000
const MAX_ITERATIONS = 10

const TARGET_URL = 'https://globalstreaming.lol/'

async function visitSite(proxyPort: number): Promise<void> {
  let proxyConfig: any = undefined
  if (PROXY_HOST && proxyPort) {
    proxyConfig = {
      server: `http://${PROXY_HOST}:${proxyPort}`,
      ...(PROXY_USER && PROXY_PASS && {
        username: PROXY_USER,
        password: PROXY_PASS
      })
    }
  }
  const browser = await chromium.launch({
    headless: false, // dev only
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ...(proxyConfig && { proxy: proxyConfig })
  })

  const userAgent = new UserAgent({ deviceCategory: 'desktop' })
  const context = await browser.newContext({
    userAgent: userAgent.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation']
  })

  const page = await context.newPage()
  
  context.on('page', async (newPage) => {
    setTimeout(async () => {
      try {
        if (!newPage.isClosed()) {
          await newPage.close()
        }
      } catch (e) {}
    }, 500)
  })
  
  await page.addInitScript(() => {
    delete (window as any).navigator.webdriver
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    (window as any).chrome = { runtime: {} };
  })
  
  page.setDefaultTimeout(30000)
  page.setDefaultNavigationTimeout(30000)

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)
  
  if (page.isClosed()) return

  let targetDiv = null
  try {
    const divs = await page.$$('div')
    
    for (const div of divs) {
      const style = await div.getAttribute('style')
      if (style && style.includes('z-index') && (style.includes('9999999') || style.includes('position:fixed'))) {
        targetDiv = div
        break
      }
    }
  } catch (e) {
    return
  }
  
  if (!targetDiv) {
    const triggerActions = [
      () => page.click('body'),
      () => page.mouse.move(500, 500),
      () => page.mouse.wheel(0, 100),
      () => page.keyboard.press('Space'),
      () => page.hover('a[href="/"]'),
      () => page.evaluate(() => window.scrollTo(0, 100))
    ]
    
    for (let attempt = 0; attempt < 10; attempt++) {
      const action = triggerActions[attempt % triggerActions.length]
      try { await action() } catch (e) {}
      await page.waitForTimeout(2000)
      
      try {
        const newDivs = await page.$$('div')
        for (const div of newDivs) {
          const style = await div.getAttribute('style')
          if (style && style.includes('z-index') && (style.includes('9999999') || style.includes('position:fixed'))) {
            targetDiv = div
            break
          }
        }
      } catch (e) {
        break
      }
      
      if (targetDiv || page.url() !== TARGET_URL) break
    }
  }
  
  if (!targetDiv) {
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000)
      if (page.url() !== TARGET_URL) break
    }
    if (page.url() === TARGET_URL) {
      await browser.close()
      return
    }
  }
  
  if (targetDiv) {
    try {
      if (!page.isClosed() && page.url() === TARGET_URL) {
        await page.evaluate((element) => {
          const div = element as HTMLElement
          div.style.display = 'block'
          div.style.visibility = 'visible'
          div.style.opacity = '1'
        }, targetDiv)
      }
    } catch (e) {}
    
    await page.waitForTimeout(500)
    
    for (let i = 0; i < 5; i++) {
      if (page.isClosed() || page.url() !== TARGET_URL) break
      
      try { 
        if (!page.isClosed()) {
          await targetDiv.click({ force: true }) 
        }
      } catch (e) {}
      
      // Check for URL change after click
      await page.waitForTimeout(500)
      const currentUrl = page.url()
      if (currentUrl !== TARGET_URL) {
        if (currentUrl.includes('p.pcdelv.com')) {
          await browser.close()
          return
        }
        break
      }
      
      try {
        if (!page.isClosed() && page.url() === TARGET_URL) {
          await page.evaluate((element) => {
            const div = element as HTMLElement
            div.click()
            const events = ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']
            events.forEach(eventType => {
              div.dispatchEvent(new MouseEvent(eventType, {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: 100,
                clientY: 100
              }))
            })
          }, targetDiv)
        }
      } catch (e) {}
      
      // Check for URL change after evaluate
      await page.waitForTimeout(300)
      const urlAfterEvaluate = page.url()
      if (urlAfterEvaluate !== TARGET_URL) {
        if (urlAfterEvaluate.includes('p.pcdelv.com')) {
          await browser.close()
          return
        }
        break
      }
      
      try {
        if (targetDiv && !page.isClosed()) {
          const box = await targetDiv.boundingBox()
          if (box) {
            await page.mouse.click(box.x + box.width/2, box.y + box.height/2)
          }
        }
      } catch (e) {}
      
      await page.waitForTimeout(800)
      if (page.url() !== TARGET_URL) break
    }
    
    try {
      if (!page.isClosed() && page.url() === TARGET_URL) {
        await page.waitForSelector('div[style*="z-index:9999999"]', { state: 'visible', timeout: 5000 })
        const visibleDiv = await page.$('div[style*="z-index:9999999"]')
        if (visibleDiv && !page.isClosed()) {
          await visibleDiv.click()
          await page.waitForTimeout(2000)
        }
      }
    } catch (e) {}
    
    try {
      if (!page.isClosed()) {
        await page.click('body')
        await page.waitForTimeout(1000)
        await page.keyboard.press('Space')
        await page.waitForTimeout(1000)
        await page.mouse.wheel(0, 500)
        await page.waitForTimeout(2000)
        await page.waitForTimeout(600)
      }
    } catch (e) {}
  }
  
  await page.waitForURL(url => {
    const currentUrl = url.toString()
    if (currentUrl !== TARGET_URL) {
      // Check if URL contains p.pcdelv.com - if so, close immediately
      if (currentUrl.includes('p.pcdelv.com')) {
        setTimeout(async () => {
          try {
            await browser.close()
          } catch (e) {}
        }, 1000)
        return true
      }
      // For other URLs, wait a bit then close
      setTimeout(async () => {
        try {
          await page.waitForLoadState('networkidle', { timeout: 5000 })
          await browser.close()
        } catch (e) {}
      }, 2000)
      return true
    }
    return false
  }, {
    waitUntil: 'commit',
    timeout: 30000
  }).catch(async () => {
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 })
      await browser.close()
    } catch (e) {}
  })

  try {
    await browser.close()
  } catch (e) {}
}

async function main(): Promise<void> {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const currentProxyPort = PROXY_PORT_START + i
    console.log(`Iteration ${i + 1}/${MAX_ITERATIONS} - Using proxy port: ${currentProxyPort}`)
    
    try {
      await visitSite(currentProxyPort)
    } catch (error) {
      console.error(`Error in iteration ${i + 1}:`, error)
    }
    
    if (i < MAX_ITERATIONS - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
