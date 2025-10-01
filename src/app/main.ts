import { LOG_MODE, MAX_CONCURRENT_WORKERS, MAX_ITERATIONS, WORKER_BATCH_SIZE } from '@/config'
import { preloadCache, CACHED_FILES, globalCacheBytesSaved, globalCacheHits } from '@/cache'
import { getMemoryUsage, getSystemInfo, formatBytes } from '@/utils'
import { logInfo } from '@/logger'
import { routeNodeFetchViaProxy } from '@/network/proxy'
import { runWorker, workerStats, globalBytesReceived, globalBytesSent } from '@/workers'
import { StatsManager } from '@/stats'
import { getIpExtOctetsTotals, getIpExtOctetsSinceRunBaseline, resetIpExtRunBaseline } from '@/network/netstat'

async function printStats(statsManager: StatsManager): Promise<void> {
  const memUsage = getMemoryUsage()
  const sysInfo = getSystemInfo()
  const ipExtTotals = getIpExtOctetsTotals()
  const ipExtSinceRun = getIpExtOctetsSinceRunBaseline()
  logInfo('\n=== PARALLEL EXECUTION STATS ===')
  logInfo(`Active Workers: ${workerStats.size}`)
  logInfo(`Global Iterations: ${Array.from(workerStats.values()).reduce((sum, s) => sum + s.iterations, 0)}`)
  logInfo(`Global Errors: ${Array.from(workerStats.values()).reduce((sum, s) => sum + s.errors, 0)}`)
  logInfo(`Global Network: Sent ${formatBytes(globalBytesSent)}, Received ${formatBytes(globalBytesReceived)}`)
  logInfo(`System Net (IpExt totals): Out ${formatBytes(ipExtTotals.outOctets)}, In ${formatBytes(ipExtTotals.inOctets)}`)
  logInfo(`System Net (since start): Out ${formatBytes(ipExtSinceRun.outOctets)}, In ${formatBytes(ipExtSinceRun.inOctets)}`)
  logInfo(`Cache Performance: ${globalCacheHits} hits, ${formatBytes(globalCacheBytesSaved)} saved`)
  logInfo(`Memory: RSS ${memUsage.rss}MB, Heap ${memUsage.heapUsed}MB`)
  logInfo(`System Memory: ${sysInfo.freeMemory}GB free of ${sysInfo.totalMemory}GB`)
  logInfo('\n--- Worker Details ---')
  for (const [workerId, stats] of workerStats.entries()) {
    const timeSinceActivity = Date.now() - stats.lastActivity.getTime()
    logInfo(`W${workerId}: ${stats.iterations} iterations, ${stats.errors} errors, ${formatBytes(stats.bytesSent)} sent, ${formatBytes(stats.bytesReceived)} received (${Math.round(timeSinceActivity/1000)}s ago)`) 
  }
  logInfo('================================\n')
  statsManager.printStats()
}

export async function main(): Promise<void> {
  const statsManager = new StatsManager('./bot-stats.json')
  resetIpExtRunBaseline()
  logInfo('=== PARALLEL BOT SYSTEM ===')
  const sysInfo = getSystemInfo()
  logInfo(`Platform: ${sysInfo.platform} ${sysInfo.arch}`)
  logInfo(`CPU Cores: ${sysInfo.cpuCount}`)
  logInfo(`Total Memory: ${sysInfo.totalMemory} GB`)
  logInfo(`Free Memory: ${sysInfo.freeMemory} GB`)
  logInfo(`Max Concurrent Workers: ${MAX_CONCURRENT_WORKERS}`)
  logInfo(`Worker Batch Size: ${WORKER_BATCH_SIZE}`)
  logInfo(`Cached Files: ${CACHED_FILES.length} files configured for caching`)
  logInfo('============================\n')

  routeNodeFetchViaProxy()
  await preloadCache()
  statsManager.printStats()
  const statsInterval = setInterval(() => { printStats(statsManager) }, 15000)

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
        workerPromises.push(runWorker(workerId, actualIterations, statsManager))
      }
    }
    await Promise.all(workerPromises)
    totalIterationsRun += iterationsThisBatch
    logInfo(`\n=== BATCH ${batchNumber} COMPLETED ===`)
    logInfo(`Total iterations completed: ${totalIterationsRun}/${MAX_ITERATIONS}`)
    await printStats(statsManager)
    if (totalIterationsRun < MAX_ITERATIONS) {
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
  clearInterval(statsInterval)
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  const statsManager = new StatsManager('./bot-stats.json')
  logInfo('\nReceived SIGINT, cleaning up...')
  statsManager.cleanup()
  process.exit(0)
})

process.on('SIGTERM', () => {
  const statsManager = new StatsManager('./bot-stats.json')
  logInfo('\nReceived SIGTERM, cleaning up...')
  statsManager.cleanup()
  process.exit(0)
})


