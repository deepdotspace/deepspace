import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..')
const sdkFeatureDirectory = join(packageDirectory, '..', 'deepspace', 'features', 'ai-chat')
const outputDirectory = join(packageDirectory, 'dist', 'features', 'ai-chat')

rmSync(outputDirectory, { recursive: true, force: true })
mkdirSync(dirname(outputDirectory), { recursive: true })
cpSync(sdkFeatureDirectory, outputDirectory, { recursive: true })
