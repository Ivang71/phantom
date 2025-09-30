import { chromium } from 'playwright-extra'
const UserAgent = require('user-agents')
import { config as loadEnv } from 'dotenv'
import * as os from 'os'
import { StatsManager } from './stats'
const { ProxyAgent, setGlobalDispatcher } = require('undici')
import * as net from 'net'

loadEnv()

const PROXY_PORT_START = 10000
const PROXY_PORT_END = 20000
const LOCAL_FILTER_PORT = Number(process.env.LOCAL_FILTER_PORT || 8000)
const MAX_CONCURRENT_WORKERS = Number(process.env.NUMBER_OF_WORKERS)
const PROXY_HOST = process.env.PROXY_HOST as string
const PROXY_PORT = Number(process.env.PROXY_PORT)
const PROXY_USER = process.env.PROXY_USER as string
const PROXY_PASS = process.env.PROXY_PASS as string
const MAX_ITERATIONS = 1000000000
const WORKER_BATCH_SIZE = 500000000

enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

const LOG_MODE = (process.env.LOG_MODE === 'prod') ? 'prod' : 'debug'
const CURRENT_LOG_LEVEL = LOG_MODE === 'debug' ? LogLevel.DEBUG : LogLevel.ERROR

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
const DEBUG_MODE = process.env.DEBUG_MODE === 'true'
const TARGET_HOST = (() => { try { return new URL(TARGET_URL).hostname } catch { return '' } })()

// Centralized cache for frequently requested files
const fileCache = new Map<string, { content: Buffer, contentType: string }>()
const CACHED_FILES: string[] = []

let globalProxyBytesUp = 0
let globalProxyBytesDown = 0
let globalProxyBlocked = 0

function startLocalFilterProxy(): void {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const allow = new RegExp(`(?:\\.|^)pcdelv\\.com$|(?:\\.|^)popcash\\.net$|^${esc(TARGET_HOST)}$`, 'i')
  const upstreamHost = PROXY_HOST
  const upstreamPort = PROXY_PORT
  const authHeader = (PROXY_USER || PROXY_PASS) ? 'Proxy-Authorization: Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64') + '\r\n' : ''

  const server = net.createServer((clientSocket) => {
    let bufferedFromClient: Buffer[] = []
    let tunnelEstablished = false
    let isConnect = false
    let targetHost = ''
    let targetPort = 443

    const flush = () => { for (const b of bufferedFromClient) try { upstream.write(b) } catch {} bufferedFromClient = [] }
    let upstream: net.Socket

    clientSocket.once('data', (firstChunk: Buffer) => {
      try {
        const reqText = firstChunk.toString('utf8')
        const firstLineEnd = reqText.indexOf('\r\n')
        const firstLine = firstLineEnd >= 0 ? reqText.slice(0, firstLineEnd) : ''
        isConnect = firstLine.startsWith('CONNECT ')
        if (isConnect) {
          const m = firstLine.match(/^CONNECT\s+([^:\s]+):(\d+)/i)
          if (m) { targetHost = m[1]; targetPort = Number(m[2]) || 443 }
        } else {
          const m = firstLine.match(/^[A-Z]+\s+https?:\/\/([^\/:\s]+)(?::(\d+))?/i)
          if (m) { targetHost = m[1]; if (m[2]) targetPort = Number(m[2]) }
          if (!targetHost) {
            const hostMatch = reqText.match(/\r\nHost:\s*([^\r\n]+)/i)
            if (hostMatch) {
              const hp = hostMatch[1].trim().split(':')
              targetHost = hp[0]; if (hp[1]) targetPort = Number(hp[1])
            }
          }
        }

        if (!allow.test(targetHost)) {
          globalProxyBlocked++
          try { clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nfiltered') } catch {}
          try { clientSocket.destroy() } catch {}
          return
        }

        upstream = net.connect({ host: upstreamHost, port: upstreamPort }, () => {
          if (isConnect) {
            const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`
            upstream.write(connectReq)
          } else {
            let proxyReq = reqText
            if (!/\r\nProxy-Authorization:/i.test(proxyReq) && authHeader) {
              proxyReq = proxyReq.replace(/\r\n\r\n/, `\r\n${authHeader}\r\n`)
            }
            upstream.write(Buffer.from(proxyReq, 'utf8'))
          }
        })

        // Counters
        clientSocket.on('data', (d) => { globalProxyBytesUp += d.length })
        upstream.on('data', (d) => { globalProxyBytesDown += d.length })

        upstream.on('data', (data) => {
          if (isConnect && !tunnelEstablished) {
            const resp = data.toString('utf8')
            const headerEnd = resp.indexOf('\r\n\r\n')
            if (headerEnd !== -1) {
              if (/^HTTP\/1\.[01]\s+200/i.test(resp)) {
                tunnelEstablished = true
                try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n') } catch {}
                const remain = data.slice(headerEnd + 4)
                if (remain.length) clientSocket.write(remain)
                flush()
                return
              } else {
                try { clientSocket.write(data) } catch {}
                try { clientSocket.destroy() } catch {}
                try { upstream.destroy() } catch {}
                return
              }
            }
          } else {
            clientSocket.write(data)
          }
        })

        upstream.on('error', () => { try { clientSocket.destroy() } catch {} })
        clientSocket.on('error', () => { try { upstream.destroy() } catch {} })
        clientSocket.on('close', () => { try { upstream.destroy() } catch {} })
        upstream.on('close', () => { try { clientSocket.destroy() } catch {} })

        clientSocket.on('data', (data) => {
          if (isConnect && !tunnelEstablished) {
            bufferedFromClient.push(data)
          } else {
            upstream.write(data)
          }
        })
      } catch {
        try { clientSocket.destroy() } catch {}
      }
    })
  })

  server.listen(LOCAL_FILTER_PORT, () => {
    logInfo(`[PROXY] Tunnel filter on :${LOCAL_FILTER_PORT} → ${PROXY_HOST}:${PROXY_PORT} (allow *.pcdelv.com *.popcash.net ${TARGET_HOST})`)
  })
}

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

async function createBrowserWithProxy(_proxyPort: number) {
  const proxyConfig = {
    server: `http://127.0.0.1:${LOCAL_FILTER_PORT}`
  }
  
  return await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      // === make Chrome shut up ===
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
      
      // === stop remaining traffic before route handler ===
      '--disable-quic',
      '--dns-prefetch-disable',
      '--disable-features=PreconnectToOrigins,PrefetchPrivacyChanges',
      '--disable-features=DnsOverHttps,AsyncDns',
      
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
      '--disable-features=VizDisplayCompositor',
      '--ignore-certificate-errors'
    ],
    proxy: proxyConfig
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
  const startProxyUp = globalProxyBytesUp
  const startProxyDown = globalProxyBytesDown
  const browser = await createBrowserWithProxy(proxyPort)
  let isClosing = false
  let wasSuccessful = false
  const diagEvents: string[] = []
  const addDiag = (m: string) => { if (DEBUG_MODE) diagEvents.push(`[W${workerId}] ${new Date().toISOString()} ${m}`) }
  const getProxyDelta = (): { bytesSent: number, bytesReceived: number } => ({
    bytesSent: Math.max(0, globalProxyBytesUp - startProxyUp),
    bytesReceived: Math.max(0, globalProxyBytesDown - startProxyDown)
  })

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
      try { tmp.close() } catch (e) {}
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

  async function waitForFinalOnPage(p: any, timeoutMs = 17000): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const onReq = (req: any) => {
        const u = req.url()
        if (u.includes('p.pcdelv.com/v2/') && u.endsWith('/cl')) {
          // Small delay to ensure request completes before cleanup
          setTimeout(() => cleanup(true), 300)
          return
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
    extraHTTPHeaders: { 'Accept-Language': `${detectedLocale.split('-')[0]}-${detectedLocale.split('-')[1]},${detectedLocale.split('-')[0]};q=0.9,en;q=0.8` },
    ignoreHTTPSErrors: true
  })
  
  logDebug(`[W${workerId}] [BROWSER] User agent: ${userAgent.toString()}`)

  const page = await context.newPage()
  
  // Simple route handler for caching only (no aborts)
  await page.route('**/*', async (route) => {
    try {
      const url = route.request().url()
      addDiag(`[ROUTE] ${url}`)
      
      // Check if this file should be served from cache
      if (CACHED_FILES.includes(url)) {
        if (fileCache.has(url)) {
          // Serve from pre-loaded cache
          const cached = fileCache.get(url)!
          globalCacheHits++
          globalCacheBytesSaved += cached.content.length
          logDebug(`[W${workerId}] [CACHE HIT] Serving ${url} from cache (${formatBytes(cached.content.length)})`)
          addDiag(`[CACHE HIT] ${url}`)
          await route.fulfill({
            status: 200,
            contentType: cached.contentType,
            body: cached.content
          })
          return
        }
      }
      
      await route.continue()
    } catch (e) {
      logDebug(`[W${workerId}] [ROUTE ERROR] ${route.request().url()}: ${e instanceof Error ? e.message : String(e)}`)
      addDiag(`[ROUTE ERROR] ${route.request().url()} ${e instanceof Error ? e.message : String(e)}`)
      try {
        await route.continue()
      } catch (continueError) {}
    }
  })
  
  // Extra diagnostics: log failed requests and HTTP errors
  page.on('requestfailed', (request) => {
    const failure = request.failure()
    logWarn(`[W${workerId}] [REQ FAILED] ${request.url()} - ${failure ? failure.errorText : 'unknown'}`)
    addDiag(`[REQ FAILED] ${request.method()} ${request.url()} ${failure ? failure.errorText : 'unknown'}`)
  })
  page.on('response', (response) => {
    const status = response.status()
    if (status >= 400) {
      logWarn(`[W${workerId}] [HTTP ${status}] ${response.url()}`)
    }
    addDiag(`[RESP] ${status} ${response.url()}`)
  })

  // Track requests only for diagnostics and success detection; byte counting is in proxy
  page.on('request', (request) => {
    const url = request.url()
    addDiag(`[REQ] ${request.method()} ${url}`)
    
    // Debug: log when the initial redirect endpoint is hit
    if (url.includes('p.pcdelv.com/go/')) {
      logInfo(`[W${workerId}] [REDIRECT SEEN] HTTP go endpoint requested: ${url}`)
      addDiag(`[REDIRECT SEEN] ${url}`)
    }

    // Detect final PopCash conversion endpoint
    if (url.includes('p.pcdelv.com/v2/') && url.endsWith('/cl')) {
      wasSuccessful = true
      if (LOG_MODE === 'prod') {
        console.log(`[W${workerId}] SUCCESS ${url}`)
      } else {
        logInfo(`[W${workerId}] [SUCCESS] Final PopCash endpoint reached: ${url}`)
      }
      addDiag(`[SUCCESS] ${url}`)
    }
    
    logDebug(`[W${workerId}] [REQUEST] ${request.method()} ${url}`)
  })
  
  page.on('response', async (response) => {
    if (isClosing) return // Skip processing if browser is closing
    
    try {
      const url = response.url()
      const status = response.status()
      let isCacheHit = false
      
      // Check if this was served from pre-loaded cache
      if (CACHED_FILES.includes(url) && fileCache.has(url)) {
        isCacheHit = true
      } else {
        // no size accounting here; proxy counts bytes
      }
      
      logDebug(`[W${workerId}] [RESPONSE] ${status} ${url}`)
      if (isCacheHit) {
        logDebug(`[W${workerId}]   Served from preloaded cache: ${url}`)
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
    addDiag(`[GOTO] ${TARGET_URL}`)
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 7000 })
    } catch (e) {
      logWarn(`[W${workerId}] [TIMEOUT] Page load timeout or error: ${e instanceof Error ? e.message : String(e)}`)
      addDiag(`[GOTO ERROR] ${e instanceof Error ? e.message : String(e)}`)
    try {
      await page.close()
      await context.close()
      await browser.close()
    } catch (e) {}
      const d = getProxyDelta()
      return { bytesSent: d.bytesSent, bytesReceived: d.bytesReceived, success: wasSuccessful }
  }
  
  if (page.isClosed()) { const d = getProxyDelta(); return { bytesSent: d.bytesSent, bytesReceived: d.bytesReceived, success: wasSuccessful } }

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
  // Wait for ad div to mount with polling (max 7s)
  let targetDiv = null
  const maxWaitTime = 10000
  const pollInterval = 500
  const startTime = Date.now()
  
  while (!targetDiv && (Date.now() - startTime) < maxWaitTime) {
    targetDiv = await page.$('div[style*="z-index:9999999"], div[style*="position:fixed"][style*="z-index"]')
    
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
    
    if (!targetDiv && (Date.now() - startTime) < maxWaitTime) {
      await page.waitForTimeout(pollInterval)
    }
  }
  
  if (targetDiv) {
    addDiag(`[AD DIV FOUND] after ${Date.now() - startTime}ms`)
  } else {
    addDiag(`[AD DIV NOT FOUND] timeout after ${maxWaitTime}ms`)
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
    try { await targetDiv.click({ force: true }); addDiag('[CLICK] targetDiv clicked') } catch (e) { addDiag(`[CLICK ERROR] ${e instanceof Error ? e.message : String(e)}`) }
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
      addDiag(`[POPUP] opened ${openedUrl || 'about:blank'} sameTarget=${openedIsSameTarget}`)
      if (openedIsSameTarget) {
        // Case 1: Pop-under - close new tab, wait on original
        try { await opened.bringToFront() } catch (e) {}
        try { await opened.close() } catch (e) {}
        try { await page.bringToFront() } catch (e) {}
        // Wait for redirect chain on original quickly via request observation
        try { addDiag('[WAIT] final on original'); wasSuccessful = await waitForFinalOnPage(page, DEBUG_MODE ? 60000 : 15000); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
        if (wasSuccessful) {
          isClosing = true
          // Extra delay to let the success request fully complete
          await new Promise(resolve => setTimeout(resolve, 500))
          try { await page.waitForLoadState('networkidle', { timeout: DEBUG_MODE ? 60000 : 400 }) } catch (e) {}
          try { await browser.close() } catch (e) {}
          const d = getProxyDelta()
          return { bytesSent: d.bytesSent, bytesReceived: d.bytesReceived, success: wasSuccessful }
        }
      } else {
        // Case 2: Pop-up - close original, wait on new window
        try { await opened.bringToFront() } catch (e) {}
        try { addDiag('[WAIT] final on popup'); wasSuccessful = await waitForFinalOnPage(opened, DEBUG_MODE ? 60000 : 15000); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
        // Extra delay to let the success request fully complete
        if (wasSuccessful) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        try { await page.close() } catch (e) {}
        try { await opened.waitForLoadState('domcontentloaded', { timeout: DEBUG_MODE ? 60000 : 300 }).catch(() => {}) } catch (e) {}
        try { await browser.close() } catch (e) {}
        const d = getProxyDelta()
        return { bytesSent: d.bytesSent, bytesReceived: d.bytesReceived, success: wasSuccessful }
      }
    } else {
      // No new page; check if current navigated
      try { addDiag('[WAIT] final on same page'); wasSuccessful = await waitForFinalOnPage(page, DEBUG_MODE ? 60000 : 15000); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
      if (wasSuccessful) {
        isClosing = true
        // Extra delay to let the success request fully complete
        await new Promise(resolve => setTimeout(resolve, 500))
        try { await page.waitForLoadState('networkidle', { timeout: DEBUG_MODE ? 60000 : 300 }) } catch (e) {}
        try { await browser.close() } catch (e) {}
        const d = getProxyDelta()
        return { bytesSent: d.bytesSent, bytesReceived: d.bytesReceived, success: wasSuccessful }
      }
    }
  }
  else {
    addDiag('[AD DIV NOT FOUND]')
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
  
  if (!wasSuccessful) {
    if (DEBUG_MODE) {
      const d = getProxyDelta()
      console.log(`[W${workerId}] DEBUG FAIL bytesUp=${formatBytes(d.bytesSent)} bytesDown=${formatBytes(d.bytesReceived)} events=${diagEvents.length}`)
      for (const e of diagEvents) console.log(e)
    }
    if (LOG_MODE === 'prod') {
      console.log(`[W${workerId}] FAIL`)
    }
  }
  
  const d = getProxyDelta()
  return { bytesSent: d.bytesSent, bytesReceived: d.bytesReceived, success: wasSuccessful }
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
  logInfo(`[PROXY] Filter Totals: Up ${formatBytes(globalProxyBytesUp)}, Down ${formatBytes(globalProxyBytesDown)}, Blocked ${globalProxyBlocked}`)
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
  logInfo(`Proxy Host: ${PROXY_HOST}, Ports: ${PROXY_PORT_START}-${PROXY_PORT_END}`)
  logInfo('============================\n')
  
  // Start local filter proxy; route Node fetch directly via DataImpulse to avoid TLS MITM
  startLocalFilterProxy()
  if (PROXY_HOST && PROXY_PORT) {
    const auth = PROXY_USER && PROXY_PASS ? `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@` : ''
    setGlobalDispatcher(new ProxyAgent(`http://${auth}${PROXY_HOST}:${PROXY_PORT}`))
  }

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

    workerStats.clear()
    const workerPromises: Promise<void>[] = []
    for (let workerId = 0; workerId < MAX_CONCURRENT_WORKERS; workerId++) {
      const actualIterations = Math.min(iterationsPerWorker, remainingIterations - (workerId * iterationsPerWorker))
      if (actualIterations > 0) {
        workerPromises.push(runWorker(workerId, actualIterations))
      }
    }
    await Promise.all(workerPromises)
    totalIterationsRun += iterationsThisBatch
    
    logInfo(`\n=== BATCH ${batchNumber} COMPLETED ===`)
    logInfo(`Total iterations completed: ${totalIterationsRun}/${MAX_ITERATIONS}`)
    await printStats()
    
    if (totalIterationsRun < MAX_ITERATIONS) {
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
  
  clearInterval(statsInterval)
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
