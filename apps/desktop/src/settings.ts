/** Startup policy for optional Electron shell preferences, independent of the Host. */
import { DesktopSettingsFile, type DesktopEnterprisePreferences, type DesktopSettingsPatch, type DesktopUpdatePreferences } from './settings-file.ts'

/** Resolved shell preferences; invalid fields fall back independently. */
export interface DesktopSettings {
  readonly updates: Pick<DesktopUpdatePreferences, 'allowTestAuthPopupWindow'>
  readonly enterprise: DesktopEnterprisePreferences
}

/**
 * Initialize the shared document explicitly at startup, then resolve shell preferences.
 * @param userData - Electron userData, independent of DSH_HOME.
 * @returns Validated preferences, or disabled popups and no company with diagnostics for invalid fields; changes require restart.
 */
export async function readDesktopSettings(userData: string): Promise<DesktopSettings> {
  const file = new DesktopSettingsFile(userData)
  const result = await file.initialize()
  const preference = result.kind === 'ready' ? result.fields.allowTestAuthPopupWindow : undefined
  const company = result.kind === 'ready' ? result.fields.activeCompanyId : undefined
  const errors = result.kind === 'error' ? [result.error] : [preference, company].flatMap(field =>
    field?.kind === 'invalid' ? [field.error] : [])
  for (const error of errors) {
    try { console.warn(`desktop settings: ${file.path}: using defaults because settings could not be loaded`, error) } catch (_logError) {
      // Optional settings retain their defaults even when diagnostic output is unavailable.
    }
  }
  return {
    updates: { allowTestAuthPopupWindow: preference?.kind === 'valid' ? preference.value : false },
    enterprise: { activeCompanyId: company?.kind === 'valid' ? company.value : null },
  }
}

/**
 * Patch shell preferences through the shared serialized document writer without changing runtime state.
 * @param userData - Electron's userData directory.
 * @param settings - Fields to replace; omitted fields and unknown document fields remain unchanged.
 * @returns After persistence and lock release; rejects with DesktopSettingsFileError without retry or rollback.
 */
export async function writeDesktopSettings(userData: string, settings: DesktopSettingsPatch): Promise<void> {
  await new DesktopSettingsFile(userData).save(settings)
}
