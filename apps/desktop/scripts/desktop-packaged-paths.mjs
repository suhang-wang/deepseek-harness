/** Locate the executable that electron-builder emits for the selected product name. */
import { join } from 'node:path'

/**
 * @param {string} artifacts - Selected signed or unsigned artifact directory.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Packaged target.
 * @param {string} productName - Product name sealed in the package manifest.
 * @returns {{ application: string, executable: string }} Paths to the application contents and executable.
 */
export function resolveDesktopPackagedExecutable(artifacts, target, productName) {
  if (target === 'win-x64') {
    const application = join(artifacts, 'win-unpacked')
    return { application, executable: join(application, `${productName}.exe`) }
  }
  const application = join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', `${productName}.app`, 'Contents')
  return { application, executable: join(application, 'MacOS', productName) }
}
