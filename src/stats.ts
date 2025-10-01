import * as fs from 'fs'
import * as path from 'path'
import { getIpExtOctetsSinceRunBaseline } from '@/network/netstat'

export interface BotStats {
  startTime: number
  startTimeReadable: string
  totalRuntime: number
  totalRuntimeReadable: string
  successfulCycles: number
  totalDataSent: number
  totalDataSentReadable: string
  totalDataReceived: number
  totalDataReceivedReadable: string
  averageCyclesPerMinute: number
  lastUpdated: number
  lastUpdatedReadable: string
  sessionStats: {
    sessionStartTime: number
    sessionStartTimeReadable: string
    sessionCycles: number
    sessionDataSent: number
    sessionDataSentReadable: string
    sessionDataReceived: number
    sessionDataReceivedReadable: string
    sessionRuntimeReadable: string
    sessionCyclesPerMinute: number
  }
}

export class StatsManager {
  private statsFile: string
  private stats: BotStats
  private saveInterval: NodeJS.Timeout | null = null
  private runStartTotalSent: number = 0
  private runStartTotalReceived: number = 0

  constructor(statsFilePath: string = './bot-stats.json') {
    this.statsFile = path.resolve(statsFilePath)
    this.stats = this.loadStats()
    // Anchor totals for this run so that cumulative totals persist across restarts
    this.runStartTotalSent = this.stats.totalDataSent || 0
    this.runStartTotalReceived = this.stats.totalDataReceived || 0
    this.startAutoSave()
  }

  private loadStats(): BotStats {
    try {
      if (fs.existsSync(this.statsFile)) {
        const data = fs.readFileSync(this.statsFile, 'utf8')
        const loadedStats = JSON.parse(data)
        
        // Start new session
        const sessionStart = Date.now()
        loadedStats.sessionStats = {
          sessionStartTime: sessionStart,
          sessionStartTimeReadable: new Date(sessionStart).toLocaleString(),
          sessionCycles: 0,
          sessionDataSent: 0,
          sessionDataSentReadable: '0 B',
          sessionDataReceived: 0,
          sessionDataReceivedReadable: '0 B',
          sessionRuntimeReadable: '0s',
          sessionCyclesPerMinute: 0
        }
        
        return loadedStats
      }
    } catch (error) {
      console.warn('Failed to load stats file:', error)
    }

    // Default stats
    const now = Date.now()
    return {
      startTime: now,
      startTimeReadable: new Date(now).toLocaleString(),
      totalRuntime: 0,
      totalRuntimeReadable: '0s',
      successfulCycles: 0,
      totalDataSent: 0,
      totalDataSentReadable: '0 B',
      totalDataReceived: 0,
      totalDataReceivedReadable: '0 B',
      averageCyclesPerMinute: 0,
      lastUpdated: now,
      lastUpdatedReadable: new Date(now).toLocaleString(),
      sessionStats: {
        sessionStartTime: now,
        sessionStartTimeReadable: new Date(now).toLocaleString(),
        sessionCycles: 0,
        sessionDataSent: 0,
        sessionDataSentReadable: '0 B',
        sessionDataReceived: 0,
        sessionDataReceivedReadable: '0 B',
        sessionRuntimeReadable: '0s',
        sessionCyclesPerMinute: 0
      }
    }
  }

  private updateBytesFromNetstat(): void {
    const sinceRun = getIpExtOctetsSinceRunBaseline()
    // Cumulative totals: persisted totals at run start + since-run deltas
    this.stats.totalDataSent = this.runStartTotalSent + sinceRun.outOctets
    this.stats.totalDataReceived = this.runStartTotalReceived + sinceRun.inOctets
    this.stats.totalDataSentReadable = this.formatBytes(this.stats.totalDataSent)
    this.stats.totalDataReceivedReadable = this.formatBytes(this.stats.totalDataReceived)
    // Session reflects current run only
    this.stats.sessionStats.sessionDataSent = sinceRun.outOctets
    this.stats.sessionStats.sessionDataReceived = sinceRun.inOctets
    this.stats.sessionStats.sessionDataSentReadable = this.formatBytes(this.stats.sessionStats.sessionDataSent)
    this.stats.sessionStats.sessionDataReceivedReadable = this.formatBytes(this.stats.sessionStats.sessionDataReceived)
  }

  private saveStats(): void {
    try {
      // Update runtime
      const now = Date.now()
      this.stats.totalRuntime = now - this.stats.startTime
      this.stats.totalRuntimeReadable = this.formatTime(this.stats.totalRuntime)
      this.stats.lastUpdated = now
      this.stats.lastUpdatedReadable = new Date(now).toLocaleString()
      
      // Calculate average cycles per minute
      const runtimeMinutes = this.stats.totalRuntime / (1000 * 60)
      if (runtimeMinutes > 0) {
        this.stats.averageCyclesPerMinute = this.stats.successfulCycles / runtimeMinutes
      }

      // Update session stats runtime and cycles/min
      const sessionRuntime = now - this.stats.sessionStats.sessionStartTime
      this.stats.sessionStats.sessionRuntimeReadable = this.formatTime(sessionRuntime)
      const sessionRuntimeMinutes = sessionRuntime / (1000 * 60)
      if (sessionRuntimeMinutes > 0) {
        this.stats.sessionStats.sessionCyclesPerMinute = this.stats.sessionStats.sessionCycles / sessionRuntimeMinutes
      }

      // Sync bytes from system IpExt since run baseline
      this.updateBytesFromNetstat()

      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2))
    } catch (error) {
      console.error('Failed to save stats:', error)
    }
  }

  private startAutoSave(): void {
    // Save every 30 seconds
    this.saveInterval = setInterval(() => {
      this.saveStats()
    }, 30000)
  }

  public recordSuccessfulCycle(bytesSent: number, bytesReceived: number): void {
    this.stats.successfulCycles++
    // Keep cycle counters; bytes now come from system netstat in saveStats/getStats
    this.stats.sessionStats.sessionCycles++
  }

  public getStats(): BotStats {
    // Update runtime and recompute bytes before returning to keep printouts in sync
    this.stats.totalRuntime = Date.now() - this.stats.startTime
    const runtimeMinutes = this.stats.totalRuntime / (1000 * 60)
    if (runtimeMinutes > 0) {
      this.stats.averageCyclesPerMinute = this.stats.successfulCycles / runtimeMinutes
    }
    this.updateBytesFromNetstat()
    return { ...this.stats }
  }

  public printStats(): void {
    const stats = this.getStats()
    const sessionRuntimeMs = Date.now() - stats.sessionStats.sessionStartTime
    const sessionRuntimeMinutes = sessionRuntimeMs / (1000 * 60)
    const sessionCyclesPerMinute = sessionRuntimeMinutes > 0 ? stats.sessionStats.sessionCycles / sessionRuntimeMinutes : 0

    console.log('\n=== BOT STATISTICS ===')
    console.log(`Total Runtime: ${this.formatTime(stats.totalRuntime)}`)
    console.log(`Successful Cycles: ${stats.successfulCycles}`)
    console.log(`Average Cycles/Min: ${stats.averageCyclesPerMinute.toFixed(2)}`)
    console.log(`Total Data Sent: ${this.formatBytes(stats.totalDataSent)}`)
    console.log(`Total Data Received: ${this.formatBytes(stats.totalDataReceived)}`)
    console.log('')
    console.log('=== SESSION STATS ===')
    console.log(`Session Runtime: ${this.formatTime(sessionRuntimeMs)}`)
    console.log(`Session Cycles: ${stats.sessionStats.sessionCycles}`)
    console.log(`Session Cycles/Min: ${sessionCyclesPerMinute.toFixed(2)}`)
    console.log(`Session Data Sent: ${this.formatBytes(stats.sessionStats.sessionDataSent)}`)
    console.log(`Session Data Received: ${this.formatBytes(stats.sessionStats.sessionDataReceived)}`)
    console.log(`Stats File: ${this.statsFile}`)
    console.log('=====================\n')
  }

  private formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  public cleanup(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval)
      this.saveInterval = null
    }
    this.saveStats()
  }
}
