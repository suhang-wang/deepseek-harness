/** Public settings prepared for a manual Windows package run. */
export interface WindowsCiSettings {
  version: string
  settings: string
  edition: 'official' | 'enterprise'
}

/**
 * Validate manual inputs without local credentials or release storage.
 * @param environment Manual inputs and GitHub run identity.
 * @param productVersion Version declared by the selected checkout.
 * @param now Time used for the UTC date segment.
 * @returns Validated version, public dotenv content, and selected edition.
 */
export function windowsCiSettings(environment: NodeJS.ProcessEnv, productVersion: string, now?: Date): WindowsCiSettings
