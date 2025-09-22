import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
const UserAgent = require('user-agents')
import { config as loadEnv } from 'dotenv'
import * as os from 'os'

chromium.use(StealthPlugin())
loadEnv()

const PROXY_USER = process.env.PROXY_USER
const PROXY_PASS = process.env.PROXY_PASS
const PROXY_HOST = process.env.PROXY_HOST
const PROXY_PORT_START = 10000
const MAX_ITERATIONS = 10

const TARGET_URL = 'https://globalstreaming.lol/'

function getMemoryUsage() {
  const used = process.memoryUsage()
  return {
    rss: Math.round(used.rss / 1024 / 1024 * 100) / 100, // MB
    heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100, // MB
    heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100, // MB
    external: Math.round(used.external / 1024 / 1024 * 100) / 100 // MB
  }
}

function getCpuUsage() {
  const cpus = os.cpus()
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0
  
  for (const cpu of cpus) {
    user += cpu.times.user
    nice += cpu.times.nice
    sys += cpu.times.sys
    idle += cpu.times.idle
    irq += cpu.times.irq
  }
  
  const total = user + nice + sys + idle + irq
  return {
    user: Math.round((user / total) * 100 * 100) / 100,
    system: Math.round((sys / total) * 100 * 100) / 100,
    idle: Math.round((idle / total) * 100 * 100) / 100,
    usage: Math.round(((total - idle) / total) * 100 * 100) / 100
  }
}

function getSystemInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100, // GB
    freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100, // GB
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg().map(load => Math.round(load * 100) / 100)
  }
}

async function createBrowserWithProxy(proxyPort: number) {
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
  
  return await chromium.launch({
    headless: false, // dev only
    args: [
      '--no-first-run', 
      '--disable-blink-features=AutomationControlled',
      '--fast-start',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    ...(proxyConfig && { proxy: proxyConfig })
  })
}

async function visitSite(proxyPort: number): Promise<void> {
  const browser = await createBrowserWithProxy(proxyPort)

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
  console.log('=== System Information ===')
  const sysInfo = getSystemInfo()
  console.log(`Platform: ${sysInfo.platform} ${sysInfo.arch}`)
  console.log(`CPU Cores: ${sysInfo.cpuCount}`)
  console.log(`Total Memory: ${sysInfo.totalMemory} GB`)
  console.log(`Free Memory: ${sysInfo.freeMemory} GB`)
  console.log(`Load Average: [${sysInfo.loadAvg.join(', ')}]`)
  console.log('==============================\n')

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const currentProxyPort = PROXY_PORT_START + i
    console.log(`\n🚀 Iteration ${i + 1}/${MAX_ITERATIONS} - Proxy port: ${currentProxyPort}`)
    
    const memBefore = getMemoryUsage()
    const cpuBefore = getCpuUsage()
    const startTime = Date.now()
    
    try {
      await visitSite(currentProxyPort)
      const duration = Date.now() - startTime
      const memAfter = getMemoryUsage()
      const cpuAfter = getCpuUsage()
      
      console.log(`✅ Iteration ${i + 1} completed in ${duration}ms`)
      console.log(`📊 Memory: RSS ${memAfter.rss}MB (Δ${(memAfter.rss - memBefore.rss).toFixed(1)}MB), Heap ${memAfter.heapUsed}MB`)
      console.log(`🖥️  CPU: ${cpuAfter.usage}% usage, Load: [${os.loadavg().map(l => l.toFixed(2)).join(', ')}]`)
      console.log(`💾 System Memory: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)}GB free`)
      
    } catch (error) {
      console.error(`❌ Error in iteration ${i + 1}:`, error)
      const memAfter = getMemoryUsage()
      console.log(`📊 Memory after error: RSS ${memAfter.rss}MB, Heap ${memAfter.heapUsed}MB`)
    }
    
    // Shorter delay between iterations for efficiency
    if (i < MAX_ITERATIONS - 1) {
      console.log(`⏳ Waiting 1s before next iteration...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  
  console.log('\n🏁 All iterations completed!')
  const finalMem = getMemoryUsage()
  const finalCpu = getCpuUsage()
  console.log(`📊 Final Memory: RSS ${finalMem.rss}MB, Heap ${finalMem.heapUsed}MB`)
  console.log(`🖥️  Final CPU: ${finalCpu.usage}% usage`)
  console.log(`💾 Final System Memory: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)}GB free`)
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
