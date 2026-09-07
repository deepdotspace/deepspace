/**
 * create-deepspace
 *
 * Scaffolds a new DeepSpace app from an embedded template, installs the agent
 * skill, and starts dependency setup. The app's immutable id is NOT minted
 * here — it is registered on first use by whichever verb needs it.
 * Features remain in the `deepspace` SDK package rather than copied source.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCliInput } from './cli-input'
import { checkedInstallCommand } from './install-cmd'
import { DEFAULT_TEMPLATE, listTemplates, prepareProject } from './project-template'
import { completeProjectSetup, createProgress } from './setup-runtime'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

function readCreatorPackage(): { version: string; engines: { npm: string } } {
  return JSON.parse(readFileSync(join(SOURCE_DIR, '..', 'package.json'), 'utf-8'))
}

async function main(): Promise<void> {
  const creator = readCreatorPackage()
  const input = await readCliInput(
    process.argv,
    () => creator.version,
    listTemplates,
    DEFAULT_TEMPLATE,
  )
  const install = checkedInstallCommand(creator.engines.npm)
  if (!install.ok) {
    console.error(install.error)
    process.exit(1)
  }
  const progress = createProgress()
  const project = prepareProject(input, creator.version, progress)
  await completeProjectSetup(project, progress, install.install)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
