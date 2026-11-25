/** Parse the signed Desktop parent's immutable Host plugin list from argv or its launch file. */

import { readFileSync } from 'node:fs'
import { isAbsolute, win32 } from 'node:path'

const ARG_PREFIX = '--dsh-host-plugin-allowlist='
const FILE_ARG_PREFIX = '--dsh-host-plugin-allowlist-file='
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

/** Launcher arguments carrying the Host plugin allowlist; exactly one may appear. */
export const HOST_PLUGIN_ALLOWLIST_ARG_PREFIXES = [ARG_PREFIX, FILE_ARG_PREFIX] as const

/** Windows drive and UNC paths are absolute even while this parser runs on POSIX hosts. */
function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}

/**
 * Read and freeze the launcher-owned Host plugin list.
 * @param argv - process arguments after the executable and entrypoint.
 * @returns the validated list, or undefined for ordinary non-enterprise runs.
 */
export interface ApprovedHostPlugin { readonly name: string; readonly version: string; readonly path: string }
export interface HostPluginAllowlist {
  readonly plugins: readonly ApprovedHostPlugin[]
  readonly packages: readonly ApprovedHostPlugin[]
  readonly enterpriseServiceOrigin?: string
}

function canonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && url.hostname.length > 0
      && url.username === '' && url.password === ''
  } catch { return false }
}

function parsePayload(payload: string): unknown {
  try { return JSON.parse(payload) } catch { throw new Error('desktop host: invalid Host plugin allowlist') }
}

function readPayload(argv: readonly string[]): string | undefined {
  const inline = argv.filter(argument => argument.startsWith(ARG_PREFIX))
  const files = argv.filter(argument => argument.startsWith(FILE_ARG_PREFIX))
  if (inline.length + files.length === 0) return undefined
  if (inline.length + files.length !== 1) throw new Error('desktop host: duplicate Host plugin allowlist arguments')
  const fileArgument = files.at(0)
  if (fileArgument === undefined) {
    const argument = inline.at(0)
    if (argument === undefined) throw new Error('desktop host: invalid Host plugin allowlist')
    return argument.slice(ARG_PREFIX.length)
  }
  const file = fileArgument.slice(FILE_ARG_PREFIX.length)
  if (!isAbsolutePath(file)) throw new Error('desktop host: invalid Host plugin allowlist')
  try { return readFileSync(file, 'utf8') } catch { throw new Error('desktop host: invalid Host plugin allowlist') }
}

export function readHostPluginAllowlist(argv: readonly string[]): HostPluginAllowlist | undefined {
  const payload = readPayload(argv)
  if (payload === undefined) return undefined
  const value = parsePayload(payload)
  if (value === null || typeof value !== 'object') throw new Error('desktop host: invalid Host plugin allowlist')
  const input = value as Record<string, unknown>
  const validRecords = (records: unknown, uniqueBy: 'name' | 'path'): records is ApprovedHostPlugin[] => Array.isArray(records) && records.length > 0 && records.every((item: unknown) => {
    if (item === null || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    return typeof record.name === 'string' && PACKAGE_NAME.test(record.name)
      && typeof record.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(record.version)
      && typeof record.path === 'string' && isAbsolutePath(record.path)
  }) && new Set(records.map((item: ApprovedHostPlugin) => item[uniqueBy])).size === records.length
  if (!validRecords(input.plugins, 'name') || !validRecords(input.packages, 'path')) {
    throw new Error('desktop host: invalid Host plugin allowlist')
  }
  const plugins = input.plugins
  const packages = input.packages
  if (plugins.some(plugin => !packages.some(pkg =>
    pkg.name === plugin.name && pkg.version === plugin.version && pkg.path === plugin.path))) {
    throw new Error('desktop host: invalid Host plugin allowlist')
  }
  const enterprise = plugins.some(plugin => plugin.name === '@dsh-enterprise/harness-bundle')
  if (enterprise ? !canonicalHttpsOrigin(input.enterpriseServiceOrigin) : input.enterpriseServiceOrigin !== undefined) {
    throw new Error('desktop host: invalid enterprise service origin')
  }
  return Object.freeze({
    plugins: Object.freeze(plugins.map((item: ApprovedHostPlugin) => Object.freeze({ ...item }))),
    packages: Object.freeze(packages.map((item: ApprovedHostPlugin) => Object.freeze({ ...item }))),
    ...(enterprise ? { enterpriseServiceOrigin: input.enterpriseServiceOrigin as string } : {}),
  })
}
