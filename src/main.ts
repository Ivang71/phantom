import { chromium, devices } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import UserAgent from 'user-agents'
import { config as loadEnv } from 'dotenv'
import { parse as parseUrl } from 'node:url'

// Add stealth plugin to avoid detection
chromium.use(StealthPlugin())

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

const TARGET_URL = 'https://globalstreaming.lol/'

async function main(): Promise<void> {
  console.log('🔧 Proxy config:', proxyConfig ? 'enabled' : 'disabled')
  
  /* --- launch Chromium with stealth and proxy --- */
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-first-run',
      '--disable-blink-features=AutomationControlled'
    ],
    ...(proxyConfig && { proxy: proxyConfig })
  })

  /* generate realistic user agent */
  const userAgent = new UserAgent({ deviceCategory: 'desktop' })
  console.log('🤖 Using User Agent:', userAgent.toString())
  
  const context = await browser.newContext({
    userAgent: userAgent.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation']
  })

  const page = await context.newPage()
  
  // Set up listener for new tabs/pages BEFORE any interactions
  context.on('page', async (newPage) => {
    console.log('🆕 New tab opened:', newPage.url())
    if (newPage.url() === TARGET_URL) {
      console.log('🗑️  Closing duplicate tab')
      await newPage.close()
    }
  })
  
  // Hide automation traces
  await page.addInitScript(() => {
    // Remove webdriver property
    delete (window as any).navigator.webdriver
    
    // Mock plugins and languages
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });
    
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
    
    // Mock chrome runtime
    (window as any).chrome = {
      runtime: {}
    };
  })
  
  page.setDefaultTimeout(30000)
  page.setDefaultNavigationTimeout(30000)

  console.log('🔄 Navigating to:', TARGET_URL)
  await page.goto(TARGET_URL, { 
    waitUntil: 'domcontentloaded',
    timeout: 30000 
  })
  console.log('✅ Page loaded successfully')
  
  // Wait a bit more for dynamic content to load
  console.log('⏳ Waiting for dynamic content...')
  await page.waitForTimeout(3000)
  
  // Check if page is still alive
  if (page.isClosed()) {
    console.log('❌ Page was closed unexpectedly')
    return
  }
  
  // Check for iframes or other interactive elements
  try {
    const iframes = await page.$$('iframe')
    console.log(`🖼️  Found ${iframes.length} iframes`)
  } catch (e) {
    console.log('❌ Error checking iframes:', e instanceof Error ? e.message : String(e))
    return
  }
  
  const buttons = await page.$$('button, input[type="button"], input[type="submit"], a[href]')
  console.log(`🔘 Found ${buttons.length} clickable elements`)
  
  // Get info about clickable elements
  const buttonInfo = await page.evaluate(() => {
    const clickables = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a[href]'))
    return clickables.map((el, i) => ({
      index: i,
      tagName: el.tagName,
      href: el.getAttribute('href'),
      text: el.textContent?.trim() || '',
      id: el.id,
      className: el.className,
      onclick: el.getAttribute('onclick')
    }))
  })
  console.log('🔘 Clickable elements:', JSON.stringify(buttonInfo, null, 2))
  
  // Check page source for any redirects or JavaScript
  const pageContent = await page.content()
  const hasRedirect = pageContent.includes('location.href') || pageContent.includes('window.location') || pageContent.includes('redirect')
  console.log(`🔄 Page has redirect code: ${hasRedirect}`)

  /* wait for the specific div to be mounted */
  console.log('🔍 Looking for target div...')
  
  // First check if any divs with similar styles exist
  const allDivs = await page.$$('div[style*="position:fixed"]')
  console.log(`📊 Found ${allDivs.length} divs with position:fixed`)
  
  // Let's also check for any divs with high z-index
  const highZDivs = await page.$$('div[style*="z-index"]')
  console.log(`📊 Found ${highZDivs.length} divs with z-index`)
  
  // Check all divs and their properties
  const allDivInfo = await page.evaluate(() => {
    const divs = Array.from(document.querySelectorAll('div'))
    return divs.map(div => ({
      style: div.getAttribute('style'),
      hasClick: div.onclick !== null || div.addEventListener !== undefined,
      display: window.getComputedStyle(div).display,
      zIndex: window.getComputedStyle(div).zIndex
    })).filter(info => info.style && (info.style.includes('position:fixed') || info.style.includes('z-index')))
  })
  console.log('📋 All relevant divs:', JSON.stringify(allDivInfo, null, 2))
  
  // Try to find any div with high z-index
  console.log('🔍 Searching for any high z-index divs...')
  const highZIndexDivs = await page.$$('div')
  
  let targetDiv = null
  for (const div of highZIndexDivs) {
    const style = await div.getAttribute('style')
    if (style && style.includes('z-index') && (style.includes('9999999') || style.includes('position:fixed'))) {
      console.log('🎯 Found potential target div with style:', style)
      targetDiv = div
      break
    }
  }
  
  if (!targetDiv) {
    console.log('❌ No high z-index div found, trying to trigger it...')
    
    // Try various actions that might trigger ad/tracking scripts
    const triggerActions = [
      () => page.click('body'),
      () => page.mouse.move(500, 500),
      () => page.mouse.wheel(0, 100),
      () => page.keyboard.press('Space'),
      () => page.hover('a[href="/"]'),
      () => page.evaluate(() => window.scrollTo(0, 100))
    ]
    
    for (let attempt = 0; attempt < 10; attempt++) {
      console.log(`🔄 Trigger attempt ${attempt + 1}/10`)
      
      // Try a random action
      const action = triggerActions[attempt % triggerActions.length]
      try {
        await action()
      } catch (e) {}
      
      await page.waitForTimeout(2000)
      
      // Check for the div again
      const newDivs = await page.$$('div')
      for (const div of newDivs) {
        const style = await div.getAttribute('style')
        if (style && style.includes('z-index') && (style.includes('9999999') || style.includes('position:fixed'))) {
          console.log('🎯 Found div after trigger:', style)
          targetDiv = div
          break
        }
      }
      
      if (targetDiv) break
      
      // Also check if URL changed (maybe redirect happened without div)
      if (page.url() !== TARGET_URL) {
        console.log('🎉 URL changed during trigger attempts!')
        break
      }
    }
  }
  
  if (!targetDiv) {
    console.log('❌ Target div still not found after all attempts')
    console.log('⏳ Waiting longer to see if anything happens...')
    
    // Wait longer and monitor for changes
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000)
      if (page.url() !== TARGET_URL) {
        console.log('🎉 URL changed during extended wait!')
        break
      }
      if (i % 5 === 0) {
        console.log(`⏳ Still waiting... ${i + 1}/30 seconds`)
      }
    }
    
    if (page.url() === TARGET_URL) {
      console.log('❌ Nothing happened - div may not exist or site has changed')
      await browser.close()
      return
    }
  }
  
  if (targetDiv) {
    console.log('✅ Target div found, attempting click...')
    
    // Debug: check div properties before clicking
    const divInfo = await page.evaluate((element) => {
    const div = element as HTMLElement
    return {
      tagName: div.tagName,
      style: div.getAttribute('style'),
      visible: div.offsetWidth > 0 && div.offsetHeight > 0,
      hasClickHandler: typeof div.onclick === 'function' || div.getAttribute('onclick') !== null
    }
  }, targetDiv)
  console.log('📋 Div info:', divInfo)
  
  /* try different click methods */
  console.log('🔄 Trying multiple click approaches...')
  
  // Method 1: Make div visible first, then click
  await page.evaluate((element) => {
    const div = element as HTMLElement
    div.style.display = 'block'
    div.style.visibility = 'visible'
    div.style.opacity = '1'
  }, targetDiv)
  
  await page.waitForTimeout(500)
  console.log('🔗 URL after making visible:', page.url())
  
  // Method 2: Try aggressive clicking with multiple approaches
  console.log('🔄 Starting aggressive click sequence...')
  
  for (let i = 0; i < 5; i++) {
    console.log(`🔄 Click round ${i + 1}/5`)
    
    // Multiple click types in rapid succession
    try {
      await targetDiv.click({ force: true })
    } catch (e) {}
    
    await page.evaluate((element) => {
      const div = element as HTMLElement
      div.click()
      
      // Also dispatch multiple event types
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
    
    // Try clicking at specific coordinates
    if (targetDiv) {
      const box = await targetDiv.boundingBox()
      if (box) {
        try {
          await page.mouse.click(box.x + box.width/2, box.y + box.height/2)
        } catch (e) {}
      }
    }
    
    await page.waitForTimeout(800)
    console.log(`🔗 URL after click round ${i + 1}:`, page.url())
    
    // If URL changed, break out
    if (page.url() !== TARGET_URL) {
      console.log('🎉 URL changed! Click worked!')
      break
    }
  }
  
  // Try waiting for the div to become visible naturally
  console.log('👁️  Waiting to see if div becomes visible...')
  try {
    await page.waitForSelector('div[style*="z-index:9999999"]', {
      state: 'visible',
      timeout: 5000
    })
    console.log('✅ Div became visible! Clicking now...')
    const visibleDiv = await page.$('div[style*="z-index:9999999"]')
    if (visibleDiv) {
      await visibleDiv.click()
      await page.waitForTimeout(2000)
      console.log('🔗 URL after visible div click:', page.url())
    }
  } catch (e) {
    console.log('⏳ Div never became visible, trying other interactions...')
  }
  
  // Try clicking on the page body to trigger any events
  console.log('🖱️  Trying to click on page body...')
  await page.click('body')
  await page.waitForTimeout(1000)
  console.log('🔗 URL after body click:', page.url())
  
  // Try pressing a key (sometimes sites wait for user interaction)
  console.log('⌨️  Trying to press a key...')
  await page.keyboard.press('Space')
  await page.waitForTimeout(1000)
  console.log('🔗 URL after keypress:', page.url())
  
  // Try scrolling (sometimes triggers ads)
  console.log('📜 Trying to scroll...')
  await page.mouse.wheel(0, 500)
  await page.waitForTimeout(2000)
  console.log('🔗 URL after scroll:', page.url())
  
  /* wait for 0.6 seconds */
  await page.waitForTimeout(600)
  
  }  // End of targetDiv check
  
  /* wait for URL change in original tab */
  console.log('⏳ Waiting for URL change in original tab...')
  try {
    await page.waitForURL(url => {
      const currentUrl = url.toString()
      console.log(`🔍 Current URL: ${currentUrl}`)
      // Exit when URL changes from the original TARGET_URL
      return currentUrl !== TARGET_URL
    }, {
      waitUntil: 'commit',
      timeout: 30000
    })
    console.log('✅ URL changed - closing browser')
  } catch (e) {
    console.log('⚠️  URL did not change within timeout')
  }

  console.log('✅ Final URL:', page.url())
  await browser.close()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
