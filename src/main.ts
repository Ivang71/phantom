import { chromium } from 'playwright-extra'
const UserAgent = require('user-agents')
import { config as loadEnv } from 'dotenv'
import * as os from 'os'
import { StatsManager } from './stats'

loadEnv()

const PROXY_USER = process.env.PROXY_USER
const PROXY_PASS = process.env.PROXY_PASS
const PROXY_HOST = process.env.PROXY_HOST
const PROXY_PORT_START = 10000
const PROXY_PORT_END = 20000
const MAX_ITERATIONS = 1000000000
const MAX_CONCURRENT_WORKERS = Number(process.env.NUMBER_OF_WORKERS)
const WORKER_BATCH_SIZE = 500000000

enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

const CURRENT_LOG_LEVEL = LogLevel.DEBUG

function log(level: LogLevel, message: string, ...args: any[]): void {
  if (level <= CURRENT_LOG_LEVEL) {
    console.log(message, ...args)
  }
}

function logError(message: string, ...args: any[]): void {
  log(LogLevel.ERROR, message, ...args)
}

function logWarn(message: string, ...args: any[]): void {
  log(LogLevel.WARN, message, ...args)
}

function logInfo(message: string, ...args: any[]): void {
  log(LogLevel.INFO, message, ...args)
}

function logDebug(message: string, ...args: any[]): void {
  log(LogLevel.DEBUG, message, ...args)
}

const TARGET_URL = process.env.TARGET_URL as string

// Centralized cache for frequently requested files
const fileCache = new Map<string, { content: Buffer, contentType: string }>()
const CACHED_FILES = [
  'https://cdn.popcash.net/show.js',
  TARGET_URL
]

async function preloadCache(): Promise<void> {
  logInfo('=== PRELOADING CACHE ===')
  
  for (const url of CACHED_FILES) {
    try {
      logInfo(`Downloading ${url}...`)
      const response = await fetch(url)
      
      if (!response.ok) {
        logWarn(`Failed to download ${url}: ${response.status} ${response.statusText}`)
        continue
      }
      
      const content = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') || 'application/octet-stream'
      
      fileCache.set(url, { content, contentType })
      logInfo(`✓ Cached ${url} (${formatBytes(content.length)}, ${contentType})`)
      
    } catch (error) {
      logError(`Failed to download ${url}:`, error)
    }
  }
  
  const totalSize = Array.from(fileCache.values()).reduce((sum, cached) => sum + cached.content.length, 0)
  logInfo(`Cache preloaded: ${fileCache.size}/${CACHED_FILES.length} files, ${formatBytes(totalSize)} total`)
  logInfo('========================\n')
}

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
  const proxyConfig = {
    server: 'http://127.0.0.1:3128'
  }
  
  return await chromium.launch({
    headless: true,
    args: [
      // === make Chrome shut up ===
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-pings',
      '--safebrowsing-disable-auto-update',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-variations',
      
      // === stop remaining traffic before route handler ===
      '--disable-quic',
      '--dns-prefetch-disable',
      '--disable-features=PreconnectToOrigins,PrefetchPrivacyChanges',
      
      // === keep the ones you already had ===
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
      '--disable-features=VizDisplayCompositor'
    ],
    ...(proxyConfig && { proxy: proxyConfig })
  })
}

async function visitSite(proxyPort: number, workerId: number): Promise<{ bytesSent: number, bytesReceived: number, success: boolean }> {
  // Add overall timeout to prevent hanging
  return Promise.race([
    visitSiteInternal(proxyPort, workerId),
    new Promise<{ bytesSent: number, bytesReceived: number, success: boolean }>((_, reject) =>
      setTimeout(() => reject(new Error('visitSite timeout after 120 seconds')), 120000)
    )
  ]).catch(async (error) => {
    logError(`[W${workerId}] [TIMEOUT] visitSite timed out or errored: ${error instanceof Error ? error.message : String(error)}`)
    return { bytesSent: 0, bytesReceived: 0, success: false }
  })
}

async function visitSiteInternal(proxyPort: number, workerId: number): Promise<{ bytesSent: number, bytesReceived: number, success: boolean }> {
  const browser = await createBrowserWithProxy(proxyPort)
  let totalBytesSent = 0
  let totalBytesReceived = 0
  let isClosing = false
  let wasSuccessful = false

  // Get Chrome version info
  try {
    const version = await browser.version()
    logDebug(`[W${workerId}] [BROWSER] Chrome version: ${version}`)
  } catch (e) {
    logDebug(`[W${workerId}] [BROWSER] Could not get Chrome version: ${e}`)
  }

  const userAgent = new UserAgent({ deviceCategory: 'desktop' })
  const context = await browser.newContext({
    userAgent: userAgent.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation']
  })
  
  logDebug(`[W${workerId}] [BROWSER] User agent: ${userAgent.toString()}`)

  const page = await context.newPage()
  
  // Simple route handler for caching only (Squid handles all filtering)
  await page.route('**/*', async (route) => {
    try {
      const url = route.request().url()
      
      // Check if this file should be served from cache
      if (CACHED_FILES.includes(url)) {
        if (fileCache.has(url)) {
          // Serve from pre-loaded cache
          const cached = fileCache.get(url)!
          globalCacheHits++
          globalCacheBytesSaved += cached.content.length
          logDebug(`[W${workerId}] [CACHE HIT] Serving ${url} from cache (${formatBytes(cached.content.length)})`)
          await route.fulfill({
            status: 200,
            contentType: cached.contentType,
            body: cached.content
          })
          return
        }
      }
      
      // Let all other requests through (Squid will filter)
      await route.continue()
    } catch (e) {
      logDebug(`[W${workerId}] [ROUTE ERROR] ${route.request().url()}: ${e instanceof Error ? e.message : String(e)}`)
      try {
        await route.continue()
      } catch (continueError) {}
    }
  })
  
  // Track network requests for data measurement (excluding cache hits)
  page.on('request', (request) => {
    const url = request.url()
    const method = request.method()
    const postData = request.postData()
    const urlSize = Buffer.byteLength(request.url(), 'utf8')
    const postSize = postData ? Buffer.byteLength(postData, 'utf8') : 0
    const headerSize = 200 // estimate
    const totalSent = urlSize + postSize + headerSize
    
    // Check if this will be served from cache
    const willBeCacheHit = CACHED_FILES.includes(url) && fileCache.has(url)
    
    // Detect successful PopCash redirect
    if (url.includes('p.pcdelv.com/go/')) {
      wasSuccessful = true
      logInfo(`[W${workerId}] [SUCCESS] PopCash redirect detected: ${url}`)
    }
    
    logDebug(`[W${workerId}] [REQUEST] ${method} ${url}`)
    if (postData) {
      logDebug(`[W${workerId}]   POST Data: ${formatBytes(postSize)}`)
    }
    logDebug(`[W${workerId}]   URL: ${formatBytes(urlSize)}, Headers: ${formatBytes(headerSize)}, Total: ${formatBytes(totalSent)}${willBeCacheHit ? ' (CACHED - NOT COUNTED)' : ''}`)
    
    // Only count actual network requests, not cache hits
    if (!willBeCacheHit) {
      totalBytesSent += totalSent
    }
  })
  
  page.on('response', async (response) => {
    if (isClosing) return // Skip processing if browser is closing
    
    try {
      const url = response.url()
      const status = response.status()
      let bodySize: number
      let contentType: string
      let isCacheHit = false
      
      // Check if this was served from pre-loaded cache
      if (CACHED_FILES.includes(url) && fileCache.has(url)) {
        isCacheHit = true
        const cached = fileCache.get(url)!
        bodySize = cached.content.length
        contentType = cached.contentType
      } else {
        // Get response body for network requests (skip redirects)
        const status = response.status()
        if (status >= 300 && status < 400) {
          // Redirect response - body is unavailable
          bodySize = 0
          contentType = response.headers()['content-type'] || 'redirect'
        } else {
          try {
            const bodyPromise = response.body()
            const timeoutPromise = new Promise<Buffer>((_, reject) => 
              setTimeout(() => reject(new Error('Response body timeout')), 10000)
            )
            const body = await Promise.race([bodyPromise, timeoutPromise])
            bodySize = body.length
            contentType = response.headers()['content-type'] || 'unknown'
          } catch (bodyError) {
            logDebug(`[W${workerId}] [BODY ERROR] Failed to get response body for ${url}: ${bodyError instanceof Error ? bodyError.message : String(bodyError)}`)
            bodySize = 0
            contentType = 'unknown'
            return
          }
        }
      }
      
      const headerSize = 500 // estimate
      const totalSize = bodySize + headerSize
      
      logDebug(`[W${workerId}] [RESPONSE] ${status} ${url}`)
      logDebug(`[W${workerId}]   Content-Type: ${contentType}`)
      logDebug(`[W${workerId}]   Body: ${formatBytes(bodySize)}, Headers: ${formatBytes(headerSize)}, Total: ${formatBytes(totalSize)}${isCacheHit ? ' (CACHED - NOT COUNTED)' : ''}`)
      
      // Only count actual network responses, not cache hits
      if (!isCacheHit) {
        totalBytesReceived += totalSize
      }
    } catch (e) {
      if (!isClosing) {
        logDebug(`[W${workerId}] [RESPONSE ERROR] ${response.url()}: ${e instanceof Error ? e.message : String(e)}`)
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
    Object.defineProperty(navigator, 'webdriver', { 
      get: () => undefined,
      configurable: true,
      enumerable: true
    })
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
    
    // Log Chrome version and user agent for testing
      // Browser detection logs removed for performance
  })
  
  page.setDefaultTimeout(15000)
  page.setDefaultNavigationTimeout(15000)

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(2000)
  } catch (e) {
    logWarn(`[W${workerId}] [TIMEOUT] Page load timeout or error: ${e instanceof Error ? e.message : String(e)}`)
    try {
      await page.close()
      await context.close()
      await browser.close()
    } catch (e) {}
    return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
  }
  
  if (page.isClosed()) return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }

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
    return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
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
      return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
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
          wasSuccessful = true
          logInfo(`[W${workerId}] [SUCCESS] Redirect detected to ${currentUrl}`)
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
          return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
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
          wasSuccessful = true
          logInfo(`[W${workerId}] [SUCCESS] Redirect detected to ${urlAfterEvaluate}`)
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
          return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
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
  logDebug(`[W${workerId}] [PROCEEDING] Going straight to click actions without waiting for popup`)
  

  
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
  
  return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

interface WorkerStats {
  workerId: number
  iterations: number
  bytesSent: number
  bytesReceived: number
  errors: number
  lastActivity: Date
}

const workerStats = new Map<number, WorkerStats>()
let globalIterationCount = 0
let globalBytesSent = 0
let globalBytesReceived = 0
let globalCacheHits = 0
let globalCacheBytesSaved = 0
let statsManager: StatsManager

async function runWorker(workerId: number, iterationsToRun: number): Promise<void> {
  const stats: WorkerStats = {
    workerId,
    iterations: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
    lastActivity: new Date()
  }
  workerStats.set(workerId, stats)

  logInfo(`[W${workerId}] Worker started - will run ${iterationsToRun} iterations`)

  for (let i = 0; i < iterationsToRun; i++) {
    const iterationNumber = globalIterationCount++
    const currentProxyPort = PROXY_PORT_START + (iterationNumber % (PROXY_PORT_END - PROXY_PORT_START + 1))
    
    const startTime = Date.now()
    
    try {
      const networkData = await visitSite(currentProxyPort, workerId)
      const duration = Date.now() - startTime
      
      stats.iterations++
      stats.bytesSent += networkData.bytesSent
      stats.bytesReceived += networkData.bytesReceived
      stats.lastActivity = new Date()
      
      globalBytesSent += networkData.bytesSent
      globalBytesReceived += networkData.bytesReceived
      
      // Record successful cycle in stats manager
      if (networkData.success) {
        statsManager.recordSuccessfulCycle(networkData.bytesSent, networkData.bytesReceived)
      }
      
      if (stats.iterations % 10 === 0 || networkData.success) {
        logInfo(`[W${workerId}] Iteration ${stats.iterations} completed in ${duration}ms (Port: ${currentProxyPort}) ${networkData.success ? '[SUCCESS]' : '[NO SUCCESS]'}`)
        logInfo(`[W${workerId}] Network: Sent ${formatBytes(networkData.bytesSent)}, Received ${formatBytes(networkData.bytesReceived)}`)
      }
      
    } catch (error) {
      stats.errors++
      stats.lastActivity = new Date()
      logError(`[W${workerId}] Error in iteration ${stats.iterations + 1}:`, error)
    }
    
    // Small delay between iterations within worker
    if (i < iterationsToRun - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  
  logInfo(`[W${workerId}] Worker completed ${stats.iterations} iterations (${stats.errors} errors)`)
}

async function printStats(): Promise<void> {
  const memUsage = getMemoryUsage()
  const sysInfo = getSystemInfo()
  
  logInfo('\n=== PARALLEL EXECUTION STATS ===')
  logInfo(`Active Workers: ${workerStats.size}`)
  logInfo(`Global Iterations: ${Array.from(workerStats.values()).reduce((sum, s) => sum + s.iterations, 0)}`)
  logInfo(`Global Errors: ${Array.from(workerStats.values()).reduce((sum, s) => sum + s.errors, 0)}`)
  logInfo(`Global Network: Sent ${formatBytes(globalBytesSent)}, Received ${formatBytes(globalBytesReceived)}`)
  logInfo(`Cache Performance: ${globalCacheHits} hits, ${formatBytes(globalCacheBytesSaved)} saved`)
  logInfo(`Memory: RSS ${memUsage.rss}MB, Heap ${memUsage.heapUsed}MB`)
  logInfo(`System Memory: ${sysInfo.freeMemory}GB free of ${sysInfo.totalMemory}GB`)
  
  logInfo('\n--- Worker Details ---')
  for (const [workerId, stats] of workerStats.entries()) {
    const timeSinceActivity = Date.now() - stats.lastActivity.getTime()
    logInfo(`W${workerId}: ${stats.iterations} iterations, ${stats.errors} errors, ${formatBytes(stats.bytesSent)} sent, ${formatBytes(stats.bytesReceived)} received (${Math.round(timeSinceActivity/1000)}s ago)`)
  }
  logInfo('================================\n')
  
  // Print persistent stats
  if (statsManager) {
    statsManager.printStats()
  }
}

async function main(): Promise<void> {
  // Initialize stats manager
  statsManager = new StatsManager('./bot-stats.json')
  
  logInfo('=== PARALLEL BOT SYSTEM ===')
  const sysInfo = getSystemInfo()
  logInfo(`Platform: ${sysInfo.platform} ${sysInfo.arch}`)
  logInfo(`CPU Cores: ${sysInfo.cpuCount}`)
  logInfo(`Total Memory: ${sysInfo.totalMemory} GB`)
  logInfo(`Free Memory: ${sysInfo.freeMemory} GB`)
  logInfo(`Max Concurrent Workers: ${MAX_CONCURRENT_WORKERS}`)
  logInfo(`Worker Batch Size: ${WORKER_BATCH_SIZE}`)
  logInfo(`Cached Files: ${CACHED_FILES.length} files configured for caching`)
  
  // Squid-only mode
  logInfo(`Proxy Mode: Squid-Only (127.0.0.1:3128)`)
  logInfo(`Cost Savings: All traffic filtered through Squid before reaching proxy`)
  logInfo('============================\n')
  
  // Preload cache before starting workers
  await preloadCache()
  
  // Print initial stats
  statsManager.printStats()

  // Start stats printer
  const statsInterval = setInterval(printStats, 15000)

  let totalIterationsRun = 0
  let batchNumber = 0

  while (totalIterationsRun < MAX_ITERATIONS) {
    batchNumber++
    const remainingIterations = MAX_ITERATIONS - totalIterationsRun
    const iterationsThisBatch = Math.min(remainingIterations, WORKER_BATCH_SIZE * MAX_CONCURRENT_WORKERS)
    const iterationsPerWorker = Math.ceil(iterationsThisBatch / MAX_CONCURRENT_WORKERS)
    
    logInfo(`\n=== BATCH ${batchNumber} ===`)
    logInfo(`Running ${iterationsThisBatch} iterations across ${MAX_CONCURRENT_WORKERS} workers`)
    logInfo(`${iterationsPerWorker} iterations per worker`)
    logInfo('==================\n')

    // Clear previous worker stats
    workerStats.clear()
    
    // Create and start workers
    const workerPromises: Promise<void>[] = []
    for (let workerId = 0; workerId < MAX_CONCURRENT_WORKERS; workerId++) {
      const actualIterations = Math.min(iterationsPerWorker, remainingIterations - (workerId * iterationsPerWorker))
      if (actualIterations > 0) {
        workerPromises.push(runWorker(workerId, actualIterations))
      }
    }
    
    // Wait for all workers to complete
    await Promise.all(workerPromises)
    
    totalIterationsRun += iterationsThisBatch
    
    logInfo(`\n=== BATCH ${batchNumber} COMPLETED ===`)
    logInfo(`Total iterations completed: ${totalIterationsRun}/${MAX_ITERATIONS}`)
    await printStats()
    
    // Break between batches for cleanup
    if (totalIterationsRun < MAX_ITERATIONS) {
      logInfo('Waiting 5s before next batch...')
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }

  clearInterval(statsInterval)
  
  logInfo('\n=== ALL BATCHES COMPLETED ===')
  await printStats()
  
  // Show cache statistics
  logInfo('\n=== Cache Statistics ===')
  logInfo(`Cached Files: ${fileCache.size}`)
  let totalCacheSize = 0
  for (const [url, cached] of fileCache.entries()) {
    const size = cached.content.length
    totalCacheSize += size
    logInfo(`  ${url}: ${formatBytes(size)}`)
  }
  logInfo(`Total Cache Size: ${formatBytes(totalCacheSize)}`)
  logInfo('=========================')
  
  // Cleanup stats manager
  if (statsManager) {
    statsManager.cleanup()
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  logInfo('\nReceived SIGINT, cleaning up...')
  if (statsManager) {
    statsManager.cleanup()
  }
  process.exit(0)
})

process.on('SIGTERM', () => {
  logInfo('\nReceived SIGTERM, cleaning up...')
  if (statsManager) {
    statsManager.cleanup()
  }
  process.exit(0)
})

main().catch(err => {
  logError('Fatal error:', err)
  if (statsManager) {
    statsManager.cleanup()
  }
  process.exitCode = 1
})
