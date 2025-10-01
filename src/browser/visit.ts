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
import { detectGeoViaProxy, localeFromCountry } from '@/network/geo'
import { formatBytes } from '@/utils'
import { LogLevel, logDebug, logError, logInfo, logWarn } from '@/logger'

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

  await page.route('**/*', async (route) => {
    try {
      const url = route.request().url()
      addDiag(`[ROUTE] ${url}`)
      if (CACHED_FILES.includes(url)) {
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
      await route.continue()
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
      if (url.includes('p.pcdelv.com/v2/') && url.endsWith('/cl') && status >= 300 && status < 400) {
        try {
          const headers = response.headers() as any
          const loc = headers['location'] || headers['Location']
          if (loc && typeof loc === 'string') {
            let host: string | undefined
            try {
              if (loc.startsWith('http://') || loc.startsWith('https://')) {
                host = new URL(loc).hostname
              } else if (loc.startsWith('//')) {
                host = new URL('http:' + loc).hostname
              }
            } catch (e) {}
            const isInternal = host ? (host.toLowerCase().endsWith('pcdelv.com') || host.toLowerCase().endsWith('popcash.net')) : true
            if (!isInternal) {
              wasSuccessful = true
              logInfo(`[W${workerId}] [SUCCESS] External redirect after /cl: ${url} → ${loc}`)
              addDiag(`[SUCCESS] ${url} → ${loc}`)
            }
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

  context.on('page', async (newPage) => {
    logDebug(`[W${workerId}] [NEW PAGE] Opened: ${newPage.url()}`)
    addDiag(`[NEW PAGE] ${newPage.url()}`)
    try {
      await newPage.waitForLoadState('networkidle', { timeout: NEW_PAGE_NETWORKIDLE_TIMEOUT_MS })
      addDiag(`[NEW PAGE NETWORK IDLE] ${newPage.url()}`)
      wasSuccessful = true
      isClosing = true
      try { await newPage.close() } catch {}
      try { await page.close() } catch {}
      try { await context.close() } catch {}
      try { await browser.close() } catch {}
      return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
    } catch (e) {
      addDiag(`[TIMEOUT] New page networkidle after ${NEW_PAGE_NETWORKIDLE_TIMEOUT_MS}ms: ${e instanceof Error ? e.message : String(e)}`)
      try { await newPage.close({ runBeforeUnload: false }) } catch {}
    }
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
    try { await (targetDiv as any).click({ force: true }); addDiag('[CLICK] targetDiv clicked') } catch (e) { addDiag(`[CLICK ERROR] ${e instanceof Error ? e.message : String(e)}`) }
    await page.waitForTimeout(POST_CLICK_SHORT_WAIT_MS)
    await page.waitForTimeout(POPUP_DETECTION_GRACE_MS)
    const pagesAfter = context.pages()
    const opened = pagesAfter.find(p => !pagesBefore.includes(p))
    if (opened) {
      const openedUrl = opened.url()
      const openedIsSameTarget = openedUrl === TARGET_URL || openedUrl === 'about:blank'
      addDiag(`[POPUP] opened ${openedUrl || 'about:blank'} sameTarget=${openedIsSameTarget}`)
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
        return { bytesSent: 0, bytesReceived: 0, success: wasSuccessful }
      }
    } else {
      try { addDiag('[WAIT] final on same page'); wasSuccessful = await waitForFinalOnPage(page, DEBUG_MODE ? DEBUG_MAX_WAIT_MS : NORMAL_MAX_WAIT_MS); addDiag(`[WAIT DONE] success=${wasSuccessful}`) } catch (e) { addDiag(`[WAIT ERROR] ${e instanceof Error ? e.message : String(e)}`) }
      if (wasSuccessful) {
        isClosing = true
        await new Promise(resolve => setTimeout(resolve, AFTER_SUCCESS_EXTRA_DELAY_MS))
        try { await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_SHORT_MS }) } catch (e) { addDiag(`[TIMEOUT] Page networkidle after success (short): ${e instanceof Error ? e.message : String(e)}`) }
        try { await browser.close() } catch {}
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


