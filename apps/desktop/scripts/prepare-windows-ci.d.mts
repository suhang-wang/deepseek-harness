/** Public settings prepared for a manual Windows package run. */
export interface WindowsCiSettings {
  version: string
  settings: string
  edition: 'official' | 'enterprise'
}

/**
 * Resolve an explicit version or a UTC date/run/attempt identifier without release storage access.
 * @param environment Manual version and GitHub run identity.
 * @param productVersion Version declared by the selected checkout.
 * @param now Time used for the UTC date segment.
 * @returns Validated build version.
 */
export function windowsCiVersion(environment: NodeJS.ProcessEnv, productVersion: string, now?: Date): string

/**
 * Validate manual inputs without reading local credentials or querying release storage.
 * @param environment Manual inputs and GitHub run identity.
 * @param productVersion Version declared by the selected checkout.
 * @param now Time used for the UTC date segment.
 * @returns Validated version, public dotenv content, and selected edition.
 */
export function windowsCiSettings(environment: NodeJS.ProcessEnv, productVersion: string, now?: Date): WindowsCiSettings
