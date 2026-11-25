/** Accepted application-open URLs; no path, query, fragment or company selector is permitted. */
export function isAppOpenDeepLink(scheme: string, url: string): boolean {
  return url === `${scheme}://open` || url === `${scheme}://open/`
}
