/** Parse the signed Desktop parent's immutable Host plugin list from argv. */

const ARG_PREFIX = '--dsh-host-plugin-allowlist='
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

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
export function readHostPluginAllowlist(argv: readonly string[]): HostPluginAllowlist | undefined {
  const values = argv.filter(argument => argument.startsWith(ARG_PREFIX))
  if (values.length === 0) return undefined
  if (values.length !== 1) throw new Error('desktop host: duplicate Host plugin allowlist arguments')
  const argument = values.at(0)
  if (argument === undefined) throw new Error('desktop host: invalid Host plugin allowlist')
  let value: unknown
  try { value = JSON.parse(argument.slice(ARG_PREFIX.length)) }
  catch { throw new Error('desktop host: invalid Host plugin allowlist') }
  if (value === null || typeof value !== 'object') throw new Error('desktop host: invalid Host plugin allowlist')
  const input = value as Record<string, unknown>
  const validRecords = (records: unknown, uniqueBy: 'name' | 'path'): records is ApprovedHostPlugin[] => Array.isArray(records) && records.length > 0 && records.every((item: unknown) => {
    if (item === null || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    return typeof record.name === 'string' && PACKAGE_NAME.test(record.name)
      && typeof record.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(record.version)
      && typeof record.path === 'string' && record.path.startsWith('/')
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
