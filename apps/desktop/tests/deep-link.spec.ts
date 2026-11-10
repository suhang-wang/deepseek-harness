import { describe, expect, it } from 'vitest'
import { isAppOpenDeepLink } from '../src/deep-link.ts'

describe('app-open deep link', () => {
  it('accepts only the exact application-open URL', () => {
    expect(isAppOpenDeepLink('dsh-enterprise', 'dsh-enterprise://open')).toBe(true)
    expect(isAppOpenDeepLink('dsh-enterprise', 'dsh-enterprise://open/')).toBe(true)
  })

  it.each([
    'dsh://open',
    'dsh-enterprise://open?company=company-b',
    'dsh-enterprise://open#fragment',
    'dsh-enterprise://open/company-b',
    'dsh-enterprise://open//',
    'dsh-enterprise://OPEN',
    'dsh-enterprise://open@evil.example',
    'dsh-enterprise://open%2F',
    'dsh-enterprise:open',
    ' dsh-enterprise://open',
  ])('rejects %s', (url) => {
    expect(isAppOpenDeepLink('dsh-enterprise', url)).toBe(false)
  })
})
