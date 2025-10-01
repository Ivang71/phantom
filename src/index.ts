import { main } from '@/app/main'
import { logError } from '@/logger'

async function bootstrap() {
  try {
    await main()
  } catch (err) {
    logError('Fatal error:', err as any)
    process.exitCode = 1
  }
}

bootstrap()


