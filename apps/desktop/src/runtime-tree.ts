/** Relocatable, integrity-recorded production packages carried by one Desktop release. */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFile, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { valid } from 'semver'
import { DESKTOP_HOST_PACKAGE } from './core-package-set.ts'
import { parseDesktopRelease, type DesktopRelease } from './release.ts'

/** Descriptor at the root of the immutable Desktop resource tree. */
export const DESKTOP_RUNTIME_FILE = 'desktop-runtime.json'

/** Host-owned package available to external plugins through a directory link. */
export interface DesktopSharedPackage {
  readonly name: string
  readonly version: string
  readonly path: string
}

/** Final bytes and executable permissions of a runtime file. */
export interface DesktopRuntimeFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly executable: boolean
}

/** An enterprise-approved plugin package bound to its release-owned package path and version. */
export interface DesktopApprovedHostPlugin {
  readonly name: string
  readonly version: string
  /** Package-relative path from the runtime root; resolved to an absolute path by the Desktop shell. */
  readonly path: string
}

/** One signed application's production dependency tree. */
export interface DesktopRuntimeDescriptor {
  readonly schemaVersion: 1
  readonly release: DesktopRelease
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly sharedPackages: readonly DesktopSharedPackage[]
  /** Enterprise bundle-owned Host plugins bound to their release-owned paths and versions. */
  readonly allowedHostPlugins?: readonly DesktopApprovedHostPlugin[]
  /** Canonical HTTPS origin approved with the enterprise release. */
  readonly enterpriseServiceOrigin?: string
  /** Complete release-owned package catalog used to verify declared Host dependency closure. */
  readonly trustedHostPackages: readonly DesktopSharedPackage[]
  readonly files: readonly DesktopRuntimeFile[]
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const ENTERPRISE_PACKAGE_SCOPE = '@dsh-enterprise/'
const ENTERPRISE_BUNDLE_PACKAGE = '@dsh-enterprise/harness-bundle'
const readRuntimeFile = promisify(readFile)

/** Validate the exact HTTPS origin recorded in enterprise release metadata. */
export function canonicalEnterpriseServiceOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && url.hostname.length > 0
      && url.username === '' && url.password === ''
  } catch { return false }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A package path follows Node's package resolution layout, including nested installs. */
function packageCatalogPath(path: string, name: string): boolean {
  const parts = path.split('/')
  if (parts[0] !== 'node_modules') return false
  let index = 1
  while (index < parts.length) {
    const packageName = parts[index]?.startsWith('@')
      ? `${parts[index]}/${parts[index + 1]}` : parts[index]
    if (packageName === undefined || !PACKAGE_NAME.test(packageName)) return false
    index += packageName.startsWith('@') ? 2 : 1
    if (index === parts.length) return packageName === name
    if (parts[index] !== 'node_modules') return false
    index += 1
  }
  return false
}

/** Enumerate every installed package that Node can resolve from the materialized runtime. */
function installedPackageCatalog(root: string): DesktopSharedPackage[] {
  const packages: DesktopSharedPackage[] = []
  const visitModules = (modulesPath: string, relativeModulesPath: string): void => {
    for (const entry of readdirSync(modulesPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory()) throw new Error(`desktop runtime: invalid installed package entry ${entry.name}`)
      const names = entry.name.startsWith('@')
        ? readdirSync(join(modulesPath, entry.name), { withFileTypes: true }).map(child => {
          if (!child.isDirectory()) throw new Error(`desktop runtime: invalid scoped package ${entry.name}/${child.name}`)
          return `${entry.name}/${child.name}`
        })
        : [entry.name]
      for (const name of names) {
        if (!PACKAGE_NAME.test(name)) throw new Error(`desktop runtime: invalid installed package ${name}`)
        const path = `${relativeModulesPath}/${name}`
        const directory = runtimePath(root, path)
        const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        if (!record(manifest) || manifest.name !== name || typeof manifest.version !== 'string'
          || valid(manifest.version) === null) {
          throw new Error(`desktop runtime: invalid installed package manifest ${path}`)
        }
        packages.push({ name, version: manifest.version, path })
        if (readdirSync(directory, { withFileTypes: true }).some(child => child.name === 'node_modules')) {
          visitModules(join(directory, 'node_modules'), `${path}/node_modules`)
        }
      }
    }
  }
  visitModules(join(root, 'node_modules'), 'node_modules')
  return packages.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * Resolve one portable resource path without permitting traversal or absolute paths.
 * @param root - Runtime root.
 * @param path - Slash-separated relative path from durable metadata.
 * @returns Absolute resource path.
 */
export function runtimePath(root: string, path: string): string {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.includes(':')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop runtime: invalid relative path ${JSON.stringify(path)}`)
  }
  return join(root, ...path.split('/'))
}

function runtimeFiles(root: string): { path: string; name: string }[] {
  const files: { path: string; name: string }[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      if (name === DESKTOP_RUNTIME_FILE) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push({ path, name })
      else throw new Error(`desktop runtime: unsupported filesystem entry ${name}`)
    }
  }
  visit(root)
  return files
}

function runtimeFile(path: string, name: string, body: Buffer): DesktopRuntimeFile {
  return { path: name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'),
    // Windows has no portable Unix executable permission bits.
    executable: process.platform !== 'win32' && (lstatSync(path).mode & 0o111) !== 0 }
}

/**
 * Inventory a materialized runtime without following links or including its descriptor.
 * @param root - Self-contained runtime directory.
 * @returns Sorted final-file inventory; executable permissions are false on Windows.
 */
export function inventoryDesktopRuntime(root: string): DesktopRuntimeFile[] {
  return runtimeFiles(root).map(({ path, name }) => runtimeFile(path, name, readFileSync(path)))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function inventoryRuntimeForVerification(root: string): Promise<DesktopRuntimeFile[]> {
  const entries = runtimeFiles(root)
  const files: DesktopRuntimeFile[] = []
  const remaining = entries.values()
  let failed = false
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (!failed) {
      const next = remaining.next()
      if (next.done) return
      const { path, name } = next.value
      try {
        files.push(runtimeFile(path, name, await readRuntimeFile(path)))
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  // Failure returns only after every outstanding file read has closed its descriptor.
  const results = await Promise.allSettled(workers)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * Seal the final runtime tree after materialization and native signing.
 * @param root - Runtime output directory.
 * @param release - Matching shell, dsh, Host, and executable versions.
 * @param sharedNames - Release-owned packages supplied to plugins.
 * @param target - Platform, architecture, and enterprise service origin selected by runtime preparation.
 * @returns Descriptor written beside the production packages.
 */
export function writeDesktopRuntime(
  root: string, release: DesktopRelease, sharedNames: readonly string[],
  target: { platform: NodeJS.Platform; arch: string; enterpriseServiceOrigin?: string } = process,
): DesktopRuntimeDescriptor {
  const sharedPackages = [...new Set(sharedNames)].sort().map((name) => {
    if (!PACKAGE_NAME.test(name)) throw new Error(`desktop runtime: invalid shared package ${name}`)
    const path = `node_modules/${name}`
    const manifest: unknown = JSON.parse(readFileSync(join(runtimePath(root, path), 'package.json'), 'utf8'))
    if (!record(manifest) || manifest.name !== name || typeof manifest.version !== 'string' || valid(manifest.version) === null) {
      throw new Error(`desktop runtime: invalid shared package manifest ${name}`)
    }
    return { name, version: manifest.version, path }
  })
  const enterpriseBundle = sharedPackages.find(({ name }) => name === ENTERPRISE_BUNDLE_PACKAGE)
  const hasEnterprisePackages = sharedPackages.some(({ name }) => name.startsWith(ENTERPRISE_PACKAGE_SCOPE))
  if (hasEnterprisePackages && enterpriseBundle === undefined) {
    throw new Error(`desktop runtime: enterprise packages require ${ENTERPRISE_BUNDLE_PACKAGE} and its Host plugin allowlist`)
  }
  let allowedHostPlugins: readonly DesktopApprovedHostPlugin[] | undefined
  if (enterpriseBundle !== undefined) {
    const manifest: unknown = JSON.parse(readFileSync(join(root, enterpriseBundle.path, 'package.json'), 'utf8'))
    const dsh = record(manifest) && record(manifest.dsh) ? manifest.dsh : undefined
    const enterprise = dsh !== undefined && record(dsh.enterprise) ? dsh.enterprise : undefined
    const rawNames: unknown = enterprise?.allowedHostPluginNames
    if (!Array.isArray(rawNames)) {
      throw new Error(`desktop runtime: ${ENTERPRISE_BUNDLE_PACKAGE} must declare a unique Host plugin allowlist including itself`)
    }
    const names = rawNames as unknown[]
    if (!names.every((name: unknown): name is string => typeof name === 'string' && PACKAGE_NAME.test(name))
      || new Set(names).size !== names.length || !names.includes(ENTERPRISE_BUNDLE_PACKAGE)) {
      throw new Error(`desktop runtime: ${ENTERPRISE_BUNDLE_PACKAGE} must declare a unique Host plugin allowlist including itself`)
    }
    const sharedNamesSet = new Set(sharedPackages.map(({ name }) => name))
    if (names.some(name => !sharedNamesSet.has(name))) {
      throw new Error(`desktop runtime: ${ENTERPRISE_BUNDLE_PACKAGE} allowlist names must be included in the signed package set`)
    }
    allowedHostPlugins = Object.freeze(names.map(name => {
      const approved = sharedPackages.find(candidate => candidate.name === name)
      if (approved === undefined) throw new Error(`desktop runtime: allowlisted package ${name} is absent from the signed package set`)
      return Object.freeze({ name: approved.name, version: approved.version, path: approved.path })
    }))
  }
  const enterpriseServiceOrigin = enterpriseBundle === undefined ? undefined
    : target.enterpriseServiceOrigin ?? process.env.DSH_ENTERPRISE_SERVICE_ORIGIN
  if (enterpriseBundle !== undefined && !canonicalEnterpriseServiceOrigin(enterpriseServiceOrigin)) {
    throw new Error('desktop runtime: enterprise bundle requires a canonical HTTPS service origin')
  }
  const descriptor: DesktopRuntimeDescriptor = {
    schemaVersion: 1, release, platform: target.platform, arch: target.arch,
    sharedPackages, trustedHostPackages: installedPackageCatalog(root),
    ...(allowedHostPlugins === undefined ? {} : { allowedHostPlugins }),
    ...(enterpriseServiceOrigin === undefined ? {} : { enterpriseServiceOrigin }),
    files: inventoryDesktopRuntime(root),
  }
  writeFileSync(join(root, DESKTOP_RUNTIME_FILE), `${JSON.stringify(descriptor, undefined, 2)}\n`)
  return descriptor
}

/**
 * Read packaged metadata and check shared package records.
 * @param root - Current application's runtime resources.
 * @returns Runtime metadata whose release compatibility is verified during packaging.
 */
export function readDesktopRuntime(root: string): DesktopRuntimeDescriptor {
  const value: unknown = JSON.parse(readFileSync(join(root, DESKTOP_RUNTIME_FILE), 'utf8'))
  if (!record(value) || typeof value.platform !== 'string' || typeof value.arch !== 'string'
    || !Array.isArray(value.sharedPackages) || !Array.isArray(value.files)) {
    throw new Error('desktop runtime: invalid descriptor')
  }
  if (!record(value.release) || typeof value.release.version !== 'string'
    || typeof value.release.nodeVersion !== 'string' || typeof value.release.pnpmVersion !== 'string') {
    throw new Error('desktop runtime: invalid release fields')
  }
  const release = value.release as unknown as DesktopRelease
  const sharedPackages = value.sharedPackages.map((entry: unknown): DesktopSharedPackage => {
    if (!record(entry) || typeof entry.name !== 'string' || !PACKAGE_NAME.test(entry.name)
      || typeof entry.version !== 'string' || valid(entry.version) === null || entry.path !== `node_modules/${entry.name}`) {
      throw new Error('desktop runtime: invalid shared package record')
    }
    return { name: entry.name, version: entry.version, path: entry.path }
  })
  if (new Set(sharedPackages.map(entry => entry.name)).size !== sharedPackages.length) {
    throw new Error('desktop runtime: duplicate shared package')
  }
  let allowedHostPlugins: readonly DesktopApprovedHostPlugin[] | undefined
  const hasEnterprisePackages = sharedPackages.some(({ name }) => name.startsWith(ENTERPRISE_PACKAGE_SCOPE))
  const hasEnterpriseBundle = sharedPackages.some(({ name }) => name === ENTERPRISE_BUNDLE_PACKAGE)
  if (hasEnterpriseBundle) {
    if (!canonicalEnterpriseServiceOrigin(value.enterpriseServiceOrigin)) {
      throw new Error('desktop runtime: missing canonical HTTPS enterprise service origin')
    }
  } else if (value.enterpriseServiceOrigin !== undefined) {
    throw new Error('desktop runtime: unexpected enterprise service origin')
  }
  if (hasEnterprisePackages || value.allowedHostPlugins !== undefined) {
    const rawPlugins: unknown = value.allowedHostPlugins
    if (!Array.isArray(rawPlugins)) throw new Error('desktop runtime: invalid enterprise Host plugin allowlist')
    const plugins = rawPlugins as unknown[]
    if (!plugins.every((entry: unknown): entry is DesktopApprovedHostPlugin => record(entry)
      && typeof entry.name === 'string' && PACKAGE_NAME.test(entry.name)
      && typeof entry.version === 'string' && valid(entry.version) !== null
      && entry.path === `node_modules/${entry.name}`)
      || new Set(plugins.map(entry => record(entry) ? entry.name : undefined)).size !== plugins.length
      || !plugins.some(entry => record(entry) && entry.name === ENTERPRISE_BUNDLE_PACKAGE)) {
      throw new Error('desktop runtime: invalid enterprise Host plugin allowlist')
    }
    const sharedNames = new Set(sharedPackages.map(({ name }) => name))
    const validPlugins = plugins as DesktopApprovedHostPlugin[]
    if (validPlugins.some(plugin => !sharedNames.has(plugin.name)
      || sharedPackages.find(shared => shared.name === plugin.name)?.version !== plugin.version
      || sharedPackages.find(shared => shared.name === plugin.name)?.path !== plugin.path)) {
      throw new Error('desktop runtime: enterprise Host plugin allowlist is outside the signed package set')
    }
    allowedHostPlugins = Object.freeze(validPlugins.map(plugin => Object.freeze({ ...plugin })))
  }
  const files = value.files as DesktopRuntimeFile[]
  if (!Array.isArray(value.trustedHostPackages)) throw new Error('desktop runtime: missing trusted Host package catalog')
  const trustedHostPackages = value.trustedHostPackages.map((entry: unknown): DesktopSharedPackage => {
    if (!record(entry) || typeof entry.name !== 'string' || !PACKAGE_NAME.test(entry.name)
      || typeof entry.version !== 'string' || valid(entry.version) === null
      || typeof entry.path !== 'string' || !packageCatalogPath(entry.path, entry.name)) {
      throw new Error('desktop runtime: invalid trusted Host package record')
    }
    return Object.freeze({ name: entry.name, version: entry.version, path: entry.path })
  })
  const catalogPaths = trustedHostPackages.map(entry => entry.path)
  if (new Set(catalogPaths).size !== catalogPaths.length
    || catalogPaths.some((path, index) => index > 0 && path <= catalogPaths[index - 1]!)) {
    throw new Error('desktop runtime: invalid trusted Host package catalog order or duplicate path')
  }
  const trustedByPath = new Map(trustedHostPackages.map(entry => [entry.path, entry]))
  if (sharedPackages.some(shared => trustedByPath.get(shared.path)?.name !== shared.name
    || trustedByPath.get(shared.path)?.version !== shared.version)) {
    throw new Error('desktop runtime: trusted Host package catalog omits a shared package')
  }
  const inventoryPaths = new Set(files.map(entry => entry.path))
  if (trustedHostPackages.some(entry => !inventoryPaths.has(`${entry.path}/package.json`))) {
    throw new Error('desktop runtime: trusted Host package catalog is absent from the signed inventory')
  }
  for (const name of ['@deepseek-ai/dsh', DESKTOP_HOST_PACKAGE]) {
    if (sharedPackages.find(entry => entry.name === name)?.version !== release.version) {
      throw new Error(`desktop runtime: missing or mismatched ${name}`)
    }
  }
  return { schemaVersion: value.schemaVersion as 1, release, platform: value.platform as NodeJS.Platform,
    arch: value.arch, sharedPackages, trustedHostPackages,
    ...(allowedHostPlugins === undefined ? {} : { allowedHostPlugins }),
    ...(hasEnterpriseBundle ? { enterpriseServiceOrigin: value.enterpriseServiceOrigin as string } : {}), files }
}

/**
 * Verify every packaged runtime file against its recorded bytes and permissions at build time.
 * @param root - Materialized runtime resources.
 * @param expectedVersion - Version the bundled runtime must declare: the product version ordinarily,
 * and a rewritten one for installed-update qualification.
 * @param target - Required execution target; defaults to the current process.
 * @returns Validated runtime descriptor.
 */
export async function verifyDesktopRuntime(
  root: string, expectedVersion: string, target: { platform: NodeJS.Platform; arch: string } = process,
): Promise<DesktopRuntimeDescriptor> {
  const descriptor = readDesktopRuntime(root)
  // readDesktopRuntime preserves the disk schema value without validating release compatibility.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (descriptor.schemaVersion !== 1 || descriptor.platform !== target.platform || descriptor.arch !== target.arch) {
    throw new Error('desktop runtime: invalid descriptor or incompatible platform/architecture')
  }
  const release = parseDesktopRelease(descriptor.release)
  if (release.version !== expectedVersion) throw new Error(`desktop runtime: bundled ${release.version} is not the expected ${expectedVersion}`)
  for (const entry of descriptor.sharedPackages) {
    const manifest: unknown = JSON.parse(readFileSync(join(runtimePath(root, entry.path), 'package.json'), 'utf8'))
    if (!record(manifest) || manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(`desktop runtime: shared package metadata mismatch for ${entry.name}`)
    }
  }
  if (JSON.stringify(descriptor.trustedHostPackages) !== JSON.stringify(installedPackageCatalog(root))) {
    throw new Error('desktop runtime: trusted Host package catalog differs from installed packages')
  }
  const actual = await inventoryRuntimeForVerification(root)
  // Windows has no portable Unix executable permission bits.
  const comparable = (items: readonly DesktopRuntimeFile[]): unknown => process.platform === 'win32'
    ? items.map(({ executable: _executable, ...item }) => item) : items
  if (JSON.stringify(comparable(descriptor.files)) !== JSON.stringify(comparable(actual))) {
    throw new Error('desktop runtime: integrity verification failed')
  }
  return descriptor
}
