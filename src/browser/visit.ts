import UserAgent = require('user-agents')
import { createBrowserWithProxy } from '@/browser/create'
import {
  AFTER_SUCCESS_EXTRA_DELAY_MS,
  DEBUG_MAX_WAIT_MS,
  DEBUG_MODE,
  DOMCONTENTLOADED_TIMEOUT_SHORT_MS,
  NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_MS,
  NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_SHORT_MS,
  NEW_PAGE_NETWORKIDLE_TIMEOUT_MS,
  NORMAL_MAX_WAIT_MS,
  PAGE_DEFAULT_NAV_TIMEOUT_MS,
  PAGE_DEFAULT_TIMEOUT_MS,
  PAGE_GOTO_TIMEOUT_MS,
  POPUP_DETECTION_GRACE_MS,
  PRE_CLICK_PREPARE_MS,
  TARGET_URL,
  VISIT_SITE_OVERALL_TIMEOUT_MS,
  WAIT_FOR_FINAL_ON_PAGE_DEFAULT_MS,
  AD_DIV_MAX_WAIT_MS,
  AD_DIV_POLL_INTERVAL_MS,
  POST_CLICK_SHORT_WAIT_MS,
} from '@/config'
import { fileCache, CACHED_FILES, recordCacheHit } from '@/cache'
import { CACHE_ENABLED } from '@/config'
import { detectGeoViaProxy, localeFromCountry } from '@/network/geo'
import { formatBytes } from '@/utils'
import { LogLevel, logDebug, logError, logInfo, logWarn } from '@/logger'
import { BANDWIDTH_ANALYSIS } from '@/config'
import { ITERATIONS_PER_IP } from '@/config'

export async function visitSite(proxyPort: number, workerId: number): Promise<{ bytesSent: number, bytesReceived: number, success: boolean }> {
  return Promise.race([
    visitSiteInternal(proxyPort, workerId),
    new Promise<{ bytesSent: number, bytesReceived: number, success: boolean }>((_, reject) =>
      setTimeout(() => reject(new Error(`visitSite timeout after ${VISIT_SITE_OVERALL_TIMEOUT_MS} ms`)), VISIT_SITE_OVERALL_TIMEOUT_MS)
    )
  ]).catch(async (error) => {
    logError(`[W${workerId}] [TIMEOUT] visitSite timed out or errored: ${error instanceof Error ? error.message : String(error)}`)
    return { bytesSent: 0, bytesReceived: 0, success: false }
  })
}

async function visitSiteInternal(proxyPort: number, workerId: number): Promise<{ bytesSent: number, bytesReceived: number, success: boolean }> {
  const browser = await createBrowserWithProxy(proxyPort)
  let isClosing = false
  let wasSuccessful = false
  const diagEvents: string[] = []
  const addDiag = (m: string) => {
    diagEvents.push(`[W${workerId}] ${new Date().toISOString()} ${m}`)
    if (!DEBUG_MODE && diagEvents.length > 200) diagEvents.shift()
  }

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
    const g = await detectGeoViaProxy(proxyPort)
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

  // Optional bandwidth analysis via CDP
  const bwByRequest: Map<string, { url: string, type: string, encodedBytes: number }> = new Map()
  let cdpSession: any = null
  if (BANDWIDTH_ANALYSIS) {
    try {
      cdpSession = await context.newCDPSession(page)
      await cdpSession.send('Network.enable')
      cdpSession.on('Network.responseReceived', (e: any) => {
        try {
          const id = e.requestId
          const url = e.response?.url || ''
          const type = e.type || e.response?.mimeType || 'unknown'
          if (!bwByRequest.has(id)) bwByRequest.set(id, { url, type, encodedBytes: 0 })
          else {
            const v = bwByRequest.get(id)!
            v.url = url || v.url
            v.type = type || v.type
          }
        } catch {}
      })
      cdpSession.on('Network.loadingFinished', (e: any) => {
        try {
          const id = e.requestId
          const bytes = typeof e.encodedDataLength === 'number' ? e.encodedDataLength : 0
          if (!bwByRequest.has(id)) bwByRequest.set(id, { url: '', type: 'unknown', encodedBytes: bytes })
          else {
            const v = bwByRequest.get(id)!
            v.encodedBytes += bytes
          }
        } catch {}
      })
    } catch {}
  }

  function emitBandwidthSummary(): void {
    try {
      const entries: { url: string, type: string, encodedBytes: number }[] = Array.from(bwByRequest.values())
      const total = entries.reduce((s, entry) => s + (entry.encodedBytes || 0), 0)
      entries.sort((a, b) => (b.encodedBytes || 0) - (a.encodedBytes || 0))
      const top = entries.slice(0, 10)
      logInfo(`[BANDWIDTH] Total received: ${formatBytes(total)} in ${entries.length} requests`)
      for (const entry of top) {
        logInfo(`[BANDWIDTH] ${formatBytes(entry.encodedBytes)} ${entry.type} ${entry.url}`)
      }
    } catch {}
  }

  // Single external hop control
  const INTERNAL_HOSTS = [
    'pcdelv.com',
    '.pcdelv.com',
    'popcash.net',
    '.popcash.net',
    new URL(TARGET_URL).hostname
  ]
  let externalHost: string | null = null
  let externalHit = false

  await page.route('**/*', async (route) => {
    try {
      const url = route.request().url()
      const resourceType = route.request().resourceType()
      addDiag(`[ROUTE] ${url}`)
      // Serve from cache if available
      if (CACHE_ENABLED && CACHED_FILES.includes(url)) {
        if (fileCache.has(url)) {
          const cached = fileCache.get(url)!
          recordCacheHit(cached.content.length)
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

      // Hard block heavy or unnecessary resource types before network
      // Block globally: images, stylesheets, fonts, media, websockets, SSE, manifest
      if (
        resourceType === 'image' ||
        resourceType === 'stylesheet' ||
        resourceType === 'font' ||
        resourceType === 'media' ||
        resourceType === 'websocket' ||
        resourceType === 'eventsource' ||
        resourceType === 'manifest'
      ) {
        addDiag(`[ABORT TYPE] ${resourceType} ${url}`)
        return await route.abort()
      }

      // Allow exactly one script: PopCash show.js (should be served from cache). Block all other scripts.
      if (resourceType === 'script') {
        try {
          const u = new URL(url)
          const isShowJs = u.hostname.endsWith('popcash.net')
          if (!isShowJs) {
            addDiag(`[ABORT SCRIPT] ${url}`)
            return await route.abort()
          }
        } catch {
          addDiag(`[ABORT SCRIPT] malformed ${url}`)
          return await route.abort()
        }
      }

      // Domain-based allowlist with exactly one external hop after /cl
      const host = new URL(url).hostname.toLowerCase()
      const isInternal = INTERNAL_HOSTS.some(d => host === d.replace(/^\./, '') || host.endsWith(d))

      if (isInternal) {
        return await route.continue()
      }

      if (externalHost && host === externalHost) {
        if (!externalHit) {
          externalHit = true
          addDiag(`[ALLOW ONCE] external ${host}`)
          return await route.continue()
        }
        addDiag(`[ABORT] subsequent external ${host}`)
        return await route.abort()
      }

      addDiag(`[ABORT] non-internal ${host}`)
      return await route.abort()
    } catch (e) {
      logDebug(`[W${workerId}] [ROUTE ERROR] ${route.request().url()}: ${e instanceof Error ? e.message : String(e)}`)
      addDiag(`[ROUTE ERROR] ${route.request().url()} ${e instanceof Error ? e.message : String(e)}`)
      try { await route.continue() } catch {}
    }
  })

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

  page.on('request', (request) => {
    const url = request.url()
    addDiag(`[REQ] ${request.method()} ${url}`)
    if (url.includes('p.pcdelv.com/go/')) {
      logInfo(`[W${workerId}] [REDIRECT SEEN] HTTP go endpoint requested: ${url}`)
      addDiag(`[REDIRECT SEEN] ${url}`)
    }
    logDebug(`[W${workerId}] [REQUEST] ${request.method()} ${url}`)
  })

  page.on('response', async (response) => {
    if (isClosing) return
    try {
      const url = response.url()
      const status = response.status()
      let isCacheHit = false
      if (CACHED_FILES.includes(url) && fileCache.has(url)) {
        isCacheHit = true
      }
      logDebug(`[W${workerId}] [RESPONSE] ${status} ${url}`)
      // Discover external host from /cl Location header
      if (url.includes('/cl') && status >= 300 && status < 400) {
        try {
          const headers = response.headers() as any
          let loc: string | undefined = (headers['location'] || headers['Location']) as any
          if (!loc) { /* no-op */ }
          else {
            if (loc.startsWith('//')) loc = 'http:' + loc
            if (!loc.startsWith('http')) loc = new URL(loc, url).href
            try {
              const discoveredHost = new URL(loc).hostname.toLowerCase()
              externalHost = discoveredHost
              logInfo(`[W${workerId}] [ALLOW ONCE] external host set to ${externalHost}`)
              addDiag(`[ALLOW ONCE] external host ${externalHost}`)
            } catch {}
          }
        } catch (e) {}
      }
      if (isCacheHit) {
        logDebug(`[W${workerId}]   Served from preloaded cache: ${url}`)
      }
    } catch (e) {
      if (!isClosing) {
        logDebug(`[W${workerId}] [RESPONSE ERROR] ${response.url()}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  })

  // External hop timeout guard
  const EXTERNAL_TIMEOUT = 7000
  page.waitForRequest(req => {
    try {
      return !!externalHost && new URL(req.url()).hostname.toLowerCase() === externalHost
    } catch { return false }
  }, { timeout: EXTERNAL_TIMEOUT }).catch(() => logWarn(`[W${workerId}] external hop never happened`))

  // Abort all network after the single external request completes
  page.on('requestfinished', (req) => {
    try {
      const host = new URL(req.url()).hostname.toLowerCase()
      if (externalHit && externalHost && host === externalHost) {
        addDiag('[SHUTDOWN] external hop done, aborting further requests')
        page.route('**/*', r => r.abort())
      }
    } catch {}
  })



  await page.addInitScript(() => {
    delete (window as any).navigator.webdriver
    delete (window as any).navigator.__proto__.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true, enumerable: true })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    ;(window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) }
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

  page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS)
  page.setDefaultNavigationTimeout(PAGE_DEFAULT_NAV_TIMEOUT_MS)

  try {
    addDiag(`[GOTO] ${TARGET_URL}`)
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS })
  } catch (e) {
    logWarn(`[W${workerId}] [TIMEOUT] Page load timeout after ${PAGE_GOTO_TIMEOUT_MS}ms: ${e instanceof Error ? e.message : String(e)}`)
    addDiag(`[TIMEOUT] Page goto after ${PAGE_GOTO_TIMEOUT_MS}ms: ${e instanceof Error ? e.message : String(e)}`)
    try { await page.close(); await context.close(); await browser.close() } catch {}
    return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
  }

  if (page.isClosed()) { return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful } }

  try {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('load'))
    })
  } catch (e) {}

  let targetDiv: any = null
  const maxWaitTime = AD_DIV_MAX_WAIT_MS
  const pollInterval = AD_DIV_POLL_INTERVAL_MS
  const startTime = Date.now()
  while (!targetDiv && (Date.now() - startTime) < maxWaitTime) {
    targetDiv = await page.$('div[style*="z-index:9999999"], div[style*="position:fixed"][style*="z-index"]')
    if (!targetDiv) {
      const candidates = await page.$$('div')
      for (const div of candidates) {
        const style = await (div as any).getAttribute('style')
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

    await page.waitForTimeout(PRE_CLICK_PREPARE_MS)
    const pagesBefore = context.pages()
    const allPagesBefore = browser.contexts().flatMap((c: any) => c.pages())
    let popupWait: any = null
    let ctxPageWait: any = null
    try {
      const detectMs = Math.max(POST_CLICK_SHORT_WAIT_MS + POPUP_DETECTION_GRACE_MS, 8000)
      popupWait = page.waitForEvent('popup', { timeout: detectMs }).catch(() => null)
      ctxPageWait = context.waitForEvent('page', { timeout: detectMs }).catch(() => null)
    } catch {}
    try { await (targetDiv as any).click({ force: true }); addDiag('[CLICK] targetDiv clicked') } catch (e) { addDiag(`[CLICK ERROR] ${e instanceof Error ? e.message : String(e)}`) }
    const openedViaEvent: any = (await popupWait) || (await ctxPageWait)
    if (!openedViaEvent) {
      const detectUntil = Date.now() + Math.max(POST_CLICK_SHORT_WAIT_MS + POPUP_DETECTION_GRACE_MS, 8000)
      let found = false
      while (!found && Date.now() < detectUntil) {
        const nowPagesAll = browser.contexts().flatMap((c: any) => c.pages())
        const diffAll = nowPagesAll.find(p => !allPagesBefore.includes(p))
        if (diffAll) { found = true; (openedViaEvent as any) = diffAll; break }
        await page.waitForTimeout(200)
      }
      if (!openedViaEvent) {
        await page.waitForTimeout(POST_CLICK_SHORT_WAIT_MS)
        await page.waitForTimeout(POPUP_DETECTION_GRACE_MS)
      }
    }
    const pagesAfterAll = browser.contexts().flatMap((c: any) => c.pages())
    const opened = openedViaEvent || pagesAfterAll.find(p => !allPagesBefore.includes(p))
    if (opened) {
      const openedUrl = opened.url()
      const openedHasOpener = !!opened.opener()
      const openedIsSameTarget = openedUrl === TARGET_URL || openedUrl === 'about:blank'
      let kind: 'tab' | 'window' | 'unknown' = 'unknown'
      try {
        const openerId = await getWindowId(page)
        const openedId = await getWindowId(opened)
        if (openerId !== null && openedId !== null) {
          kind = openerId === openedId ? 'tab' : 'window'
        }
      } catch {}
      const tag = kind === 'window' ? '[NEW WINDOW]' : kind === 'tab' ? '[NEW TAB]' : '[NEW PAGE]'
      addDiag(`${tag} ${openedUrl || 'about:blank'} opener=${openedHasOpener} sameTarget=${openedIsSameTarget}`)
      logInfo(`[W${workerId}] ${tag} url=${openedUrl || 'about:blank'} opener=${openedHasOpener} sameTarget=${openedIsSameTarget}`)
      if (openedIsSameTarget) {
        try { await opened.bringToFront() } catch {}
        try { await opened.close() } catch {}
        try { await page.bringToFront() } catch {}
        try { addDiag('[WAIT] final on original'); wasSuccessful = await waitForFinalOnPage(page, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
        if (wasSuccessful) {
          isClosing = true
          await new Promise(resolve => setTimeout(resolve, AFTER_SUCCESS_EXTRA_DELAY_MS))
          try { await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_MS }) } catch (e) { addDiag(`[TIMEOUT] Page networkidle after success: ${e instanceof Error ? e.message : String(e)}`) }
          try { await browser.close() } catch {}
          if (BANDWIDTH_ANALYSIS) emitBandwidthSummary()
          return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
        }
      } else {
        try { await opened.bringToFront() } catch {}
        try { addDiag('[WAIT] final on popup'); wasSuccessful = await waitForFinalOnPage(opened, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
        if (wasSuccessful) {
          await new Promise(resolve => setTimeout(resolve, AFTER_SUCCESS_EXTRA_DELAY_MS))
        }
        try { await page.close() } catch {}
        try { await opened.waitForLoadState('domcontentloaded', { timeout: DOMCONTENTLOADED_TIMEOUT_SHORT_MS }).catch((e: any) => { addDiag(`[TIMEOUT] Popup domcontentloaded: ${e instanceof Error ? e.message : String(e)}`) }) } catch (e) { addDiag(`[ERROR] Popup domcontentloaded error: ${e instanceof Error ? e.message : String(e)}`) }
        try { await browser.close() } catch {}
        if (BANDWIDTH_ANALYSIS) emitBandwidthSummary()
        return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
      }
    } else {
      try { addDiag('[WAIT] final on same page'); wasSuccessful = await waitForFinalOnPage(page, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
      if (wasSuccessful) {
        isClosing = true
        await new Promise(resolve => setTimeout(resolve, AFTER_SUCCESS_EXTRA_DELAY_MS))
        try { await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_SHORT_MS }) } catch (e) { addDiag(`[TIMEOUT] Page networkidle after success (short): ${e instanceof Error ? e.message : String(e)}`) }
        try { await browser.close() } catch {}
        if (BANDWIDTH_ANALYSIS) emitBandwidthSummary()
        return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
      }
    }
  } else {
    addDiag('[AD DIV NOT FOUND]')
  }

  try {
    const contexts = browser.contexts()
    for (const context of contexts) {
      const pages = context.pages()
      for (const page of pages) {
        try { if (!page.isClosed()) { await page.close() } } catch {}
      }
      try { await context.close() } catch {}
    }
    await browser.close()
  } catch (e) {}

  if (BANDWIDTH_ANALYSIS) emitBandwidthSummary()

  if (!wasSuccessful) {
    if (DEBUG_MODE) {
      console.log(`[W${workerId}] DEBUG FAIL bytesUp=${formatBytes(0)} bytesDown=${formatBytes(0)} events=${diagEvents.length}`)
      for (const e of diagEvents) console.log(e)
    }
    const findLast = (pred: (s: string) => boolean) => {
      for (let i = diagEvents.length - 1; i >= 0; i--) if (pred(diagEvents[i])) return diagEvents[i]
      return undefined
    }
    const lastTimeout = findLast(s => s.includes('[TIMEOUT]'))
    const lastRouteErr = findLast(s => s.includes('[ROUTE ERROR]'))
    const lastReqFailed = findLast(s => s.includes('[REQ FAILED]'))
    const lastHTTP4xx = findLast(s => /\[RESP\]\s+4\d\d\b/.test(s))
    const lastHTTP5xx = findLast(s => /\[RESP\]\s+5\d\d\b/.test(s))
    const reason = lastTimeout || lastRouteErr || lastReqFailed || lastHTTP5xx || lastHTTP4xx || 'unknown'
    const tail = diagEvents.slice(-5).join(' | ')
    console.log(`[W${workerId}] FAIL bytesUp=${formatBytes(0)} bytesDown=${formatBytes(0)} reason=${typeof reason === 'string' ? reason : 'unknown'}`)
    if (tail) console.log(`[W${workerId}] FAIL tail: ${tail}`)
  }

  return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
}

export async function visitIpCycle(proxyPort: number, workerId: number): Promise<{ bytesSent: number, bytesReceived: number, success: boolean }> {
  const browser = await createBrowserWithProxy(proxyPort)
  const diagEvents: string[] = []
  const addDiag = (m: string) => {
    diagEvents.push(`[W${workerId}] ${new Date().toISOString()} ${m}`)
    if (!DEBUG_MODE && diagEvents.length > 200) diagEvents.shift()
  }

  try {
    const version = await browser.version()
    logDebug(`[W${workerId}] [BROWSER] Chrome version: ${version}`)
  } catch {}

  let detectedLocale = 'en-US'
  let detectedTz = 'America/New_York'
  let detectedGeo = { latitude: 40.7128, longitude: -74.006 }
  try {
    const g = await detectGeoViaProxy(proxyPort)
    detectedLocale = localeFromCountry(g.countryCode)
    detectedTz = g.timezone
    detectedGeo = { latitude: g.lat, longitude: g.lon }
    logInfo(`[W${workerId}] GEO ${g.countryCode} ${g.timezone} (${g.lat.toFixed(2)},${g.lon.toFixed(2)})`)
  } catch { logWarn(`[W${workerId}] GEO lookup failed, using defaults`) }

  const context = await browser.newContext({
    userAgent: new (require('user-agents'))({ deviceCategory: 'desktop' }).toString(),
    viewport: { width: 1920, height: 1080 },
    locale: detectedLocale,
    timezoneId: detectedTz,
    geolocation: detectedGeo,
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': `${detectedLocale.split('-')[0]}-${detectedLocale.split('-')[1]},${detectedLocale.split('-')[0]};q=0.9,en;q=0.8` },
    ignoreHTTPSErrors: true
  })

  const pending: Promise<void>[] = []
  let anySuccess = false

  const cleaner = await context.newPage()
  await cleaner.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS }).catch(() => {})

  async function clearPublisherState(): Promise<void> {
    try { await context.clearCookies() } catch {}
    try {
      if (cleaner.url() !== TARGET_URL) {
        await cleaner.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS }).catch(() => {})
      }
      await cleaner.evaluate(async () => {
        try { localStorage.clear() } catch {}
        try { sessionStorage.clear() } catch {}
        try {
          const dbs = await (window as any).indexedDB?.databases?.()
          if (Array.isArray(dbs)) {
            for (const db of dbs) {
              try { if (db && db.name) (window as any).indexedDB.deleteDatabase(db.name) } catch {}
            }
          }
        } catch {}
        try {
          const c = await (window as any).caches?.keys?.()
          if (Array.isArray(c)) {
            for (const k of c) { try { await (window as any).caches.delete(k) } catch {} }
          }
        } catch {}
      })
      await cleaner.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    } catch {}
  }

  function configurePage(page: any) {
    const INTERNAL_HOSTS = [ 'pcdelv.com', '.pcdelv.com', 'popcash.net', '.popcash.net', new URL(TARGET_URL).hostname ]
    let externalHost: string | null = null
    let externalHit = false

    page.route('**/*', async (route: any) => {
      try {
        const url = route.request().url()
        const resourceType = route.request().resourceType()
        addDiag(`[ROUTE] ${url}`)
        if (CACHE_ENABLED && CACHED_FILES.includes(url)) {
          if (fileCache.has(url)) {
            const cached = fileCache.get(url)!
            recordCacheHit(cached.content.length)
            addDiag(`[CACHE HIT] ${url}`)
            await route.fulfill({ status: 200, contentType: cached.contentType, body: cached.content })
            return
          }
        }
        if (
          resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' ||
          resourceType === 'media' || resourceType === 'websocket' || resourceType === 'eventsource' || resourceType === 'manifest'
        ) { addDiag(`[ABORT TYPE] ${resourceType} ${url}`); return await route.abort() }
        if (resourceType === 'script') {
          try {
            const u = new URL(url)
            const isShowJs = u.hostname === 'cdn.popcash.net' && u.pathname === '/show.js'
            if (!isShowJs) { addDiag(`[ABORT SCRIPT] ${url}`); return await route.abort() }
          } catch { addDiag(`[ABORT SCRIPT] malformed ${url}`); return await route.abort() }
        }
        const host = new URL(url).hostname.toLowerCase()
        const isInternal = INTERNAL_HOSTS.some((d: string) => host === d.replace(/^\./, '') || host.endsWith(d))
        if (isInternal) { return await route.continue() }
        if (externalHost && host === externalHost) {
          if (!externalHit) { externalHit = true; addDiag(`[ALLOW ONCE] external ${host}`); return await route.continue() }
          addDiag(`[ABORT] subsequent external ${host}`); return await route.abort()
        }
        addDiag(`[ABORT] non-internal ${host}`); return await route.abort()
      } catch { try { await route.continue() } catch {} }
    })

    page.on('response', async (response: any) => {
      try {
        const url = response.url()
        const status = response.status()
        if (url.includes('/cl') && status >= 300 && status < 400) {
          try {
            const headers = response.headers() as any
            let loc: string | undefined = (headers['location'] || headers['Location']) as any
            if (loc) {
              if (loc.startsWith('//')) loc = 'http:' + loc
              if (!loc.startsWith('http')) loc = new URL(loc, url).href
              try { externalHost = new URL(loc).hostname.toLowerCase(); addDiag(`[ALLOW ONCE] external host ${externalHost}`) } catch {}
            }
          } catch {}
        }
      } catch {}
    })

    page.on('requestfinished', (req: any) => {
      try {
        const host = new URL(req.url()).hostname.toLowerCase()
        if (externalHit && externalHost && host === externalHost) {
          addDiag('[SHUTDOWN] external hop done, aborting further requests')
          page.route('**/*', (r: any) => r.abort())
        }
      } catch {}
    })
  }

  async function startIteration(): Promise<void> {
    const page = await context.newPage()
    if (BANDWIDTH_ANALYSIS) {
      try {
        const s = await context.newCDPSession(page)
        await s.send('Network.enable')
        s.on('Network.responseReceived', () => {})
        s.on('Network.loadingFinished', () => {})
      } catch {}
    }
    configurePage(page)
    try { await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS }) } catch {}
    try {
      await page.evaluate(() => {
        try { window.dispatchEvent(new Event('load')) } catch {}
      })
    } catch {}
    try {
      await page.waitForResponse((resp: any) => {
        try {
          const u = new URL(resp.url())
          return u.hostname.endsWith('popcash.net') && u.pathname.endsWith('/show.js')
        } catch { return false }
      }, { timeout: 3000 })
    } catch {}
    try { await page.waitForTimeout(150) } catch {}
    let targetDiv: any = null
    const maxWaitTime = AD_DIV_MAX_WAIT_MS
    const pollInterval = AD_DIV_POLL_INTERVAL_MS
    const startTime = Date.now()
    while (!targetDiv && (Date.now() - startTime) < maxWaitTime) {
      targetDiv = await page.$('div[style*="z-index:9999999"], div[style*="position:fixed"][style*="z-index"]')
      if (!targetDiv) {
        const candidates = await page.$$('div')
        for (const div of candidates) {
          const style = await (div as any).getAttribute('style')
          if (style && style.includes('z-index') && (style.includes('9999999') || style.includes('position:fixed'))) { targetDiv = div; break }
        }
      }
      if (!targetDiv && (Date.now() - startTime) < maxWaitTime) { await page.waitForTimeout(pollInterval) }
    }
    if (targetDiv) { addDiag(`[AD DIV FOUND] after ${Date.now() - startTime}ms`) } else { addDiag(`[AD DIV NOT FOUND] timeout after ${maxWaitTime}ms`) }
    const pagesBefore = context.pages()
    const allPagesBefore = browser.contexts().flatMap((c: any) => c.pages())
    let popupWait: any = null
    let ctxPageWait: any = null
    let detectMs = Math.max(POST_CLICK_SHORT_WAIT_MS + POPUP_DETECTION_GRACE_MS, 8000)
    try {
      popupWait = page.waitForEvent('popup', { timeout: detectMs }).catch(() => null)
      ctxPageWait = context.waitForEvent('page', { timeout: detectMs }).catch(() => null)
    } catch {}
    // Make the div definitely visible like in the original flow
    try {
      if (!page.isClosed() && page.url() === TARGET_URL && targetDiv) {
        await page.evaluate((element) => {
          const div = element as HTMLElement
          div.style.display = 'block'
          div.style.visibility = 'visible'
          div.style.opacity = '1'
        }, targetDiv)
      }
    } catch {}
    try { await page.waitForTimeout(PRE_CLICK_PREPARE_MS) } catch {}
    // Single click like the first tab
    try { await (targetDiv as any)?.click({ force: true }); addDiag('[CLICK] targetDiv clicked') } catch (e) { addDiag(`[CLICK ERROR] ${e instanceof Error ? e.message : String(e)}`) }
    const waiter = (async () => {
      try {
        let openedViaEvent: any = (await popupWait) || (await ctxPageWait)
        if (!openedViaEvent) {
          const detectUntil = Date.now() + Math.max(POST_CLICK_SHORT_WAIT_MS + POPUP_DETECTION_GRACE_MS, 8000)
          let found = false
          while (!found && Date.now() < detectUntil) {
            const nowPagesAll = browser.contexts().flatMap((c: any) => c.pages())
            const diffAll = nowPagesAll.find(p => !allPagesBefore.includes(p))
            if (diffAll) { found = true; (openedViaEvent as any) = diffAll; break }
            await page.waitForTimeout(200)
          }
          if (!openedViaEvent) {
            await page.waitForTimeout(POST_CLICK_SHORT_WAIT_MS)
            await page.waitForTimeout(POPUP_DETECTION_GRACE_MS)
          }
        }
        const pagesAfterAll = browser.contexts().flatMap((c: any) => c.pages())
        const opened = openedViaEvent || pagesAfterAll.find(p => !allPagesBefore.includes(p))
        if (opened) {
          const openedUrl = opened.url()
          const openedHasOpener = !!opened.opener()
          const openedIsSameTarget = openedUrl === TARGET_URL || openedUrl === 'about:blank'
          if (openedIsSameTarget) {
            try { await opened.bringToFront() } catch {}
            try { await opened.close() } catch {}
            try { await page.bringToFront() } catch {}
            try { anySuccess = await waitForFinalOnPage(page, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS) || anySuccess } catch {}
            try { await page.close() } catch {}
          } else {
            try { anySuccess = await waitForFinalOnPage(opened, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS) || anySuccess } catch {}
            try { await opened.close() } catch {}
          }
        } else {
          try { anySuccess = await waitForFinalOnPage(page, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS) || anySuccess } catch {}
          try { await page.close() } catch {}
        }
      } catch {}
    })()
    pending.push(waiter)
  }

  for (let i = 0; i < ITERATIONS_PER_IP; i++) {
    await startIteration()
    await clearPublisherState()
  }

  await Promise.allSettled(pending)

  try { await cleaner.close() } catch {}
  try { await context.close() } catch {}
  try { await browser.close() } catch {}

  return { bytesSent: 0, bytesReceived: 0, success: anySuccess }
}

function waitForFinalOnPage(p: any, timeoutMs = WAIT_FOR_FINAL_ON_PAGE_DEFAULT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const isInternalHost = (host: string | undefined): boolean => {
      if (!host) return true
      const h = host.toLowerCase()
      return h.endsWith('pcdelv.com') || h.endsWith('popcash.net')
    }
    const onResp = (resp: any) => {
      try {
        const u = resp.url()
        if (u.includes('p.pcdelv.com/v2/') && u.endsWith('/cl')) {
          const status = resp.status()
          if (status >= 300 && status < 400) {
            const headers = resp.headers?.() || {}
            const loc = headers['location'] || headers['Location']
            if (loc && typeof loc === 'string') {
              let host: string | undefined
              try {
                if (loc.startsWith('http://') || loc.startsWith('https://')) {
                  host = new URL(loc).hostname
                } else if (loc.startsWith('//')) {
                  host = new URL('http:' + loc).hostname
                } else {
                  host = undefined
                }
              } catch (e) {
                host = undefined
              }
              if (!isInternalHost(host)) {
                setTimeout(() => cleanup(true), 300)
              }
            }
          }
        }
      } catch (e) {}
    }
    const timer = setTimeout(() => cleanup(false), timeoutMs)
    function cleanup(result: boolean) {
      if (done) return
      done = true
      try { p.off('response', onResp) } catch (e) {}
      clearTimeout(timer)
      resolve(result)
    }
    try { p.on('response', onResp) } catch (e) { cleanup(false) }
  })
}

async function getWindowId(p: any): Promise<number | null> {
  try {
    const session = await p.context().newCDPSession(p)
    const res = await session.send('Browser.getWindowForTarget')
    return typeof res?.windowId === 'number' ? res.windowId : null
  } catch {
    return null
  }
}

// moved inside function scope above
