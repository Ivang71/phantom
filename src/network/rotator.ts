import { PROXY_PORT_END, PROXY_PORT_START } from '@/config'

let currentPort = PROXY_PORT_START
let timer: NodeJS.Timeout | null = null

export function getUpstreamProxyPort(): number {
  return currentPort
}

export function rotateUpstreamProxyPort(): number {
  const range = PROXY_PORT_END - PROXY_PORT_START + 1
  if (range <= 1) {
    currentPort = PROXY_PORT_START
    return currentPort
  }
  const next = ((currentPort - PROXY_PORT_START + 1) % range) + PROXY_PORT_START
  currentPort = next
  return currentPort
}

