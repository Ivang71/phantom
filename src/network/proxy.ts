const { ProxyAgent, setGlobalDispatcher, fetch: undiciFetch } = require('undici')
import { PROXY_HOST, PROXY_PASS, PROXY_PORT, PROXY_USER } from '@/config'

export const upstreamProxyAuth = (PROXY_USER && PROXY_PASS) ? `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@` : ''
export const upstreamAgent = new ProxyAgent(`http://${upstreamProxyAuth}${PROXY_HOST}:${PROXY_PORT}`)

export function routeNodeFetchViaProxy(): void {
  if (PROXY_HOST && PROXY_PORT) {
    setGlobalDispatcher(upstreamAgent)
  }
}

export { undiciFetch as fetch }
export { ProxyAgent }


