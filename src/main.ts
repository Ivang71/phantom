import { chromium } from 'playwright-extra'
const UserAgent = require('user-agents')
import { config as loadEnv } from 'dotenv'
import * as os from 'os'
import { StatsManager } from './stats'

loadEnv()

const PROXY_PORT_START = 10000
const PROXY_PORT_END = 20000
const MAX_CONCURRENT_WORKERS = Number(process.env.NUMBER_OF_WORKERS)

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
  const proxyConfig = { server: 'http://127.0.0.1:3128' }
  
  return await chromium.launch({
    headless: false,
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

  async function detectGeoViaProxy(): Promise<{ countryCode: string, timezone: string, lat: number, lon: number }> {
    const tmp = await browser.newContext()
    try {
      const p = await tmp.newPage()
      const info = await p.evaluate(async () => {
        const r = await fetch('http://ip-api.com/json?fields=status,countryCode,timezone,lat,lon', { cache: 'no-store' })
        return await r.json()
      })
      if (info && info.status === 'success' && info.countryCode && info.timezone) {
        return { countryCode: info.countryCode as string, timezone: info.timezone as string, lat: Number(info.lat), lon: Number(info.lon) }
      }
      throw new Error('Geo lookup failed')
    } finally {
      try { await tmp.close() } catch (e) {}
    }
  }

  function localeFromCountry(countryCode: string): string {
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

  async function waitForFinalOnPage(p: any, timeoutMs = 10000): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const onReq = (req: any) => {
        const u = req.url()
        if (u.includes('p.pcdelv.com/v2/') && u.endsWith('/cl')) {
          cleanup(true)
        }
      }
      const timer = setTimeout(() => cleanup(false), timeoutMs)
      function cleanup(result: boolean) {
        if (done) return
        done = true
        try { p.off('request', onReq) } catch (e) {}
        clearTimeout(timer)
        resolve(result)
      }
      try { p.on('request', onReq) } catch (e) { cleanup(false) }
    })
  }

  // Get Chrome version info
  try {
    const version = await browser.version()
    logDebug(`[W${workerId}] [BROWSER] Chrome version: ${version}`)
  } catch (e) {
    logDebug(`[W${workerId}] [BROWSER] Could not get Chrome version: ${e}`)
  }

  const userAgent = new UserAgent({ deviceCategory: 'desktop' })
  let detectedLocale = 'en-US'
  let detectedTz = 'America/New_York'
  let detectedGeo = { latitude: 40.7128, longitude: -74.006 }
  try {
    const g = await detectGeoViaProxy()
    detectedLocale = localeFromCountry(g.countryCode)
    detectedTz = g.timezone
    detectedGeo = { latitude: g.lat, longitude: g.lon }
    logInfo(`[W${workerId}] GEO ${g.countryCode} ${g.timezone} (${g.lat.toFixed(2)},${g.lon.toFixed(2)})`)
  } catch (e) {
    logWarn(`[W${workerId}] GEO lookup failed, using defaults`)
  }

  const context = await browser.newContext({
    userAgent: userAgent.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: detectedLocale,
    timezoneId: detectedTz,
    geolocation: detectedGeo,
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': `${detectedLocale.split('-')[0]}-${detectedLocale.split('-')[1]},${detectedLocale.split('-')[0]};q=0.9,en;q=0.8` }
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
  
  // Extra diagnostics: log failed requests and HTTP errors
  page.on('requestfailed', (request) => {
    const failure = request.failure()
    logWarn(`[W${workerId}] [REQ FAILED] ${request.url()} - ${failure ? failure.errorText : 'unknown'}`)
  })
  page.on('response', (response) => {
    const status = response.status()
    if (status >= 400) {
      logWarn(`[W${workerId}] [HTTP ${status}] ${response.url()}`)
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
    
    // Debug: log when the initial redirect endpoint is hit
    if (url.includes('p.pcdelv.com/go/')) {
      logInfo(`[W${workerId}] [REDIRECT SEEN] HTTP go endpoint requested: ${url}`)
    }

    // Detect final PopCash conversion endpoint
    if (url.includes('p.pcdelv.com/v2/') && url.endsWith('/cl')) {
      wasSuccessful = true
      logInfo(`[W${workerId}] [SUCCESS] Final PopCash endpoint reached: ${url}`)
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
    logDebug(`[W${workerId}] [NEW PAGE] Opened: ${newPage.url()}`)
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
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 7000 })
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

  // Minimal trigger; show.js will mount the div itself
  try {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('load'))
    })
  } catch (e) {}

  /*
    Real on-page flow (observed):
    - Page loads from cache in <1s; show.js is fetched and executed.
    - A probe to https://dcba.popcash.net/znWaa3gu fires; ignore it.
    - The ad div injected by show.js mounts ~1.5s after load and it always mounts.
    - No need for scroll/wheel/hover spam; just click the mounted div.

    Click outcomes:
    1) Pop-under: a new tab with the same TARGET_URL gets focus while the original tab enters the redirect chain.
       Action: close the new tab and wait for the redirect chain to finish on the original tab.
    2) Pop-up: a new window opens and starts the redirect chain; it becomes focused.
       Action: close the original TARGET_URL page and wait for the redirect chain to finish in the new window.
  */
  // Wait for guaranteed mount (~1.5s); then query for high z-index/fixed div
  await page.waitForTimeout(1500)
  let targetDiv = await page.$('div[style*="z-index:9999999"], div[style*="position:fixed"][style*="z-index"]')
  if (!targetDiv) {
    const candidates = await page.$$('div')
    for (const div of candidates) {
      const style = await div.getAttribute('style')
      if (style && style.includes('z-index') && (style.includes('9999999') || style.includes('position:fixed'))) {
        targetDiv = div
        break
      }
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
    
    await page.waitForTimeout(300)
    const pagesBefore = context.pages()
    // Single decisive click
    try { await targetDiv.click({ force: true }) } catch (e) {}
    await page.waitForTimeout(500)
    
    // Detect outcome
    // Small grace period for popups/tabs to appear
    await page.waitForTimeout(700)
    const pagesAfter = context.pages()
    const opened = pagesAfter.find(p => !pagesBefore.includes(p))
    
    if (opened) {
      // New tab/window opened
      const openedUrl = opened.url()
      const openedIsSameTarget = openedUrl === TARGET_URL || openedUrl === 'about:blank'
      if (openedIsSameTarget) {
        // Case 1: Pop-under - close new tab, wait on original
        try { await opened.bringToFront() } catch (e) {}
        try { await opened.close() } catch (e) {}
        try { await page.bringToFront() } catch (e) {}
        // Wait for redirect chain on original quickly via request observation
        try { wasSuccessful = await waitForFinalOnPage(page, 7000) } catch (e) {}
        if (wasSuccessful) {
          isClosing = true
          try { await page.waitForLoadState('networkidle', { timeout: 4000 }) } catch (e) {}
          try { await browser.close() } catch (e) {}
          return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
        }
      } else {
        // Case 2: Pop-up - close original, wait on new window
        try { await opened.bringToFront() } catch (e) {}
        try { wasSuccessful = await waitForFinalOnPage(opened, 7000) } catch (e) {}
        // Close immediately on success to end session
        try { await page.close() } catch (e) {}
        try { await opened.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => {}) } catch (e) {}
        try { await browser.close() } catch (e) {}
        return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
      }
    } else {
      // No new page; check if current navigated
      try { wasSuccessful = await waitForFinalOnPage(page, 7000) } catch (e) {}
      if (wasSuccessful) {
        isClosing = true
        try { await page.waitForLoadState('networkidle', { timeout: 1500 }) } catch (e) {}
        try { await browser.close() } catch (e) {}
        return { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, success: wasSuccessful }
      }
    }
  }
  
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

async function runWorker(workerId: number): Promise<void> {
  const stats: WorkerStats = {
    workerId,
    iterations: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
    lastActivity: new Date()
  }
  workerStats.set(workerId, stats)

  logInfo(`[W${workerId}] Worker started`)

  for (;;) {
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
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
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

  // Clear previous worker stats
  workerStats.clear()

  // Start workers independently (no batching)
  for (let workerId = 0; workerId < MAX_CONCURRENT_WORKERS; workerId++) {
    runWorker(workerId).catch(err => logError(`[W${workerId}] Worker crashed:`, err))
  }

  // Keep process alive; stats printer will continue
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 60000))
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
