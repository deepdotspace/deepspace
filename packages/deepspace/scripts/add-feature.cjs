#!/usr/bin/env node
/**
 * Feature Installation Script (CommonJS)
 *
 * Installs DeepSpace features into an app directory. Ships inside the
 * `deepspace` npm package at `node_modules/deepspace/scripts/add-feature.cjs`
 * and reads features from a sibling `node_modules/deepspace/features/` dir.
 * Invoked by the `deepspace add` CLI in src/cli/commands/add.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS (.cjs) module: require is required
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS (.cjs) module: require is required
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS (.cjs) module: require is required
const { spawnSync } = require('child_process')

// ---------------------------------------------------------------------------
// Environment-aware features path resolution
// ---------------------------------------------------------------------------

function findFeaturesDir() {
  const candidate = path.resolve(__dirname, '..', 'features')
  if (fs.existsSync(candidate)) return candidate
  console.error('Error: Could not find features directory at ' + candidate)
  process.exit(1)
}

const FEATURES_DIR = findFeaturesDir()

// ---------------------------------------------------------------------------
// Resolve target directory
// ---------------------------------------------------------------------------

function resolveTargetDir(raw) {
  if (!raw) return null
  if (path.isAbsolute(raw)) return raw
  return path.resolve(raw)
}

// ---------------------------------------------------------------------------
// Category labels & ordering
// ---------------------------------------------------------------------------

const CATEGORY_LABELS = {
  assistant: 'AI Features',
  data: 'Data Features',
  nav: 'Navigation',
  layout: 'Layouts',
  display: 'Display',
  landing: 'Landing Page Sections',
}

const CATEGORY_ORDER = ['assistant', 'data', 'nav', 'layout', 'display', 'landing']

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function loadFeatureConfig(featureId) {
  const configPath = path.join(FEATURES_DIR, featureId, 'feature.json')
  if (!fs.existsSync(configPath)) return null
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (e) {
    console.error(`Error reading ${configPath}:`, e.message)
    return null
  }
}

function listFeatures() {
  const entries = fs.readdirSync(FEATURES_DIR, { withFileTypes: true })
  const configs = []
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'scripts') {
      const config = loadFeatureConfig(e.name)
      // Internal features (e2e/QA fixtures) are installable by explicit name
      // but hidden from `--list` and the interactive picker.
      if (config && !config.internal) configs.push(config)
    }
  }
  return configs
}

function groupByCategory(features) {
  const groups = new Map()
  for (const f of features) {
    const category = f.category || 'other'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(f)
  }
  return groups
}

// First feature id in display order — used for a never-stale help example.
function firstFeatureId(groups) {
  for (const category of CATEGORY_ORDER) {
    const list = groups.get(category)
    if (list && list.length > 0) return list[0].id
  }
  return null
}

// Small edit distance for "did you mean" suggestions on a typo'd feature id.
function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  const row = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = tmp
    }
  }
  return row[n]
}

// Closest visible feature id to a typo, or null when nothing is close enough.
function suggestFeature(featureId) {
  let best = null
  let bestD = Infinity
  for (const f of listFeatures()) {
    const d = levenshtein(featureId, f.id)
    if (d < bestD) {
      bestD = d
      best = f.id
    }
  }
  const threshold = Math.max(2, Math.floor(featureId.length / 3))
  return best && bestD <= threshold ? best : null
}

// Print a friendly unknown-feature error (with a suggestion) and exit.
function unknownFeature(featureId) {
  console.error(`\nError: Unknown feature: ${featureId}`)
  const guess = suggestFeature(featureId)
  if (guess) console.error(`Did you mean "${guess}"?`)
  console.error('Run `deepspace add --list` to see available features')
  process.exit(1)
}

// Detect the target app's package manager from its lockfile (defaults to npm).
function detectPackageManager(targetDir) {
  const has = (f) => fs.existsSync(path.join(targetDir, f))
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  if (has('bun.lockb') || has('bun.lock')) return 'bun'
  return 'npm'
}

// The nav features are mutually exclusive (competing navigation). Derive which
// are installed from the catalog itself — each nav feature's first installed
// file is its signature — so this never drifts from what a feature ships.
function installedNavFeatures(targetDir) {
  return listFeatures()
    .filter((f) => f.category === 'nav' && Array.isArray(f.files) && f.files.length > 0)
    .filter((f) =>
      fs.existsSync(path.join(targetDir, resolveDestPath(f.files[0].dest, f.route))),
    )
    .map((f) => f.id)
}

function warnNavConflicts(config, targetDir) {
  if (config.category !== 'nav') return
  const present = installedNavFeatures(targetDir)
  if (present.length > 1) {
    console.log(`\n⚠ Multiple navigation features present (${present.join(', ')}).`)
    console.log(
      '  sidebar, topbar, and tree are mutually exclusive — keep one and remove the',
    )
    console.log('  others to avoid competing navigation in your layout.')
  }
}

// Always-printed footer so every install ends with a clear "what now".
function printNextSteps(config, deps) {
  console.log('\nNext steps:')
  let n = 1
  if (deps.added.length > 0 && !deps.installRan) {
    console.log(`  ${n++}. Install new dependencies: ${deps.pm} install`)
    console.log('     (or re-run this command with --install to do it for you)')
  }
  console.log(`  ${n++}. Start the dev server: deepspace dev`)
  if (config.route && config.route.path) {
    console.log(`  ${n++}. Open ${config.route.path} once the dev server is up`)
  }
}

function copyFile(src, dest) {
  const destDir = path.dirname(dest)
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(src, dest)
}

// Copy + rewrite leading `../` imports. Used when a page file is redirected
// into a deeper route group (e.g. src/pages/(app)/ adds one directory level,
// src/pages/(app)/(protected)/ adds two) — every relative import that
// traverses upward needs `levels` extra `../`. Matches static `from '...'`,
// side-effect `import '...'`, and dynamic/type `import('...')` (e.g.
// `import('../hooks/x').T` in a type position, or `await import('../x')`).
// Same-directory (`./...`) and bare-package imports are untouched.
function copyFileWithImportShift(src, dest, levels) {
  const destDir = path.dirname(dest)
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
  const content = fs.readFileSync(src, 'utf-8')
  const prefix = '../'.repeat(levels)
  const shifted = content.replace(/(from\s+|import\s+|import\()(['"])(\.\.\/)/g, `$1$2${prefix}$3`)
  fs.writeFileSync(dest, shifted)
}

// ---------------------------------------------------------------------------
// Install files
// ---------------------------------------------------------------------------

// Page files must land under src/pages/(app)/ so the (app)/_layout.tsx route
// group wraps them in the DeepSpace providers (auth + realtime records) — the
// top level of src/pages/ is reserved for static pages that mount no
// providers. Protected pages go one level deeper, under (app)/(protected)/,
// so the nested layout also wraps them in <AuthGate>. Both are
// folder-name-only route groups — the URL path is unchanged. Only page files
// (src/pages/*) get redirected; schemas, components, etc. keep their declared
// destinations. Page files already placed in the (app) group are left as-is.
function resolveDestPath(fileDest, route) {
  const PAGES = 'src/pages/'
  const APP = 'src/pages/(app)/'
  if (!fileDest.startsWith(PAGES) || fileDest.startsWith(APP)) return fileDest
  const rest = fileDest.slice(PAGES.length)
  const isProtected = route && route.protected !== false
  return isProtected ? `${APP}(protected)/${rest}` : `${APP}${rest}`
}

function installFeature(config, targetDir) {
  let copied = 0
  let skipped = 0

  for (const file of config.files) {
    const srcPath = path.join(FEATURES_DIR, config.id, file.src)
    const resolvedDest = resolveDestPath(file.dest, config.route)
    const destPath = path.join(targetDir, resolvedDest)
    const wasRedirected = resolvedDest !== file.dest
    // Each extra path segment in the resolved dest is one directory level the
    // page dropped into (e.g. (app)/ = 1, (app)/(protected)/ = 2), which is
    // exactly how many `../` its upward relative imports must gain.
    const shiftLevels = resolvedDest.split('/').length - file.dest.split('/').length

    if (!fs.existsSync(srcPath)) {
      console.error(`   Warning: source not found: ${file.src}`)
      continue
    }

    if (fs.existsSync(destPath) && !file.overwrite) {
      console.log(`   Exists (skipped): ${resolvedDest}`)
      skipped++
    } else {
      const replacing = fs.existsSync(destPath)
      if (wasRedirected) {
        copyFileWithImportShift(srcPath, destPath, shiftLevels)
      } else {
        copyFile(srcPath, destPath)
      }
      console.log(`   ${replacing ? 'Overwrote' : 'Copied'}: ${resolvedDest}`)
      copied++
    }
  }

  return { copied, skipped }
}

// ---------------------------------------------------------------------------
// Schema auto-integration (structural parse — no comments needed)
// ---------------------------------------------------------------------------

function integrateSchema(config, targetDir) {
  if (!config.schema) return false

  const schemasPath = path.join(targetDir, 'src', 'schemas.ts')
  if (!fs.existsSync(schemasPath)) {
    printSchemaInstructions(config.schema)
    return false
  }

  let content = fs.readFileSync(schemasPath, 'utf-8')
  const { exportName, importPath, spreadOperator } = config.schema

  // Already integrated?
  const importPattern = new RegExp(`^import\\s+\\{[^}]*\\b${exportName}\\b`, 'm')
  if (importPattern.test(content)) {
    console.log(`   Schema already present: ${exportName}`)
    return false
  }

  // Strict checks: verify the file has the expected structure
  const hasExportConst = content.includes('export const schemas')
  const hasArrayOpening = /export const schemas:\s*CollectionSchema\[\]\s*=\s*\[/.test(content)

  if (!hasExportConst || !hasArrayOpening) {
    console.log('   Could not auto-integrate schema (schemas.ts has unexpected structure)')
    printSchemaInstructions(config.schema)
    return false
  }

  // 1. Add import before "export const schemas"
  const importLine = `import { ${exportName} } from '${importPath}'`
  const afterImport = content.replace(
    /export const schemas/,
    `${importLine}\n\nexport const schemas`,
  )

  if (afterImport === content) {
    console.log('   Could not insert import line')
    printSchemaInstructions(config.schema)
    return false
  }

  // 2. Insert entry into the schemas array
  const schemaEntry = spreadOperator ? `...${exportName}` : exportName
  const afterEntry = afterImport.replace(
    /export const schemas:\s*CollectionSchema\[\]\s*=\s*\[/,
    `export const schemas: CollectionSchema[] = [\n  ${schemaEntry},`,
  )

  if (afterEntry === afterImport) {
    console.log('   Could not insert schema entry')
    printSchemaInstructions(config.schema)
    return false
  }

  fs.writeFileSync(schemasPath, afterEntry)
  console.log(`   Schema integrated: ${exportName} -> schemas.ts`)
  return true
}

function printSchemaInstructions(schema) {
  const { exportName, importPath, spreadOperator } = schema
  const entry = spreadOperator ? `...${exportName}` : exportName
  console.log('')
  console.log('   Add manually to src/schemas.ts:')
  console.log(`     import { ${exportName} } from '${importPath}'`)
  console.log(`     // then add ${entry} to the schemas array`)
}

// ---------------------------------------------------------------------------
// Actions auto-integration (append to src/actions/index.ts registry)
// ---------------------------------------------------------------------------

function integrateActions(config, targetDir) {
  if (!config.actions || config.actions.length === 0) return false

  const actionsPath = path.join(targetDir, 'src', 'actions', 'index.ts')
  if (!fs.existsSync(actionsPath)) {
    printActionsInstructions(config.actions)
    return false
  }

  let content = fs.readFileSync(actionsPath, 'utf-8')

  // Strict check: must match the starter's shape so our regex patch is safe.
  // Accepts both `ActionHandler` and `ActionHandler<Env>` (typed-env templates).
  const hasRegistry =
    /export const actions:\s*Record<string,\s*ActionHandler(?:<[^>]*>)?>\s*=\s*\{/.test(content)
  if (!hasRegistry) {
    console.log('   Could not auto-integrate actions (actions/index.ts has unexpected structure)')
    printActionsInstructions(config.actions)
    return false
  }

  let integrated = 0
  for (const action of config.actions) {
    const { exportName, registerAs, importPath } = action

    // Already integrated?
    const importPattern = new RegExp(`^import\\s+\\{[^}]*\\b${exportName}\\b`, 'm')
    if (importPattern.test(content)) {
      console.log(`   Action already present: ${registerAs}`)
      continue
    }

    // 1. Add import before the registry export.
    const importLine = `import { ${exportName} } from '${importPath}'`
    const withImport = content.replace(
      /export const actions:/,
      `${importLine}\n\nexport const actions:`,
    )
    if (withImport === content) {
      console.log(`   Could not insert import for ${exportName}`)
      continue
    }

    // 2. Insert entry into the registry object. Works for both empty and
    //    populated registries because we inject right after the opening brace.
    const registryEntry = `  '${registerAs}': ${exportName},`
    const withEntry = withImport.replace(
      /export const actions:\s*Record<string,\s*ActionHandler(?:<[^>]*>)?>\s*=\s*\{/,
      (match) => `${match}\n${registryEntry}`,
    )
    if (withEntry === withImport) {
      console.log(`   Could not insert registry entry for ${registerAs}`)
      continue
    }

    content = withEntry
    integrated++
    console.log(`   Action integrated: ${registerAs} (${exportName})`)
  }

  if (integrated > 0) {
    fs.writeFileSync(actionsPath, content)
  }
  return integrated > 0
}

function printActionsInstructions(actions) {
  console.log('')
  console.log('   Add manually to src/actions/index.ts:')
  for (const a of actions) {
    console.log(`     import { ${a.exportName} } from '${a.importPath}'`)
    console.log(`     // then add '${a.registerAs}': ${a.exportName} to the actions object`)
  }
}

// ---------------------------------------------------------------------------
// CSS auto-integration (append feature CSS to styles.css)
// ---------------------------------------------------------------------------

function integrateCss(config, targetDir) {
  if (!config.css || config.css.length === 0) return false

  const stylesPath = path.join(targetDir, 'src', 'styles.css')
  if (!fs.existsSync(stylesPath)) {
    console.log('   Warning: Cannot integrate CSS — src/styles.css not found')
    return false
  }

  let stylesContent = fs.readFileSync(stylesPath, 'utf-8')
  let integrated = 0

  for (const cssFile of config.css) {
    const srcPath = path.join(FEATURES_DIR, config.id, cssFile)
    if (!fs.existsSync(srcPath)) {
      console.error(`   Warning: CSS source not found: ${cssFile}`)
      continue
    }

    const cssContent = fs.readFileSync(srcPath, 'utf-8')

    // Check if already integrated by looking for a unique class/keyframe from the CSS
    // Use the first non-comment, non-empty line with a class or keyframe as fingerprint
    const fingerprint = cssContent.match(/\.([\w-]+)\s*\{|@keyframes\s+([\w-]+)/)
    if (fingerprint) {
      const marker = fingerprint[1] || fingerprint[2]
      if (stylesContent.includes(marker)) {
        console.log(`   CSS already present: ${cssFile} (found .${marker})`)
        continue
      }
    }

    stylesContent += '\n' + cssContent
    integrated++
    console.log(`   CSS integrated: ${cssFile} -> styles.css`)
  }

  if (integrated > 0) {
    fs.writeFileSync(stylesPath, stylesContent)
  }

  return integrated > 0
}

// ---------------------------------------------------------------------------
// Nav auto-wiring into nav.ts
// ---------------------------------------------------------------------------

const NAV_MARKER = '// ── Features add nav items below this line ──'

function integrateRoute(config, targetDir) {
  if (!config.route) return false

  const navPath = path.join(targetDir, 'src', 'nav.ts')
  if (!fs.existsSync(navPath)) {
    printRouteInstructions(config.route, config)
    return false
  }

  let content = fs.readFileSync(navPath, 'utf-8')
  const { path: routePath } = config.route
  const label = config.name

  // Already wired?
  if (content.includes(`'${routePath}'`)) {
    console.log(`   Nav already present: ${routePath}`)
    return false
  }

  if (!content.includes(NAV_MARKER)) {
    console.log('   Could not auto-wire nav (marker not found in nav.ts)')
    printRouteInstructions(config.route, config)
    return false
  }

  const rolesStr = config.route.protected === false ? '' : ", roles: ['member' as Role]"
  const entry = `  { path: '${routePath}', label: '${label}'${rolesStr} },`

  content = content.replace(NAV_MARKER, `${NAV_MARKER}\n${entry}`)
  fs.writeFileSync(navPath, content)
  console.log(`   Nav wired: ${routePath} (${label})`)

  // Route is automatic via generouted — page file in src/pages/ is enough
  console.log(`   Route: automatic (file-based routing via src/pages/)`)
  return true
}

function printRouteInstructions(route, config) {
  const { path: routePath } = route
  const label = config?.name ?? routePath
  console.log('')
  console.log('   Add manually to src/nav.ts:')
  console.log(`     { path: '${routePath}', label: '${label}' },`)
}

// ---------------------------------------------------------------------------
// Dependency integration — patches package.json with declared deps
// ---------------------------------------------------------------------------

/**
 * Merge `config.dependencies` and `config.devDependencies` into the
 * target app's package.json. Existing entries win — never downgrade or
 * overwrite a user's pin. Prints a single line telling them to run
 * their package manager when at least one new entry was added.
 *
 * Why we don't shell out to `npm install` here: the scaffolded app
 * may use any of npm / pnpm / bun / yarn. Detecting the right one
 * heuristically (lockfile presence, packageManager field) is doable
 * but easy to get wrong; deferring to the user keeps the contract
 * narrow and respects whatever lockfile setup they have.
 */
function integrateDependencies(config, targetDir, options = {}) {
  const result = { added: [], installRan: false, pm: detectPackageManager(targetDir) }

  const sections = [
    { key: 'dependencies', label: 'dependencies' },
    { key: 'devDependencies', label: 'devDependencies' },
  ]

  // Skip the work if nothing is declared.
  const hasAny = sections.some((s) => config[s.key] && Object.keys(config[s.key]).length > 0)
  if (!hasAny) return result

  const pkgPath = path.join(targetDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    console.log('   Could not patch package.json (file not found)')
    return result
  }

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch (err) {
    console.log(`   Could not patch package.json (parse error: ${err.message})`)
    return result
  }

  const added = []
  const skipped = []

  for (const { key } of sections) {
    const declared = config[key]
    if (!declared) continue
    pkg[key] = pkg[key] || {}
    for (const [name, version] of Object.entries(declared)) {
      // Skip if already declared in this OR the sibling section — never let a
      // package land in both dependencies and devDependencies (e.g. when a
      // feature moves a dep between sections across versions). Don't report a
      // name we added moments ago (from the sibling section of this same
      // config) as "already present" — that would list it as both added+skipped.
      if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) {
        if (!added.includes(name)) skipped.push(name)
        continue
      }
      pkg[key][name] = version
      added.push(name)
    }
  }

  if (added.length === 0) {
    console.log('   Dependencies already present')
    return result
  }

  // Re-write with two-space indent (Node's de-facto default; matches
  // what most generators / lint tools agree on).
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  console.log(`   Added to package.json: ${added.join(', ')}`)
  if (skipped.length > 0) {
    console.log(`   Already present (kept your version): ${skipped.join(', ')}`)
  }
  result.added = added

  // Opt-in (--install): run the detected package manager for the user. By
  // default we only patch package.json and let the "Next steps" footer tell
  // them to install, so we never guess wrong about their PM/lockfile.
  if (options.runInstall) {
    console.log(`\n   Installing dependencies with ${result.pm}...`)
    // shell:true on Windows, where npm/pnpm/yarn/bun are .cmd shims that
    // spawnSync can't exec directly.
    const res = spawnSync(result.pm, ['install'], {
      cwd: targetDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (res.error) {
      const why = res.error.code === 'ENOENT' ? `${result.pm} not found on PATH` : res.error.message
      console.log(`   Could not launch ${result.pm} (${why}) — run "${result.pm} install" manually.`)
    } else if (res.status === 0) {
      result.installRan = true
    } else {
      console.log(`   ${result.pm} install did not complete — run "${result.pm} install" manually.`)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Post-install instructions (for features that need manual wiring)
// ---------------------------------------------------------------------------

function printPostInstallInstructions(config) {
  const instructions = config.instructions || []

  if (instructions.length > 0) {
    console.log('\n--- Manual wiring needed ---\n')
    instructions.forEach((inst, i) => {
      console.log(`${i + 1}. ${inst}\n`)
    })
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Pull the `--install` flag out first so it can appear anywhere; the rest of
  // main() treats args[0]/args[1] as feature + dir positionally.
  const runInstall = process.argv.slice(2).includes('--install')
  const args = process.argv.slice(2).filter((a) => a !== '--install')

  // --help
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    const features = listFeatures()
    const groups = groupByCategory(features)

    console.log('\nAdd a feature to your DeepSpace app\n')
    console.log('Usage: deepspace add <feature> [dir]\n')
    console.log('Commands:')
    console.log('  <feature> [dir]     Install a feature (dir defaults to .)')
    console.log('  --list, -l          List all available features')
    console.log('  --info <feature>    Show detailed info about a feature')
    console.log('  --install           Run your package manager after adding deps')
    console.log('  --help, -h          Show this help')

    for (const category of CATEGORY_ORDER) {
      const categoryFeatures = groups.get(category)
      if (categoryFeatures && categoryFeatures.length > 0) {
        console.log(`\n${CATEGORY_LABELS[category] || category}:`)
        for (const f of categoryFeatures) {
          console.log(`  ${f.id.padEnd(22)} ${f.name}`)
        }
      }
    }

    const example = firstFeatureId(groups) || '<feature>'
    console.log('\nExamples:')
    console.log('  deepspace add --list')
    console.log(`  deepspace add ${example}`)
    console.log(`  deepspace add ${example} ./my-app`)
    process.exit(0)
  }

  // --list
  if (args[0] === '--list' || args[0] === '-l') {
    console.log('\nAvailable Features\n')

    const features = listFeatures()
    const groups = groupByCategory(features)

    for (const category of CATEGORY_ORDER) {
      const categoryFeatures = groups.get(category)
      if (categoryFeatures && categoryFeatures.length > 0) {
        console.log(`${CATEGORY_LABELS[category] || category}:`)
        for (const f of categoryFeatures) {
          console.log(`  ${f.id.padEnd(22)} ${f.name.padEnd(24)} ${f.description}`)
        }
        console.log('')
      }
    }

    console.log('Use: deepspace add <feature>')
    process.exit(0)
  }

  // --info
  if (args[0] === '--info' || args[0] === '-i') {
    const featureId = args[1]
    if (!featureId) {
      console.error('\nError: Please specify a feature ID')
      process.exit(1)
    }
    const config = loadFeatureConfig(featureId)
    if (!config) unknownFeature(featureId)

    console.log(`\n${config.name} (${config.id})`)
    if (config.category) {
      console.log(`   Category: ${CATEGORY_LABELS[config.category] || config.category}`)
    }
    console.log(`   ${config.description}\n`)
    console.log(`   ${config.details}\n`)

    console.log('   Files:')
    config.files.forEach((f) =>
      console.log(`   - ${f.src} -> ${resolveDestPath(f.dest, config.route)}`),
    )

    if (config.instructions && config.instructions.length > 0) {
      console.log('\n   Integration steps:')
      config.instructions.forEach((inst, i) => console.log(`   ${i + 1}. ${inst}`))
    }

    if (config.patterns && config.patterns.length > 0) {
      console.log('\n   Patterns:')
      config.patterns.forEach((p) => console.log(`   - ${p}`))
    }

    if (config.example) {
      console.log('\n   Example:')
      config.example.split('\n').forEach((line) => console.log(`   ${line}`))
    }
    console.log('')
    process.exit(0)
  }

  // Install feature
  const featureId = args[0]
  const rawDir = args[1]
  const targetDir = resolveTargetDir(rawDir)

  if (!targetDir) {
    console.error('\nError: Please specify an app directory')
    console.error('Usage: deepspace add <feature> [dir]')
    process.exit(1)
  }

  const config = loadFeatureConfig(featureId)
  if (!config) unknownFeature(featureId)

  if (!fs.existsSync(targetDir)) {
    console.error(`\nError: Target directory not found: ${targetDir}`)
    process.exit(1)
  }

  console.log(`\nInstalling: ${config.name}`)
  console.log(`   ${config.description}`)
  console.log(`   Target: ${targetDir}`)

  const { copied, skipped } = installFeature(config, targetDir)

  console.log(`\nCopied ${copied} file(s)${skipped > 0 ? `, skipped ${skipped} existing` : ''}`)

  // Auto-integrate schema, actions, CSS, and route
  integrateSchema(config, targetDir)
  integrateActions(config, targetDir)
  integrateCss(config, targetDir)
  integrateRoute(config, targetDir)

  // Add any new npm dependencies the feature declares to the target's
  // package.json. Without this, copied source files import packages
  // that don't exist in node_modules and the next `vite dev` blows up
  // with a hard-to-diagnose "Failed to resolve import" error. By default we
  // only patch package.json (the "Next steps" footer tells the user to
  // install) so we never guess wrong about their package manager + lockfile;
  // `--install` opts into running it for them.
  const deps = integrateDependencies(config, targetDir, { runInstall })

  // Print any remaining manual wiring instructions
  printPostInstallInstructions(config)

  if (config.patterns && config.patterns.length > 0) {
    console.log('--- Key patterns ---\n')
    config.patterns.forEach((p) => console.log(`- ${p}`))
    console.log('')
  }

  // Warn when installing a nav feature alongside another (they're exclusive).
  warnNavConflicts(config, targetDir)

  // Always close with concrete next steps.
  printNextSteps(config, deps)
}

main()
