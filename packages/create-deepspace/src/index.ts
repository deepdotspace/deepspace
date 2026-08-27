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
import { DEFAULT_TEMPLATE, listTemplates, prepareProject } from './project-template'
import { completeProjectSetup, createProgress } from './setup-runtime'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

function readCreatorVersion(): string {
  const creatorPackage = JSON.parse(
    readFileSync(join(SOURCE_DIR, '..', 'package.json'), 'utf-8'),
  ) as { version: string }
  return creatorPackage.version
}

async function main(): Promise<void> {
  const input = await readCliInput(
    process.argv,
    readCreatorVersion,
    listTemplates,
    DEFAULT_TEMPLATE,
  )
  const progress = createProgress()
  const project = prepareProject(input, readCreatorVersion(), progress)
  await completeProjectSetup(project, progress)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
