import { chromium } from 'playwright-extra'
// Removed stealth plugin - causing too many errors with page creation
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
const MAX_CONCURRENT_WORKERS = 1000
const WORKER_BATCH_SIZE = 500000000

const TARGET_URL = process.env.TARGET_URL as string

// Cache for frequently requested files
const fileCache = new Map<string, { content: Buffer, contentType: string }>()
const CACHED_FILES = [
  'https://cdn.popcash.net/show.js',
  TARGET_URL
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
    headless: true,
    args: [
      '--no-first-run', 
      '--disable-blink-features=AutomationControlled',
      '--enable-blink-features=IdleDetection',
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

async function visitSite(proxyPort: number, workerId: number): Promise<{ bytesSent: number, bytesReceived: number, success: boolean }> {
  // Add overall timeout to prevent hanging
  return Promise.race([
    visitSiteInternal(proxyPort, workerId),
    new Promise<{ bytesSent: number, bytesReceived: number, success: boolean }>((_, reject) =>
      setTimeout(() => reject(new Error('visitSite timeout after 120 seconds')), 120000)
    )
  ]).catch(async (error) => {
    console.log(`[W${workerId}] [TIMEOUT] visitSite timed out or errored: ${error instanceof Error ? error.message : String(error)}`)
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
    console.log(`[W${workerId}] [BROWSER] Chrome version: ${version}`)
  } catch (e) {
    console.log(`[W${workerId}] [BROWSER] Could not get Chrome version: ${e}`)
  }

  const userAgent = new UserAgent({ deviceCategory: 'desktop' })
  const context = await browser.newContext({
    userAgent: userAgent.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation']
  })
  
  console.log(`[W${workerId}] [BROWSER] User agent: ${userAgent.toString()}`)

  const page = await context.newPage()
  
  // Whitelist of allowed domains and their subdomains
  const targetHostname = new URL(TARGET_URL).hostname
  const ALLOWED_DOMAINS = [targetHostname, 'pcdelv.com', 'popcash.net']
  
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
    try {
      const request = route.request()
      const resourceType = request.resourceType()
      const url = request.url()
      const allowedTypes = ['document', 'script', 'xhr', 'fetch']
      
      // Block any domain not in whitelist
      if (!isAllowedDomain(url)) {
        console.log(`[W${workerId}] [BLOCKED] Non-whitelisted domain: ${url}`)
        await route.abort()
        return
      }
      
      if (!allowedTypes.includes(resourceType)) {
        await route.abort()
        return
      }
      
      // Check if this file should be cached
      if (CACHED_FILES.includes(url)) {
        if (fileCache.has(url)) {
          // Serve from cache
          const cached = fileCache.get(url)!
          console.log(`[W${workerId}] [CACHE HIT] Serving ${url} from cache (${formatBytes(cached.content.length)})`)
          await route.fulfill({
            status: 200,
            contentType: cached.contentType,
            body: cached.content
          })
          return
        } else {
          // First time - fetch and cache
          console.log(`[W${workerId}] [CACHE MISS] Fetching ${url} for caching`)
        }
      }
      
      // Add timeout for route continuation
      const continuePromise = route.continue()
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Route timeout')), 10000)
      )
      
      await Promise.race([continuePromise, timeoutPromise])
    } catch (e) {
      console.log(`[W${workerId}] [ROUTE ERROR] ${route.request().url()}: ${e instanceof Error ? e.message : String(e)}`)
      try {
        await route.abort()
      } catch (abortError) {}
    }
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
      
      console.log(`[W${workerId}] [REQUEST] ${resourceType.toUpperCase()} ${method} ${url}`)
      if (postData) {
        console.log(`[W${workerId}]   POST Data: ${formatBytes(postSize)}`)
      }
      console.log(`[W${workerId}]   URL: ${formatBytes(urlSize)}, Headers: ${formatBytes(headerSize)}, Total: ${formatBytes(totalSent)}${willBeCacheHit ? ' (CACHED - NOT COUNTED)' : ''}`)
      
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
          // Add timeout for response.body() to prevent hanging
          try {
            const bodyPromise = response.body()
            const timeoutPromise = new Promise<Buffer>((_, reject) => 
              setTimeout(() => reject(new Error('Response body timeout')), 10000)
            )
            body = await Promise.race([bodyPromise, timeoutPromise])
            bodySize = body.length
            contentType = response.headers()['content-type'] || 'unknown'
            
            // Cache the file if it's in our cache list
            if (CACHED_FILES.includes(url) && status === 200) {
              fileCache.set(url, { content: body, contentType })
              console.log(`[W${workerId}] [CACHED] Stored ${url} in cache (${formatBytes(bodySize)})`)
            }
          } catch (bodyError) {
            console.log(`[W${workerId}] [BODY ERROR] Failed to get response body for ${url}: ${bodyError instanceof Error ? bodyError.message : String(bodyError)}`)
            bodySize = 0
            contentType = 'unknown'
          }
        }
        
        const headerSize = 500 // estimate
        const totalSize = bodySize + headerSize
        
        console.log(`[W${workerId}] [RESPONSE] ${resourceType.toUpperCase()} ${status} ${url}`)
        console.log(`[W${workerId}]   Content-Type: ${contentType}`)
        console.log(`[W${workerId}]   Body: ${formatBytes(bodySize)}, Headers: ${formatBytes(headerSize)}, Total: ${formatBytes(totalSize)}${isCacheHit ? ' (CACHED - NOT COUNTED)' : ''}`)
        
        // Only count actual network responses, not cache hits
        if (!isCacheHit) {
          totalBytesReceived += totalSize
        }
      }
    } catch (e) {
      if (!isClosing) {
        console.log(`[W${workerId}] [RESPONSE ERROR] ${response.url()}: ${e instanceof Error ? e.message : String(e)}`)
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
    console.log('Chrome version:', navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || 'Unknown')
    console.log('User agent:', navigator.userAgent)
    console.log('navigator.webdriver:', navigator.webdriver)
  })
  
  page.setDefaultTimeout(15000)
  page.setDefaultNavigationTimeout(15000)

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(2000)
  } catch (e) {
    console.log(`[W${workerId}] [TIMEOUT] Page load timeout or error: ${e instanceof Error ? e.message : String(e)}`)
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
          console.log(`[W${workerId}] [SUCCESS] Redirect detected to ${currentUrl}`)
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
          console.log(`[W${workerId}] [SUCCESS] Redirect detected to ${urlAfterEvaluate}`)
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
  console.log(`[W${workerId}] [PROCEEDING] Going straight to click actions without waiting for popup`)
  

  
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

  console.log(`[W${workerId}] Worker started - will run ${iterationsToRun} iterations`)

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
      
      console.log(`[W${workerId}] Iteration ${stats.iterations} completed in ${duration}ms (Port: ${currentProxyPort}) ${networkData.success ? '[SUCCESS]' : '[NO SUCCESS]'}`)
      console.log(`[W${workerId}] Network: Sent ${formatBytes(networkData.bytesSent)}, Received ${formatBytes(networkData.bytesReceived)}`)
      
    } catch (error) {
      stats.errors++
      stats.lastActivity = new Date()
      console.error(`[W${workerId}] Error in iteration ${stats.iterations + 1}:`, error)
    }
    
    // Small delay between iterations within worker
    if (i < iterationsToRun - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  
  console.log(`[W${workerId}] Worker completed ${stats.iterations} iterations (${stats.errors} errors)`)
}

async function printStats(): Promise<void> {
  const memUsage = getMemoryUsage()
  const sysInfo = getSystemInfo()
  
  console.log('\n=== PARALLEL EXECUTION STATS ===')
  console.log(`Active Workers: ${workerStats.size}`)
  console.log(`Global Iterations: ${Array.from(workerStats.values()).reduce((sum, s) => sum + s.iterations, 0)}`)
  console.log(`Global Errors: ${Array.from(workerStats.values()).reduce((sum, s) => sum + s.errors, 0)}`)
  console.log(`Global Network: Sent ${formatBytes(globalBytesSent)}, Received ${formatBytes(globalBytesReceived)}`)
  console.log(`Memory: RSS ${memUsage.rss}MB, Heap ${memUsage.heapUsed}MB`)
  console.log(`System Memory: ${sysInfo.freeMemory}GB free of ${sysInfo.totalMemory}GB`)
  
  console.log('\n--- Worker Details ---')
  for (const [workerId, stats] of workerStats.entries()) {
    const timeSinceActivity = Date.now() - stats.lastActivity.getTime()
    console.log(`W${workerId}: ${stats.iterations} iterations, ${stats.errors} errors, ${formatBytes(stats.bytesSent)} sent, ${formatBytes(stats.bytesReceived)} received (${Math.round(timeSinceActivity/1000)}s ago)`)
  }
  console.log('================================\n')
  
  // Print persistent stats
  if (statsManager) {
    statsManager.printStats()
  }
}

async function main(): Promise<void> {
  // Initialize stats manager
  statsManager = new StatsManager('./bot-stats.json')
  
  console.log('=== PARALLEL BOT SYSTEM ===')
  const sysInfo = getSystemInfo()
  console.log(`Platform: ${sysInfo.platform} ${sysInfo.arch}`)
  console.log(`CPU Cores: ${sysInfo.cpuCount}`)
  console.log(`Total Memory: ${sysInfo.totalMemory} GB`)
  console.log(`Free Memory: ${sysInfo.freeMemory} GB`)
  console.log(`Max Concurrent Workers: ${MAX_CONCURRENT_WORKERS}`)
  console.log(`Worker Batch Size: ${WORKER_BATCH_SIZE}`)
  console.log(`Cached Files: ${CACHED_FILES.length} files configured for caching`)
  console.log('============================\n')
  
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
    
    console.log(`\n=== BATCH ${batchNumber} ===`)
    console.log(`Running ${iterationsThisBatch} iterations across ${MAX_CONCURRENT_WORKERS} workers`)
    console.log(`${iterationsPerWorker} iterations per worker`)
    console.log('==================\n')

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
    
    console.log(`\n=== BATCH ${batchNumber} COMPLETED ===`)
    console.log(`Total iterations completed: ${totalIterationsRun}/${MAX_ITERATIONS}`)
    await printStats()
    
    // Break between batches for cleanup
    if (totalIterationsRun < MAX_ITERATIONS) {
      console.log('Waiting 5s before next batch...')
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }

  clearInterval(statsInterval)
  
  console.log('\n=== ALL BATCHES COMPLETED ===')
  await printStats()
  
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
  
  // Cleanup stats manager
  if (statsManager) {
    statsManager.cleanup()
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, cleaning up...')
  if (statsManager) {
    statsManager.cleanup()
  }
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, cleaning up...')
  if (statsManager) {
    statsManager.cleanup()
  }
  process.exit(0)
})

main().catch(err => {
  console.error(err)
  if (statsManager) {
    statsManager.cleanup()
  }
  process.exitCode = 1
})
