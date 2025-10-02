import * as net from 'net'
import * as http from 'http'
import { PROXY_HOST, PROXY_USER, PROXY_PASS } from '@/config'

export class LocalPassThroughProxy {
  private server: http.Server
  private port: number
  private upstreamPort: number
  private sockets = new Set<net.Socket>()
  private tunnels = new Set<net.Socket>()
  private allowlist: string[] | null = null

  constructor(port: number, upstreamPort: number) {
    this.port = port
    this.upstreamPort = upstreamPort
    this.server = http.createServer()
    this.server.on('request', this.handleHttp)
    this.server.on('connect', this.handleConnect)
  }

  public async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(this.port, '127.0.0.1', () => resolve()))
    return (this.server.address() as any).port
  }

  public async rotate(upstreamPort: number): Promise<void> {
    this.upstreamPort = upstreamPort
    for (const s of Array.from(this.sockets)) { try { s.destroy() } catch {} }
    for (const t of Array.from(this.tunnels)) { try { t.destroy() } catch {} }
    this.sockets.clear()
    this.tunnels.clear()
  }

  public async stop(): Promise<void> {
    for (const s of Array.from(this.sockets)) { try { s.destroy() } catch {} }
    for (const t of Array.from(this.tunnels)) { try { t.destroy() } catch {} }
    this.sockets.clear()
    this.tunnels.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  public setAllowlist(domains: string[] | null): void {
    this.allowlist = domains && domains.length ? domains.slice() : null
  }

  private isAllowedHost(hostname: string | undefined): boolean {
    if (!hostname) return false
    if (!this.allowlist || this.allowlist.length === 0) return true
    const h = hostname.toLowerCase()
    return this.allowlist.some(d => {
      const dom = d.replace(/^\./, '').toLowerCase()
      return h === dom || h.endsWith('.' + dom) || h.endsWith(dom)
    })
  }

  private handleHttp = (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // Absolute-form URL in proxy mode
      const u = new URL(String(req.url || 'http://invalid'))
      if (!this.isAllowedHost(u.hostname)) {
        try { res.writeHead(403); res.end() } catch {}
        return
      }
    } catch {
      try { res.writeHead(400); res.end() } catch {}
      return
    }
    const authHeader = (PROXY_USER && PROXY_PASS) ? 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64') : undefined
    const options: http.RequestOptions = {
      host: PROXY_HOST,
      port: this.upstreamPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        ...(authHeader ? { 'Proxy-Authorization': authHeader } : {})
      }
    }
    const upstreamReq = http.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers as any)
      upstreamRes.pipe(res)
    })
    upstreamReq.on('error', () => { try { res.destroy() } catch {} })
    ;(req as any).pipe(upstreamReq)
  }

  private handleConnect = (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const [host, portStr] = String(req.url || '').split(':')
    const port = Number(portStr || 443)
    if (!this.isAllowedHost(host)) {
      try { clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n') } catch {}
      try { clientSocket.destroy() } catch {}
      return
    }
    const upstreamSocket = net.connect(this.upstreamPort, PROXY_HOST, () => {
      const auth = (PROXY_USER && PROXY_PASS) ? `Proxy-Authorization: Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')}` : ''
      const connectReq = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? auth + '\r\n' : ''}\r\n`
      upstreamSocket.write(connectReq)
    })

    const cleanup = () => {
      try { clientSocket.destroy() } catch {}
      try { upstreamSocket.destroy() } catch {}
      this.sockets.delete(clientSocket)
      this.tunnels.delete(upstreamSocket)
    }

    upstreamSocket.on('data', (buf) => {
      const str = buf.toString('latin1')
      if (str.startsWith('HTTP/1.1 200')) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) upstreamSocket.write(head)
        clientSocket.pipe(upstreamSocket)
        upstreamSocket.pipe(clientSocket)
      } else if (str.startsWith('HTTP/1.1')) {
        try { clientSocket.end(str) } catch {}
        cleanup()
      }
    })

    clientSocket.on('error', cleanup)
    upstreamSocket.on('error', cleanup)
    clientSocket.on('close', cleanup)
    upstreamSocket.on('close', cleanup)

    this.sockets.add(clientSocket)
    this.tunnels.add(upstreamSocket)
  }
}
