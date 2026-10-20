/** Ensure the release entry contains the Host allowlist guard before the package is packed. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const source = readFileSync(entry, 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (!Array.isArray(manifest.files) || !manifest.files.includes('lib/index.js') || !manifest.files.includes('lib/cli.js')) {
  throw new Error('desktop host build: package file allowlist must include both production entrypoints')
}
for (const marker of ['--dsh-host-plugin-allowlist=', '--dsh-host-plugin-allowlist-file=', 'duplicate Host plugin allowlist arguments', 'invalid Host plugin allowlist']) {
  if (!source.includes(marker)) throw new Error(`desktop host build: release entry is missing allowlist guard ${JSON.stringify(marker)}`)
}
process.stdout.write('desktop host build: release entry includes the validated Host plugin allowlist guard\n')
