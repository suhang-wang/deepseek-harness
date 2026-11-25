import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { packFamilyMembers } from '../../../scripts/release/pack.ts'

vi.mock('../../../scripts/release/pack.ts', () => ({
  parsePackConcurrency: vi.fn(() => 1),
  packFamilyMembers: vi.fn(async () => []),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.resetModules()
})

describe('desktop local package staging', () => {
  it('accepts client artifacts branded with the enterprise product name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-local-pack-'))
    const destination = join(root, 'packed')
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const productName = 'Enterprise Workspace'
    const write = (path: string, content: string): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    write(join(root, 'package.json'), '{"version":"1.2.3"}\n')
    write(join(root, 'apps/web/dist/index.html'), '<main></main>\n')
    write(join(root, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
    writeClientBuildRecord(root, {
      DSH_CLIENT_BUILD_PROFILE: 'local',
      DSH_CLIENT_COMMIT_HASH: commit.slice(0, 7),
      DSH_CLIENT_TITLE: productName,
      DSH_CLIENT_VERSION: '1.2.3',
    })

    const originalArgv = process.argv
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', commit)
    vi.stubEnv('DSH_CLIENT_TITLE', 'Inherited title')
    vi.stubEnv('DSH_DESKTOP_ENTERPRISE_PRODUCT_NAME', productName)
    process.argv = ['node', 'pack-local-packages.ts', '--out', destination, '--concurrency', '1']
    try {
      await import('../scripts/pack-local-packages.ts')
      expect(packFamilyMembers).toHaveBeenCalledWith(root, expect.anything(), destination, 1)
    } finally {
      process.argv = originalArgv
      cwd.mockRestore()
      vi.unstubAllEnvs()
      vi.resetModules()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
