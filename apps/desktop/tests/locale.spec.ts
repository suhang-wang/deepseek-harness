import { SHIPPED_LOCALE_IDS } from '../../../scripts/shipped-locales.ts'
import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, ja, zh, es, fr, de, ru, pt } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('uses the same concise Chinese configuration error in the toast and details', () => {
    for (const message of [zh.updateConfigurationRead, zh.updateConfigurationFormat, zh.updateConfigurationChannel]) {
      expect(message).toBe('配置文件异常，更新已暂停')
    }
  })

  it('ships baseline and Japanese keys and falls back for unsupported languages', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(Object.keys(ja)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('JA-jp')).toEqual({ id: 'ja', messages: ja })
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('it-IT').messages).toEqual(en)
  })

  it.each([
    ['es', 'es-MX', es], ['fr', 'fr-CA', fr], ['de', 'de-DE', de],
    ['ru', 'ru-RU', ru], ['pt', 'pt-BR', pt],
  ] as const)('resolves %s, preserves placeholders, and honors saved preferences', (id, tag, messages) => {
    expect(resolveDesktopLocale(tag.toUpperCase())).toEqual({ id, messages })
    expect(resolveDesktopStartupLocale(id, ['zh-CN']).id).toBe(id)
    expect(resolveDesktopStartupLocale(null, ['it-IT', tag, 'en-US']).id).toBe(id)
    expect(Object.keys(messages)).toEqual(Object.keys(en))
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const placeholders = (text: string): string[] => (text.match(/\{\w+\}/gu) ?? []).sort()
      expect(placeholders(messages[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it.each(SHIPPED_LOCALE_IDS)('resolves every shipped language %s without fallback', (id) => {
    expect(resolveDesktopLocale(id).id).toBe(id === 'zh' ? 'zh-CN' : id)
    expect(resolveDesktopStartupLocale(null, [id]).id).toBe(id === 'zh' ? 'zh-CN' : id)
  })

  it('brands shell copy with the packaged company name', () => {
    const english = resolveDesktopLocale('en', 'Ruqinba Harness').messages
    expect(english.aboutProduct).toBe('Ruqinba Harness')
    expect(english.startupFailed).toBe('Ruqinba Harness is unavailable')
    expect(english.quitApplication).toBe('Quit Ruqinba Harness')
    const chinese = resolveDesktopLocale('zh-CN', 'Ruqinba Harness').messages
    expect(chinese.aboutMenu).toBe('关于 Ruqinba Harness')
    expect(chinese.startupFailed).toBe('Ruqinba Harness 无法使用')
    expect(resolveDesktopStartupLocale('zh', [], 'Ruqinba Harness').messages.quitTitle).toBe('退出 Ruqinba Harness？')
  })

  it.each(SHIPPED_LOCALE_IDS)('brands every shipped language %s without changing its selection', (id) => {
    const productName = 'Enterprise $& Desktop'
    const branded = resolveDesktopLocale(id, productName)
    const original = resolveDesktopLocale(id)
    expect(branded.id).toBe(original.id)
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(branded.messages[key]).toBe(original.messages[key]
        .replaceAll('DeepSeek Harness Enterprise', () => productName)
        .replaceAll('DeepSeek Harness 企业版', () => productName)
        .replaceAll('DeepSeek Harness', () => productName))
    }
    expect(resolveDesktopStartupLocale(id, ['en'], productName)).toEqual(branded)
    expect(resolveDesktopStartupLocale(null, [id], productName)).toEqual(branded)
  })

  it('localizes company switching and preserves the selected company name', () => {
    const name = '企业 $& 工作台'
    expect(zh.switchCompanyMenu).toBe('切换公司…')
    expect(en.switchCompanyMenu).toBe('Switch company…')
    expect(formatDesktopMessage(zh.switchCompanyTitle, { company: name })).toBe(`切换到 ${name}`)
    expect(formatDesktopMessage(en.switchCompanyTitle, { company: name })).toBe(`Switch to ${name}`)
    for (const id of SHIPPED_LOCALE_IDS) {
      const messages = resolveDesktopLocale(id).messages
      expect(messages.restartAndSwitch.length).toBeGreaterThan(0)
      expect(messages.switchCompanyDetail.length).toBeGreaterThan(0)
      expect(formatDesktopMessage(messages.switchCompanyTitle, { company: name })).toContain(name)
    }
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('ja')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('ja')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('ja')
  })

})
