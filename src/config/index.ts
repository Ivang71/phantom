import { config as loadEnv } from 'dotenv'

loadEnv()

// Environment-derived configuration
export const PROXY_HOST = process.env.PROXY_HOST as string
export const PROXY_PORT = Number(process.env.PROXY_PORT)
export const PROXY_USER = process.env.PROXY_USER as string
export const PROXY_PASS = process.env.PROXY_PASS as string

export const MAX_CONCURRENT_WORKERS = Number(process.env.NUMBER_OF_WORKERS)

export const TARGET_URL = process.env.TARGET_URL as string
export const DEBUG_MODE = process.env.DEBUG_MODE === 'true'
export const BANDWIDTH_ANALYSIS = process.env.BANDWIDTH_ANALYSIS === 'true'
export const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false'
export const DEBUG_MAX_WAIT_MS = Number(process.env.DEBUG_MAX_WAIT_MS || 20000)
export const NORMAL_MAX_WAIT_MS = Number(process.env.NORMAL_MAX_WAIT_MS || 15000)

// Logging mode
export const LOG_MODE = (process.env.LOG_MODE === 'prod') ? 'prod' : 'debug'

// Ports and iterations
export const PROXY_PORT_START = 10000
export const PROXY_PORT_END = 20000
export const MAX_ITERATIONS = 1000000000
export const WORKER_BATCH_SIZE = 500000000
export const ITERATIONS_PER_IP = Number(process.env.ITERATIONS_PER_IP || 20)

// Derived values
export const TARGET_HOST = new URL(TARGET_URL).hostname

// Timing constants
export const VISIT_SITE_OVERALL_TIMEOUT_MS = 120000
export const PAGE_DEFAULT_TIMEOUT_MS = 15000
export const PAGE_DEFAULT_NAV_TIMEOUT_MS = 15000
export const PAGE_GOTO_TIMEOUT_MS = 7000
export const NEW_PAGE_NETWORKIDLE_TIMEOUT_MS = 5000
export const WAIT_FOR_FINAL_ON_PAGE_DEFAULT_MS = 17000

export const AD_DIV_MAX_WAIT_MS = 10000
export const AD_DIV_POLL_INTERVAL_MS = 500

export const PRE_CLICK_PREPARE_MS = 300
export const POST_CLICK_SHORT_WAIT_MS = 500
export const POPUP_DETECTION_GRACE_MS = 700

export const AFTER_SUCCESS_EXTRA_DELAY_MS = 700
export const NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_MS = 400
export const NETWORKIDLE_AFTER_SUCCESS_TIMEOUT_SHORT_MS = 300
export const DOMCONTENTLOADED_TIMEOUT_SHORT_MS = 300


