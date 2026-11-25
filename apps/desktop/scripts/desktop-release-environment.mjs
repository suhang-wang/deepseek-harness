/** Resolve public release identifiers supplied by the packaging environment. */

/** Environment variable that supplies the Electron application identifier. */
export const DESKTOP_APP_ID_ENV = 'DSH_DESKTOP_APP_ID'

/** Local-only identifier; a signed enterprise build must use an identifier owned by its publisher. */
export const LOCAL_ENTERPRISE_APP_ID = 'com.deepseek.harness.enterprise.local'
export const OFFICIAL_APP_ID = 'com.deepseek.harness'
export const ENTERPRISE_PROTOCOL_SCHEME_ENV = 'DSH_DESKTOP_ENTERPRISE_PROTOCOL_SCHEME'
export const ENTERPRISE_PRODUCT_NAME_ENV = 'DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME'

/** Environment variable that supplies electron-builder's macOS certificate qualifier. */
export const MACOS_SIGNING_IDENTITY_ENV = 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY'

/** Environment variable that supplies the expected Apple Developer Team ID. */
export const MACOS_TEAM_ID_ENV = 'DSH_DESKTOP_MACOS_TEAM_ID'

/** Environment variable that selects the npm registry used for the bundled runtime install. */
export const NPM_REGISTRY_ENV = 'DSH_DESKTOP_NPM_REGISTRY'

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/'

const APPLE_API_KEY_ENV = 'APPLE_API_KEY'
const APPLE_API_KEY_ID_ENV = 'APPLE_API_KEY_ID'
const APPLE_API_ISSUER_ENV = 'APPLE_API_ISSUER'
const APPLE_ID_ENV = 'APPLE_ID'
const APPLE_APP_SPECIFIC_PASSWORD_ENV = 'APPLE_APP_SPECIFIC_PASSWORD'
const APPLE_TEAM_ID_ENV = 'APPLE_TEAM_ID'
const APPLE_KEYCHAIN_ENV = 'APPLE_KEYCHAIN'
const APPLE_KEYCHAIN_PROFILE_ENV = 'APPLE_KEYCHAIN_PROFILE'

/**
 * Read one required non-empty environment variable.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {string} name - Required variable name.
 * @returns {string} Trimmed variable value.
 */
function requireEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop release environment: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Resolve the npm registry used to materialize the bundled runtime and its external dependencies.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Registry origin; the public registry unless a local mirror is configured.
 */
export function resolveNpmRegistry(env) {
  const configured = env[NPM_REGISTRY_ENV]?.trim() ?? ''
  if (configured === '') return DEFAULT_NPM_REGISTRY
  let url
  try { url = new URL(configured) }
  catch { throw new Error(`desktop release environment: ${NPM_REGISTRY_ENV} must be an HTTPS origin`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`desktop release environment: ${NPM_REGISTRY_ENV} must be an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Resolve and validate the application identifier shared by every platform target.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Reverse-DNS application identifier.
 */
export function resolveDesktopAppId(env) {
  const appId = requireEnvironmentValue(env, DESKTOP_APP_ID_ENV)
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(appId)) {
    throw new Error(`desktop release environment: ${DESKTOP_APP_ID_ENV} must be a reverse-DNS identifier`)
  }
  return appId
}

/**
 * Select the packaged edition and reject identities that could collide with the other edition.
 * Ownership of a signed identifier must also be confirmed by the enterprise publisher.
 * @param {NodeJS.ProcessEnv} env - Selected packaging environment.
 * @returns {{ edition: 'official' | 'enterprise', appId: string, productName: string, protocolScheme: string, artifactPrefix: string }}
 */
export function resolveDesktopPackageIdentity(env) {
  const mode = env.DSH_DESKTOP_ENTERPRISE_MODE
  if (mode !== undefined && mode !== '1') {
    throw new Error('desktop release environment: DSH_DESKTOP_ENTERPRISE_MODE must be 1 when present')
  }
  const appId = resolveDesktopAppId(env)
  if (mode === undefined) {
    if (env[ENTERPRISE_PROTOCOL_SCHEME_ENV] !== undefined || env[ENTERPRISE_PRODUCT_NAME_ENV] !== undefined) {
      throw new Error('desktop release environment: enterprise identity settings require enterprise mode')
    }
    if (appId === LOCAL_ENTERPRISE_APP_ID) {
      throw new Error('desktop release environment: provisional enterprise app ID requires enterprise mode')
    }
    return { edition: 'official', appId, productName: 'DeepSeek Harness', protocolScheme: 'dsh', artifactPrefix: 'deepseek-harness' }
  }
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u.test(appId)) {
    throw new Error('desktop release environment: enterprise app ID must be a lowercase reverse-DNS identifier')
  }
  const customScheme = env[ENTERPRISE_PROTOCOL_SCHEME_ENV]
  if (customScheme !== undefined && (!/^[a-z][a-z0-9-]{2,63}$/u.test(customScheme)
    || ['dsh', 'dsh-app', 'http', 'https', 'file', 'mailto'].includes(customScheme))) {
    throw new Error(`desktop release environment: ${ENTERPRISE_PROTOCOL_SCHEME_ENV} must be a distinct lowercase URL scheme`)
  }
  const customProductName = env[ENTERPRISE_PRODUCT_NAME_ENV]
  if (customProductName !== undefined && (customProductName.length < 3 || customProductName.length > 64
    || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*[\p{L}\p{N}]$/u.test(customProductName)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(customProductName))) {
    throw new Error(`desktop release environment: ${ENTERPRISE_PRODUCT_NAME_ENV} must be a safe display name of 3 to 64 characters`)
  }
  if ((customScheme === undefined) !== (customProductName === undefined)) {
    throw new Error('desktop release environment: a custom enterprise scheme and product name must be configured together')
  }
  if (appId === LOCAL_ENTERPRISE_APP_ID && (customScheme !== undefined || customProductName !== undefined)) {
    throw new Error('desktop release environment: a custom enterprise identity requires its own app ID')
  }
  if (customScheme === 'dsh-enterprise' && customProductName !== undefined) {
    throw new Error('desktop release environment: a custom enterprise product requires its own protocol scheme')
  }
  if (customProductName !== undefined && ['deepseek harness', 'deepseek harness enterprise'].includes(customProductName.toLowerCase())) {
    throw new Error('desktop release environment: a custom enterprise client requires a distinct product name')
  }
  if (appId !== LOCAL_ENTERPRISE_APP_ID && (!customScheme || !customProductName)) {
    throw new Error('desktop release environment: custom enterprise app ID requires a distinct protocol scheme and product name')
  }
  if (env.DSH_DESKTOP_UNSIGNED !== '1' && (appId === LOCAL_ENTERPRISE_APP_ID || appId.startsWith('com.deepseek.'))) {
    throw new Error('desktop release environment: signed enterprise app ID must be an explicit identifier owned by the enterprise publisher')
  }
  if (appId !== LOCAL_ENTERPRISE_APP_ID && appId.startsWith('com.deepseek.')) {
    throw new Error('desktop release environment: enterprise app ID must not use the official namespace')
  }
  return { edition: 'enterprise', appId, productName: customProductName ?? 'DeepSeek Harness Enterprise',
    protocolScheme: customScheme ?? 'dsh-enterprise',
    artifactPrefix: customProductName === undefined && customScheme === undefined
      ? 'deepseek-harness-enterprise' : `deepseek-harness-enterprise-${appId}` }
}

/**
 * Resolve and validate the public identity expected on a macOS release.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ signingIdentity: string, teamId: string }} Expected certificate qualifier and Team ID.
 */
export function resolveMacOSSigningEnvironment(env) {
  const signingIdentity = requireEnvironmentValue(env, MACOS_SIGNING_IDENTITY_ENV)
  if (signingIdentity.startsWith('Developer ID Application:')) {
    throw new Error(`desktop release environment: ${MACOS_SIGNING_IDENTITY_ENV} must omit the "Developer ID Application:" prefix`)
  }
  const teamId = requireEnvironmentValue(env, MACOS_TEAM_ID_ENV)
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error(`desktop release environment: ${MACOS_TEAM_ID_ENV} must contain 10 uppercase letters or digits`)
  }
  return { signingIdentity, teamId }
}

/**
 * Resolve one complete credential set accepted by Apple's notary service.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ appleId: string, appleIdPassword: string, teamId: string } | { appleApiKey: string, appleApiKeyId: string, appleApiIssuer: string } | { keychainProfile: string, keychain?: string }} Notary credentials without the submitted artifact path.
 */
export function resolveMacOSNotarizationEnvironment(env) {
  const appleIdValues = [env[APPLE_ID_ENV], env[APPLE_APP_SPECIFIC_PASSWORD_ENV], env[APPLE_TEAM_ID_ENV]]
  if (appleIdValues.some(value => value !== undefined)) {
    return {
      appleId: requireEnvironmentValue(env, APPLE_ID_ENV),
      appleIdPassword: requireEnvironmentValue(env, APPLE_APP_SPECIFIC_PASSWORD_ENV),
      teamId: requireEnvironmentValue(env, APPLE_TEAM_ID_ENV),
    }
  }

  const apiKeyValues = [env[APPLE_API_KEY_ENV], env[APPLE_API_KEY_ID_ENV], env[APPLE_API_ISSUER_ENV]]
  if (apiKeyValues.some(value => value !== undefined)) {
    return {
      appleApiKey: requireEnvironmentValue(env, APPLE_API_KEY_ENV),
      appleApiKeyId: requireEnvironmentValue(env, APPLE_API_KEY_ID_ENV),
      appleApiIssuer: requireEnvironmentValue(env, APPLE_API_ISSUER_ENV),
    }
  }

  const keychainProfile = env[APPLE_KEYCHAIN_PROFILE_ENV]?.trim()
  if (keychainProfile !== undefined && keychainProfile !== '') {
    const keychain = env[APPLE_KEYCHAIN_ENV]?.trim()
    return keychain === undefined || keychain === ''
      ? { keychainProfile }
      : { keychainProfile, keychain }
  }

  throw new Error('desktop release environment: macOS packaging requires APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER; APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID; or APPLE_KEYCHAIN_PROFILE')
}
