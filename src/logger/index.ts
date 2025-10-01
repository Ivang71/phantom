import { LOG_MODE } from '@/config'

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

const CURRENT_LOG_LEVEL = LOG_MODE === 'debug' ? LogLevel.DEBUG : LogLevel.ERROR

export function log(level: LogLevel, message: string, ...args: any[]): void {
  if (level <= CURRENT_LOG_LEVEL) {
    console.log(message, ...args)
  }
}

export function logError(message: string, ...args: any[]): void {
  log(LogLevel.ERROR, message, ...args)
}

export function logWarn(message: string, ...args: any[]): void {
  log(LogLevel.WARN, message, ...args)
}

export function logInfo(message: string, ...args: any[]): void {
  log(LogLevel.INFO, message, ...args)
}

export function logDebug(message: string, ...args: any[]): void {
  log(LogLevel.DEBUG, message, ...args)
}


