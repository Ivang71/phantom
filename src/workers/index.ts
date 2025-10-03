import { visitIpCycle } from '@/browser/visit'
import { formatBytes } from '@/utils'
import { logError, logInfo } from '@/logger'
import { PROXY_PORT_END, PROXY_PORT_START } from '@/config'
import { LocalPassThroughProxy } from '@/network/localProxy'
import { launchBrowserWithLocalPort } from '@/browser/create'
import { StatsManager } from '@/stats'
import { rotateUpstreamProxyPort } from '@/network/rotator'

export interface WorkerStats {
  workerId: number
  iterations: number
  bytesSent: number
  bytesReceived: number
  errors: number
  lastActivity: Date
}

export const workerStats = new Map<number, WorkerStats>()
export let globalIterationCount = 0
export let globalBytesSent = 0
export let globalBytesReceived = 0

export async function runWorker(workerId: number, iterationsToRun: number, statsManager: StatsManager): Promise<void> {
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

  // Per-worker local proxy and single Chromium reused across cycles
  const localPort = 0
  rotateUpstreamProxyPort()
  const localProxy = new LocalPassThroughProxy(localPort)
  const boundPort = await localProxy.start()
  const browser = await launchBrowserWithLocalPort(boundPort)
  ;(browser as any).__localProxy = localProxy

  for (let i = 0; i < iterationsToRun; i++) {
    if (i > 0) {
      rotateUpstreamProxyPort()
      await localProxy.rotate()
    }
    const startTime = Date.now()
    try {
      const networkData = await visitIpCycle(browser as any, PROXY_PORT_START, workerId)
      const duration = Date.now() - startTime
      stats.iterations++
      stats.bytesSent += networkData.bytesSent
      stats.bytesReceived += networkData.bytesReceived
      stats.lastActivity = new Date()
      globalBytesSent += networkData.bytesSent
      globalBytesReceived += networkData.bytesReceived
      if (networkData.success) {
        statsManager.recordSuccessfulCycle(networkData.bytesSent, networkData.bytesReceived)
      }
      if (stats.iterations % 10 === 0 || networkData.success) {
        logInfo(`[W${workerId}] Iteration ${stats.iterations} completed in ${duration}ms ${networkData.success ? '[SUCCESS]' : '[NO SUCCESS]'}`)
        logInfo(`[W${workerId}] Network: Sent ${formatBytes(networkData.bytesSent)}, Received ${formatBytes(networkData.bytesReceived)}`)
      }
    } catch (error) {
      stats.errors++
      stats.lastActivity = new Date()
      logError(`[W${workerId}] Error in iteration ${stats.iterations + 1}:`, error as any)
    }
    if (i < iterationsToRun - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  try { await (browser as any).close() } catch {}
  try { await localProxy.stop() } catch {}
  logInfo(`[W${workerId}] Worker completed ${stats.iterations} iterations (${stats.errors} errors)`)
}


