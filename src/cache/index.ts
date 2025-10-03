import { TARGET_URL, PROXY_HOST, PROXY_PASS, PROXY_USER } from '@/config'
import { logInfo, logWarn, logError, logDebug } from '@/logger'
import { formatBytes } from '@/utils'
import { ProxyAgent } from '@/network/proxy'
import { getUpstreamProxyPort } from '@/network/rotator'
import { fetch } from '@/network/proxy'

export const fileCache = new Map<string, { content: Buffer, contentType: string }>()
export const CACHED_FILES = [
  'https://cdn.popcash.net/show.js',
  TARGET_URL
]

export let globalCacheHits = 0
export let globalCacheBytesSaved = 0

export async function preloadCache(): Promise<void> {
  logInfo('=== PRELOADING CACHE ===')
  for (const url of CACHED_FILES) {
    try {
      logInfo(`Downloading ${url}...`)
      const upstreamProxyAuth = (PROXY_USER && PROXY_PASS) ? `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@` : ''
      const dispatcher = new ProxyAgent(`http://${upstreamProxyAuth}${PROXY_HOST}:${getUpstreamProxyPort()}`)
      const response = await fetch(url, { dispatcher })
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

export function recordCacheHit(bytesSaved: number): void {
  globalCacheHits++
  globalCacheBytesSaved += bytesSaved
}


