import * as fs from 'fs'

export interface IpExtOctets {
  inOctets: number
  outOctets: number
}

let lastInOctets = 0
let lastOutOctets = 0
let hasBaseline = false

let runBaselineInOctets = 0
let runBaselineOutOctets = 0
let hasRunBaseline = false

function safeReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch (e) {
    return null
  }
}

function parseProcNetstat(content: string): { IpExt: Record<string, number>, TcpExt: Record<string, number> } {
  const lines = content.split(/\r?\n/).filter(Boolean)
  const sections: Record<string, Record<string, number>> = { IpExt: {}, TcpExt: {} }

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const header = lines[i]
    const values = lines[i + 1]
    const headerParts = header.split(/\s+/)
    const valuesParts = values.split(/\s+/)
    if (headerParts.length < 2 || valuesParts.length < 2) continue

    const sectionName = headerParts[0].replace(':', '')
    if (sectionName !== 'IpExt' && sectionName !== 'TcpExt') continue

    const keys = headerParts.slice(1)
    const nums = valuesParts.slice(1).map(v => Number(v))
    const out: Record<string, number> = {}
    for (let k = 0; k < keys.length && k < nums.length; k++) {
      const key = keys[k]
      const val = Number.isFinite(nums[k]) ? nums[k] : 0
      out[key] = val
    }
    sections[sectionName] = out
  }

  return { IpExt: sections.IpExt || {}, TcpExt: sections.TcpExt || {} }
}

export function getIpExtOctetsTotals(procPath: string = '/proc/self/net/netstat'): IpExtOctets {
  const txt = safeReadFile(procPath)
  if (!txt) return { inOctets: 0, outOctets: 0 }
  const parsed = parseProcNetstat(txt)
  const inOctets = parsed.IpExt['InOctets'] || 0
  const outOctets = parsed.IpExt['OutOctets'] || 0
  return { inOctets, outOctets }
}

export function getIpExtOctetsDelta(procPath: string = '/proc/self/net/netstat'): IpExtOctets {
  const totals = getIpExtOctetsTotals(procPath)
  if (!hasBaseline) {
    lastInOctets = totals.inOctets
    lastOutOctets = totals.outOctets
    hasBaseline = true
    return { inOctets: 0, outOctets: 0 }
  }
  const deltaIn = Math.max(0, totals.inOctets - lastInOctets)
  const deltaOut = Math.max(0, totals.outOctets - lastOutOctets)
  lastInOctets = totals.inOctets
  lastOutOctets = totals.outOctets
  return { inOctets: deltaIn, outOctets: deltaOut }
}

export function resetIpExtRunBaseline(procPath: string = '/proc/self/net/netstat'): void {
  const totals = getIpExtOctetsTotals(procPath)
  runBaselineInOctets = totals.inOctets
  runBaselineOutOctets = totals.outOctets
  hasRunBaseline = true
}

export function getIpExtOctetsSinceRunBaseline(procPath: string = '/proc/self/net/netstat'): IpExtOctets {
  const totals = getIpExtOctetsTotals(procPath)
  if (!hasRunBaseline) {
    // If not set, initialize baseline and return 0 deltas
    runBaselineInOctets = totals.inOctets
    runBaselineOutOctets = totals.outOctets
    hasRunBaseline = true
    return { inOctets: 0, outOctets: 0 }
  }
  const deltaIn = Math.max(0, totals.inOctets - runBaselineInOctets)
  const deltaOut = Math.max(0, totals.outOctets - runBaselineOutOctets)
  return { inOctets: deltaIn, outOctets: deltaOut }
}
