import { chromium } from 'playwright-extra'
// Removed stealth plugin - causing too many errors with page creation
const UserAgent = require('user-agents')
import { config as loadEnv } from 'dotenv'
import * as os from 'os'

loadEnv()

const PROXY_USER = process.env.PROXY_USER
const PROXY_PASS = process.env.PROXY_PASS
const PROXY_HOST = process.env.PROXY_HOST
const PROXY_PORT_START = 10100
const PROXY_PORT_END = 20000
const MAX_ITERATIONS = 1000000000

const TARGET_URL = 'https://globalstreaming.lol/'

// Cache for frequently requested files
const fileCache = new Map<string, { content: Buffer, contentType: string }>()
const CACHED_FILES = [
  'https://cdn.popcash.net/show.js',
  'https://globalstreaming.lol/'
]

function getMemoryUsage() {
  const used = process.memoryUsage()
  return {
    rss: Math.round(used.rss / 1024 / 1024 * 100) / 100, // MB
    heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100, // MB
    heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100, // MB
    external: Math.round(used.external / 1024 / 1024 * 100) / 100 // MB
  }
}


function getSystemInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100, // GB
    freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100, // GB
    cpuCount: os.cpus().length
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
    headless: true, // dev only
    args: [
      '--no-first-run', 
      '--disable-blink-features=AutomationControlled',
      '--fast-start',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ],
    ...(proxyConfig && { proxy: proxyConfig })
  })
}

async function visitSite(proxyPort: number): Promise<{ bytesSent: number, bytesReceived: number }> {
  const browser = await createBrowserWithProxy(proxyPort)
  let totalBytesSent = 0
  let totalBytesReceived = 0
  let isClosing = false

  const userAgent = new UserAgent({ deviceCategory: 'desktop' })
  const context = await browser.newContext({
    userAgent: userAgent.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation']
  })

  const page = await context.newPage()
  
  // Whitelist of allowed domains and their subdomains
  const ALLOWED_DOMAINS = ['globalstreaming.lol', 'pcdelv.com', 'popcash.net']
  
  const isAllowedDomain = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      return ALLOWED_DOMAINS.some(domain => 
        hostname === domain || hostname.endsWith('.' + domain)
      )
    } catch {
      return false
    }
  }
  
  // Block all domains except whitelisted ones, allow only HTML, JS, and XHR
  // Also handle caching for specific files
  await page.route('**/*', async (route) => {
    const request = route.request()
    const resourceType = request.resourceType()
    const url = request.url()
    const allowedTypes = ['document', 'script', 'xhr', 'fetch']
    
    // Block any domain not in whitelist
    if (!isAllowedDomain(url)) {
      console.log(`[BLOCKED] Non-whitelisted domain: ${url}`)
      await route.abort()
      return
    }
    
    if (!allowedTypes.includes(resourceType)) {
      route.abort()
      return
    }
    
    // Check if this file should be cached
    if (CACHED_FILES.includes(url)) {
      if (fileCache.has(url)) {
        // Serve from cache
        const cached = fileCache.get(url)!
        console.log(`[CACHE HIT] Serving ${url} from cache (${formatBytes(cached.content.length)})`)
        await route.fulfill({
          status: 200,
          contentType: cached.contentType,
          body: cached.content
        })
        return
      } else {
        // First time - fetch and cache
        console.log(`[CACHE MISS] Fetching ${url} for caching`)
      }
    }
    
    route.continue()
  })
  
  // Track network requests for data measurement (excluding cache hits)
  page.on('request', (request) => {
    const resourceType = request.resourceType()
    const allowedTypes = ['document', 'script', 'xhr', 'fetch']
    
    // Only count allowed requests
    if (allowedTypes.includes(resourceType)) {
      const url = request.url()
      const method = request.method()
      const postData = request.postData()
      const urlSize = Buffer.byteLength(request.url(), 'utf8')
      const postSize = postData ? Buffer.byteLength(postData, 'utf8') : 0
      const headerSize = 200 // estimate
      const totalSent = urlSize + postSize + headerSize
      
      // Check if this will be served from cache
      const willBeCacheHit = CACHED_FILES.includes(url) && fileCache.has(url)
      
      console.log(`[REQUEST] ${resourceType.toUpperCase()} ${method} ${url}`)
      if (postData) {
        console.log(`  POST Data: ${formatBytes(postSize)}`)
      }
      console.log(`  URL: ${formatBytes(urlSize)}, Headers: ${formatBytes(headerSize)}, Total: ${formatBytes(totalSent)}${willBeCacheHit ? ' (CACHED - NOT COUNTED)' : ''}`)
      
      // Only count actual network requests, not cache hits
      if (!willBeCacheHit) {
        totalBytesSent += totalSent
      }
    }
  })
  
  page.on('response', async (response) => {
    if (isClosing) return // Skip processing if browser is closing
    
    try {
      const resourceType = response.request().resourceType()
      const allowedTypes = ['document', 'script', 'xhr', 'fetch']
      
      // Only count allowed responses
      if (allowedTypes.includes(resourceType)) {
        const url = response.url()
        const status = response.status()
        let body: Buffer
        let bodySize: number
        let contentType: string
        let isCacheHit = false
        
        // Check if this was served from cache
        if (CACHED_FILES.includes(url) && fileCache.has(url)) {
          isCacheHit = true
          const cached = fileCache.get(url)!
          bodySize = cached.content.length
          contentType = cached.contentType
        } else {
          body = await response.body()
          bodySize = body.length
          contentType = response.headers()['content-type'] || 'unknown'
          
          // Cache the file if it's in our cache list
          if (CACHED_FILES.includes(url) && status === 200) {
            fileCache.set(url, { content: body, contentType })
            console.log(`[CACHED] Stored ${url} in cache (${formatBytes(bodySize)})`)
          }
        }
        
        const headerSize = 500 // estimate
        const totalSize = bodySize + headerSize
        
        console.log(`[RESPONSE] ${resourceType.toUpperCase()} ${status} ${url}`)
        console.log(`  Content-Type: ${contentType}`)
        console.log(`  Body: ${formatBytes(bodySize)}, Headers: ${formatBytes(headerSize)}, Total: ${formatBytes(totalSize)}${isCacheHit ? ' (CACHED - NOT COUNTED)' : ''}`)
        
        // Only count actual network responses, not cache hits
        if (!isCacheHit) {
          totalBytesReceived += totalSize
        }
      }
    } catch (e) {
      if (!isClosing) {
        console.log(`[RESPONSE ERROR] ${response.url()}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  })
  
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
    // Remove automation indicators
    delete (window as any).navigator.webdriver
    delete (window as any).navigator.__proto__.webdriver
    
    // Override navigator properties
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    
    // Add chrome runtime
    ;(window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) }
    
    // Override permissions
    try {
      const originalQuery = window.navigator.permissions.query
      window.navigator.permissions.query = (parameters: any) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission } as any)
        }
        return originalQuery(parameters)
      }
    } catch (e) {}
  })
  
  page.setDefaultTimeout(30000)
  page.setDefaultNavigationTimeout(30000)

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)
  
  if (page.isClosed()) return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived }

  // Force trigger PopCash events in case content is cached
  try {
    await page.evaluate(() => {
      // Trigger common popup events
      window.dispatchEvent(new Event('load'))
      window.dispatchEvent(new Event('DOMContentLoaded'))
      document.dispatchEvent(new Event('readystatechange'))
      
      // Try to trigger PopCash if it exists
      if (typeof (window as any).popunder !== 'undefined') {
        try { (window as any).popunder() } catch(e) {}
      }
      if (typeof (window as any).popcash !== 'undefined') {
        try { (window as any).popcash() } catch(e) {}
      }
    })
  } catch (e) {}

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
    return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived }
  }
  
  if (!targetDiv) {
    const triggerActions = [
      () => page.click('body'),
      () => page.mouse.move(500, 500),
      () => page.mouse.wheel(0, 100),
      () => page.keyboard.press('Space'),
      () => page.hover('a[href="/"]'),
      () => page.evaluate(() => window.scrollTo(0, 100)),
      () => page.mouse.click(100, 100),
      () => page.mouse.click(800, 400),
      () => page.keyboard.press('Tab'),
      () => page.evaluate(() => window.dispatchEvent(new Event('scroll')))
    ]
    
    // More attempts with longer waits for cached content
    for (let attempt = 0; attempt < 15; attempt++) {
      const action = triggerActions[attempt % triggerActions.length]
      try { await action() } catch (e) {}
      await page.waitForTimeout(3000) // Longer wait for cached content
      
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
      try {
        await page.close()
        await context.close()
        await browser.close()
      } catch (e) {}
      return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived }
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
          isClosing = true // Set flag to stop processing responses
          console.log(`[SUCCESS] Redirect detected to ${currentUrl}`)
          // Wait for redirect chain to complete
          try {
            await page.waitForLoadState('networkidle', { timeout: 5000 })
          } catch (e) {}
          
          // Close cleanly
          try {
            await page.close()
            await context.close()
            await browser.close()
          } catch (e) {}
          return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived }
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
          isClosing = true // Set flag to stop processing responses
          console.log(`[SUCCESS] Redirect detected to ${urlAfterEvaluate}`)
          // Wait for redirect chain to complete
          try {
            await page.waitForLoadState('networkidle', { timeout: 5000 })
          } catch (e) {}
          
          // Close cleanly
          try {
            await page.close()
            await context.close()
            await browser.close()
          } catch (e) {}
          return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived }
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
  

  // Proceed straight to clicking without waiting
  console.log(`[PROCEEDING] Going straight to click actions without waiting for popup`)
  

  
  try {
    // Close all pages first to prevent stealth plugin errors
    const contexts = browser.contexts()
    for (const context of contexts) {
      const pages = context.pages()
      for (const page of pages) {
        try {
          if (!page.isClosed()) {
            await page.close()
          }
        } catch (e) {}
      }
      try {
        await context.close()
      } catch (e) {}
    }
    await browser.close()
  } catch (e) {}
  
  return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

async function main(): Promise<void> {
  console.log('=== System Information ===')
  const sysInfo = getSystemInfo()
  console.log(`Platform: ${sysInfo.platform} ${sysInfo.arch}`)
  console.log(`CPU Cores: ${sysInfo.cpuCount}`)
  console.log(`Total Memory: ${sysInfo.totalMemory} GB`)
  console.log(`Free Memory: ${sysInfo.freeMemory} GB`)
  console.log(`Cached Files: ${CACHED_FILES.length} files configured for caching`)
  console.log('==============================\n')

  let totalBytesSent = 0
  let totalBytesReceived = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const currentProxyPort = PROXY_PORT_START + (i % (PROXY_PORT_END - PROXY_PORT_START + 1))
    console.log(`\nIteration ${i + 1}/${MAX_ITERATIONS} - Proxy port: ${currentProxyPort}`)
    
    const memBefore = getMemoryUsage()
    const startTime = Date.now()
    
    try {
      const networkData = await visitSite(currentProxyPort)
      const duration = Date.now() - startTime
      const memAfter = getMemoryUsage()
      
      totalBytesSent += networkData.bytesSent
      totalBytesReceived += networkData.bytesReceived
      
      console.log(`Iteration ${i + 1} completed in ${duration}ms`)
      console.log(`Memory: RSS ${memAfter.rss}MB (Delta ${(memAfter.rss - memBefore.rss).toFixed(1)}MB), Heap ${memAfter.heapUsed}MB`)
      console.log(`System Memory: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)}GB free`)
      console.log(`Network (Real): Sent ${formatBytes(networkData.bytesSent)}, Received ${formatBytes(networkData.bytesReceived)}`)
      console.log(`Cumulative (Real): Sent ${formatBytes(totalBytesSent)}, Received ${formatBytes(totalBytesReceived)}`)
      
    } catch (error) {
      console.error(`Error in iteration ${i + 1}:`, error)
      const memAfter = getMemoryUsage()
      console.log(`Memory after error: RSS ${memAfter.rss}MB, Heap ${memAfter.heapUsed}MB`)
    }
    
    // Delay between iterations for proper cleanup
    if (i < MAX_ITERATIONS - 1) {
      console.log(`Waiting 2s before next iteration...`)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
  
  console.log('\nAll iterations completed!')
  const finalMem = getMemoryUsage()
  console.log(`Final Memory: RSS ${finalMem.rss}MB, Heap ${finalMem.heapUsed}MB`)
  console.log(`Final System Memory: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)}GB free`)
  console.log(`Final Cumulative (Real): Sent ${formatBytes(totalBytesSent)}, Received ${formatBytes(totalBytesReceived)}`)
  
  // Show cache statistics
  console.log('\n=== Cache Statistics ===')
  console.log(`Cached Files: ${fileCache.size}`)
  let totalCacheSize = 0
  for (const [url, cached] of fileCache.entries()) {
    const size = cached.content.length
    totalCacheSize += size
    console.log(`  ${url}: ${formatBytes(size)}`)
  }
  console.log(`Total Cache Size: ${formatBytes(totalCacheSize)}`)
  console.log('=========================')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
