/**
 * create-deepspace
 *
 * Scaffolds a new DeepSpace app from an embedded template and installs app
 * dependencies. Skill installation is opt-in. The app's immutable id is NOT minted
 * here — it is registered on first use by whichever verb needs it.
 * Features remain in the `deepspace` SDK package rather than copied source.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, readCliInput } from './cli-input'
import { checkedInstallCommand } from './install-cmd'
import { DEFAULT_TEMPLATE, listTemplates, prepareProject } from './project-template'
import { completeProjectSetup, createProgress } from './setup-runtime'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

function readCreatorPackage(): { version: string; engines: { npm: string } } {
  return JSON.parse(readFileSync(join(SOURCE_DIR, '..', 'package.json'), 'utf-8'))
}

function readPrototypeBuild(): { sdkUrl: string; skillSource: string } | undefined {
  let text: string
  try {
    text = readFileSync(join(SOURCE_DIR, 'agent-build.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const build = JSON.parse(text) as { sdkUrl?: unknown; skillSource?: unknown }
  if (
    typeof build.sdkUrl !== 'string' ||
    parseArgs(['node', 'create-deepspace', '--sdk-url', build.sdkUrl]).invalid
  )
    throw new Error(
      'The prototype build is missing a valid pinned SDK URL. Reinstall from its public manifest.',
    )
  if (
    typeof build.skillSource !== 'string' ||
    !/^https:\/\/github\.com\/deepdotspace\/deepspace-skill\/tree\/[a-f0-9]{40}\/skills\/deepspace$/.test(
      build.skillSource,
    )
  )
    throw new Error(
      'The prototype build is missing a pinned DeepSpace skill. Reinstall from its public manifest.',
    )
  return { sdkUrl: build.sdkUrl, skillSource: build.skillSource }
}

async function main(): Promise<void> {
  const creator = readCreatorPackage()
  const prototype = readPrototypeBuild()
  const input = await readCliInput(
    process.argv,
    () => creator.version,
    listTemplates,
    DEFAULT_TEMPLATE,
    prototype?.sdkUrl,
  )
  const install = checkedInstallCommand(creator.engines.npm)
  if (!install.ok) {
    console.error(install.error)
    process.exit(1)
  }
  const progress = createProgress()
  const project = prepareProject(
    { ...input, agentAccount: Boolean(prototype) },
    creator.version,
    progress,
  )
  await completeProjectSetup(
    project,
    progress,
    install.install,
    prototype?.skillSource,
    input.withSkill,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
