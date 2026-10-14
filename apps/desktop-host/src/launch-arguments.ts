/** Parse private Desktop-to-Host process arguments without mixing options and paths. */

import { readHostPluginAllowlist, type HostPluginAllowlist } from './host-plugin-allowlist.ts'

/** Parsed arguments supplied by the native Desktop process. */
export interface DesktopHostLaunchArguments {
  readonly runtimeDir: string
  readonly projectDir: string
  readonly primaryRuntime: string
  readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string }
  readonly hostPluginAllowlist?: HostPluginAllowlist
}

const HOST_PLUGIN_ALLOWLIST_PREFIX = '--dsh-host-plugin-allowlist='

/**
 * Parse the three required paths, an optional pair of package-manager paths, and the optional Host policy.
 * @param argv - Arguments after the Host entrypoint.
 * @returns Parsed, separated launch inputs.
 */
export function readDesktopHostLaunchArguments(argv: readonly string[]): DesktopHostLaunchArguments {
  const hostPluginAllowlist = readHostPluginAllowlist(argv)
  const paths = argv.filter(argument => !argument.startsWith(HOST_PLUGIN_ALLOWLIST_PREFIX))
  if ((paths.length !== 3 && paths.length !== 5)
    || paths.some(argument => argument.length === 0 || argument.startsWith('--'))) {
    throw new Error('desktop host: invalid launch arguments')
  }
  const [runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin] = paths
  if (runtimeDir === undefined || projectDir === undefined || primaryRuntime === undefined) {
    throw new Error('desktop host: invalid launch arguments')
  }
  return {
    runtimeDir, projectDir, primaryRuntime,
    ...(pnpm === undefined || nodeBin === undefined ? {} : { packageManager: { pnpm, nodeBin } }),
    ...(hostPluginAllowlist === undefined ? {} : { hostPluginAllowlist }),
  }
}
