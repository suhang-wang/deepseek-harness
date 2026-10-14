import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveDesktopPackagedExecutable } from '../scripts/desktop-packaged-paths.mjs'

it('locates the renamed enterprise macOS executable without changing ordinary package paths', () => {
  expect(resolveDesktopPackagedExecutable('/artifacts', 'mac-arm64', 'DeepSeek Harness Enterprise'))
    .toEqual({ application: join('/artifacts', 'mac-arm64', 'DeepSeek Harness Enterprise.app', 'Contents'),
      executable: join('/artifacts', 'mac-arm64', 'DeepSeek Harness Enterprise.app', 'Contents', 'MacOS', 'DeepSeek Harness Enterprise') })
  expect(resolveDesktopPackagedExecutable('/artifacts', 'mac-arm64', 'DeepSeek Harness').executable)
    .toContain('DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
})
