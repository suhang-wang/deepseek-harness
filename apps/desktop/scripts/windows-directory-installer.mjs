/** Adapt the pinned NSIS template to stage and rename complete application directories. */
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis')
const patched = Symbol.for('@deepseek-ai/dsh-desktop/directory-installer')

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Desktop NSIS template changed: ${before}`)
  return source.replace(before, after)
}

/**
 * Preserve upstream registration and uninstall UI while replacing payload installation.
 * @param {string} source - Pinned electron-builder installSection.nsh contents.
 * @returns {string} Section with staging before shutdown and directory promotion before registration.
 */
export function directoryInstallSection(source) {
  let result = source.replaceAll('\r\n', '\n')
  result = replaceOnce(result, '!include installer.nsh', `!include installer.nsh
!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro dshExtractPayload "\${FILE}"
!macroend
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !insertmacro readReg $R4 "\${ROOT_KEY}" "\${INSTALL_REGISTRY_KEY}" InstallLocation
  \${If} $R4 == $INSTDIR
    StrCpy $R0 0
    ClearErrors
  \${Else}
    Push "\${ROOT_KEY}"
    Call uninstallOldVersion
  \${EndIf}
!macroend`)
  result = replaceOnce(result, '!insertmacro setLinkVars', `!insertmacro setLinkVars
!insertmacro dshStageApplication`)
  result = replaceOnce(result, '!insertmacro installApplicationFiles', 'Call dshPromoteDirectories\nIfErrors 0 +3\n  SetErrorLevel 2\n  Quit')
  result = replaceOnce(result, '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif\n', '')
  // The staging macro uses the upstream installer macro, including its signed uninstaller.
  return result
}

/**
 * Clean staged directories on upstream Quit paths, including silent installers.
 * @param {string} source - Pinned NSIS helper source.
 * @returns {string} Helper with cleanup before installer exits.
 */
export function directoryInstallerExits(source) {
  return source.replaceAll(/^(\s*)Quit\s*$/gm, '$1!ifndef BUILD_UNINSTALLER\n$1Call dshCleanupDirectories\n$1!endif\n$1Quit')
}

/** Install the build-only NSIS adapter without replacing electron-builder's signed bootstrap path. */
export function installWindowsDirectoryInstaller() {
  // The package entry initializes the platform classes before their mutually dependent leaves.
  require('app-builder-lib')
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js')
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
  const prototype = NsisTarget.prototype
  if (prototype[patched]) return
  prototype[patched] = true
  const computeUninstaller = prototype.computeScriptAndSignUninstaller
  prototype.computeScriptAndSignUninstaller = async function (defines, commands, installerPath, ...args) {
    // Custom scripts own uninstaller generation and must retain their original output path.
    if (await this.packager.getResource(this.options.script, 'installer.nsi') != null) {
      return computeUninstaller.call(this, defines, commands, installerPath, ...args)
    }
    const name = `nsis-${randomBytes(6).toString('hex')}`
    const bootstrap = join(this.outDir, `${name}.exe`)
    const uninstaller = join(this.outDir, `${name}.__uninstaller.exe`)
    if (uninstaller.length >= 260 || installerPath.length >= 260) {
      throw new Error('Desktop NSIS output path exceeds the Windows limit; use a shorter checkout path')
    }
    let completed = false
    let result
    const failures = []
    try {
      result = await computeUninstaller.call(this, defines, { ...commands, OutFile: `"${bootstrap}"` }, bootstrap, ...args)
      const generated = await stat(uninstaller).catch(error => {
        throw new Error('Desktop NSIS bootstrap did not create its uninstaller', { cause: error })
      })
      if (!generated.isFile() || generated.size === 0 || defines.UNINSTALLER_OUT_FILE !== uninstaller) {
        throw new Error('Desktop NSIS bootstrap produced an invalid uninstaller')
      }
      completed = true
    } catch (error) {
      failures.push(error)
    }
    // The final installer embeds this file and electron-builder then removes it.
    const cleanup = await Promise.allSettled((completed ? [bootstrap] : [bootstrap, uninstaller])
      .map(path => rm(path, { force: true })))
    failures.push(...cleanup.filter(item => item.status === 'rejected').map(item => item.reason))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Desktop NSIS generation and cleanup failed')
    return result
  }
  const compute = prototype.computeFinalScript
  prototype.computeFinalScript = async function (source, ...args) {
    const directory = join(this.outDir, '.nsis-directory-installer')
    await mkdir(directory, { recursive: true })
    const section = join(directory, 'installSection.nsh')
    await writeFile(section, directoryInstallSection(await readFile(join(templates, 'installSection.nsh'), 'utf8')))
    const sourceTool = await getPath7za()
    const tool = join(directory, '7za.exe')
    await copyFile(sourceTool, tool)
    await this.packager.signIf(tool)
    let adapted = replaceOnce(source, '!include "installSection.nsh"', `!include "${section}"`)
    for (const helper of ['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh']) {
      const path = join(directory, helper)
      await writeFile(path, directoryInstallerExits(await readFile(join(templates, 'include', helper), 'utf8')))
      adapted = replaceOnce(adapted, `!include "${helper}"`, `!include "${path}"`)
    }
    const uninstaller = join(directory, 'uninstaller.nsh')
    await writeFile(uninstaller, directoryUninstaller(await readFile(join(templates, 'uninstaller.nsh'), 'utf8')))
    adapted = replaceOnce(adapted, '!include "uninstaller.nsh"', `!include "${uninstaller}"`)
    return `!define DSH_UPDATER_CACHE_NAME "${this.packager.appInfo.updaterCacheDirName}"\n!define DSH_SEVENZIP_PATH "${tool}"\n!define DSH_SEVENZIP_LICENSE_DIR "${dirname(dirname(sourceTool))}"\n${await compute.call(this, adapted, ...args)}`
  }
}

/**
 * Keep user-data removal in the native helper, which refuses unsafe roots and never follows links.
 * @param {string} source - Pinned upstream uninstaller source.
 * @returns {string} Uninstaller with long-path application removal and no upstream RMDir data removal.
 */
export function directoryUninstaller(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  const start = normalized.indexOf('  Var /GLOBAL isDeleteAppData\n')
  const end = normalized.indexOf('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', start)
  if (start < 0 || end < 0) throw new Error('NSIS uninstaller data removal template changed')
  return replaceOnce(normalized.slice(0, start) + normalized.slice(end), 'RMDir /r $INSTDIR', 'RMDir /r "\\\\?\\$INSTDIR"')
}
