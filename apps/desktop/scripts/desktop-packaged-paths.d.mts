/** Resolve a packaged executable using the edition-specific product name. */
export function resolveDesktopPackagedExecutable(
  artifacts: string,
  target: 'mac-arm64' | 'mac-x64' | 'win-x64',
  productName: string,
): { readonly application: string; readonly executable: string }
