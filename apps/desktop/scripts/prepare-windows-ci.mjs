/** Resolve a manual Windows build version and validate the selected machine preset. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { desktopCiVersion as windowsCiVersion } from './desktop-ci-version.mjs'
export { desktopCiVersion as windowsCiVersion } from './desktop-ci-version.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { LOCAL_ENTERPRISE_APP_ID, OFFICIAL_APP_ID } from './desktop-release-environment.mjs'

/**
 * Validate manual inputs without reading local credentials or querying release storage.
 * @param {NodeJS.ProcessEnv} environment Manual inputs and GitHub run identity.
 * @param {string} productVersion Version declared by the selected checkout.
 * @param {Date} now Time used for the UTC date segment.
 * @returns {{ version: string, settings: string, edition: 'official' | 'enterprise' }} Validated version, public dotenv content, and selected edition.
 */
export function windowsCiSettings(environment, productVersion, now = new Date()) {
  const deployment = environment.PACKAGE_DEPLOYMENT
  if (deployment !== 'test' && deployment !== 'production') throw new Error('Select test or production deployment')
  const edition = environment.PACKAGE_EDITION?.trim() || 'official'
  if (edition !== 'official' && edition !== 'enterprise') throw new Error('Select official or enterprise edition')
  const loginOrigins = (environment.PACKAGE_LOGIN_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (deployment === 'production' && loginOrigins.length > 0) throw new Error('Production must not supply login origins')
  const originKey = deployment === 'test' ? 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN' : 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN'
  const config = deployment === 'test' ? { allowedAuthOrigins: loginOrigins } : {}
  const policy = resolveDesktopPolicyEnvironment({
    DSH_DESKTOP_AUTO_UPDATE_ENV: deployment,
    [originKey]: environment.PACKAGE_POLICY_ORIGIN,
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify(config),
  })
  const requested = environment.PACKAGE_BUILD_VERSION?.trim()
  if (!requested) throw new Error('Build version is required; use auto or a full version')
  let candidate = requested
  if (requested === 'auto') {
    for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
      if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
    }
    const date = now.toISOString().slice(0, 10).replaceAll('-', '')
    candidate = `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.${environment.GITHUB_RUN_ATTEMPT}`
  }
  const version = validateDesktopBuildVersion(candidate, productVersion)
  const settings = [
    `DSH_DESKTOP_APP_ID=${edition === 'enterprise' ? LOCAL_ENTERPRISE_APP_ID : OFFICIAL_APP_ID}`,
    `DSH_DESKTOP_AUTO_UPDATE_ENV=${deployment}`,
    `${originKey}=${policy.origin}`,
    `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG=${JSON.stringify(config)}`,
  ].join('\n') + '\n'
  return { version, settings, edition }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const appRoot = resolve(import.meta.dirname, '..')
  const product = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this adapter from GitHub Actions')
  if (process.env.PACKAGE_EDITION !== undefined) {
    const result = windowsCiSettings(process.env, product.version)
    writeFileSync(resolve(appRoot, '.env.windows'), result.settings, { flag: 'wx' })
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\n`)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Windows x64 unsigned ${result.edition} installer\n\nVersion: ${result.version}\n\nCommit: ${process.env.GITHUB_SHA}\n\nDeployment: ${process.env.PACKAGE_DEPLOYMENT}\n`)
  } else {
    const version = windowsCiVersion(process.env, product.version)
    const mode = process.env.PACKAGE_SIGNING
    if (mode !== 'unsigned' && mode !== 'signed') throw new Error('Select unsigned or signed packaging')
    if (!process.env.DSH_PACKAGING_PRESET) throw new Error('Select a machine preset')
    const environment = loadDesktopPackageEnvironment('win32', process.env, appRoot, { unsigned: mode === 'unsigned' })
    // Machine-owned secrets are not automatically known to the Actions log masker.
    for (const [name, value] of Object.entries(environment)) {
      if (/TOKEN|PASSWORD|SECRET/iu.test(name) && value) {
        const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
        process.stdout.write(`::add-mask::${escaped}\n`)
      }
    }
    validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }, { unsigned: mode === 'unsigned' })
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Windows x64 ${mode} installer\n\nVersion: ${version}\n\nCommit: ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}\n\nChannel: ${process.env.DSH_DESKTOP_UPDATE_CHANNEL}\n\nSource: ${process.env.PACKAGE_SOURCE_REF}\n\nPreset: ${process.env.DSH_PACKAGING_PRESET}\n`)
  }
}
