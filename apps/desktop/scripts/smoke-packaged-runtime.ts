/** Validate the assembled application, including native Office conversion outside ASAR. */
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import { resolveDesktopPackageIdentity } from './desktop-release-environment.mjs'
import { resolveDesktopPackagedExecutable } from './desktop-packaged-paths.mjs'
import { withPackagedSmokeApplication } from './packaged-smoke-directory.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const output = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] })
const productName = resolveDesktopPackageIdentity({ ...process.env,
  DSH_DESKTOP_UNSIGNED: values.unsigned ? '1' : '0' }).productName
const { application, executable } = resolveDesktopPackagedExecutable(output.directory, target, productName)
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
await withPackagedSmokeApplication(application, async (checkedApplication) => {
  const resources = join(checkedApplication, windows ? 'resources' : 'Resources')
  const checkedExecutable = windows ? join(checkedApplication, basename(executable)) : executable
  if (windows && !values.unsigned) await verifyWindowsCode(checkedApplication)
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), checkedExecutable, join(resources, 'runtime'), descriptor)
}, windows ? 'win32' : 'darwin')
