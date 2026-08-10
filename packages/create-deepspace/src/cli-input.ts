import * as p from '@clack/prompts'

export interface CliInput {
  appName: string
  local?: string
  template: string
}

interface ParsedArgs {
  appName?: string
  local?: string
  template?: string
  help: boolean
  version: boolean
  interactive: boolean
  /** First bad flag (unknown option, or a value flag with no value). */
  invalid?: string
}

interface TemplateOption {
  name: string
  description: string
}

export function parseArgs(argv: string[]): ParsedArgs {
  let appName: string | undefined
  let local: string | undefined
  let template: string | undefined
  let help = false
  let version = false
  let interactive = false
  let invalid: string | undefined

  // Value flags accept both `--flag value` and `--flag=value`. A missing or
  // unknown flag must error, never silently fall through.
  let i = 2
  const flagValue = (argument: string): string | undefined => {
    const equals = argument.indexOf('=')
    if (equals !== -1) return argument.slice(equals + 1) || undefined
    const next = argv[i + 1]
    if (!next || next.startsWith('-')) return undefined
    i++
    return next
  }

  for (; i < argv.length; i++) {
    const argument = argv[i]
    if (argument === '--local' || argument.startsWith('--local=')) {
      local = flagValue(argument)
      if (!local) invalid ??= '--local requires a value'
    } else if (
      argument === '--template' ||
      argument === '-t' ||
      argument.startsWith('--template=') ||
      argument.startsWith('-t=')
    ) {
      template = flagValue(argument)
      if (!template) invalid ??= '--template requires a value'
    } else if (argument === '--help' || argument === '-h') {
      help = true
    } else if (argument === '--version' || argument === '-v') {
      version = true
    } else if (argument === '--interactive' || argument === '-i') {
      interactive = true
    } else if (!argument.startsWith('-')) {
      if (appName === undefined) appName = argument
      else {
        invalid ??= `Unexpected positional argument '${argument}' (app name is already '${appName}')`
      }
    } else {
      invalid ??= `Unknown option '${argument}'`
    }
  }

  return { appName, local, template, help, version, interactive, invalid }
}

export async function readCliInput(
  argv: string[],
  readCreatorVersion: () => string,
  loadTemplates: () => TemplateOption[],
  defaultTemplate: string,
): Promise<CliInput> {
  const args = parseArgs(argv)

  // These exits run before p.intro so agents probing the CLI get clean text,
  // no ANSI decoration, and no interactive hang.
  if (args.help) {
    printHelp(loadTemplates(), defaultTemplate)
    process.exit(0)
  }
  if (args.version) {
    console.log(readCreatorVersion())
    process.exit(0)
  }
  if (args.invalid) {
    console.error(`create-deepspace: ${args.invalid} (see --help)`)
    process.exit(1)
  }
  if (!args.appName && !args.interactive) {
    printMissingAppNameUsage()
    process.exit(1)
  }
  const runtimeRefusal = nodeRuntimeRefusal()
  if (runtimeRefusal) {
    console.error(runtimeRefusal)
    process.exit(1)
  }

  p.intro('Create a new DeepSpace app')
  const templates = loadTemplates()

  let appName = args.appName
  if (!appName) {
    const result = await p.text({
      message: 'What is your app name?',
      placeholder: 'my-app',
      validate: (value) => validateAppName(value ?? '') ?? undefined,
    })
    if (p.isCancel(result)) {
      p.cancel('Cancelled')
      process.exit(0)
    }
    appName = result as string
  } else if (appName !== '.') {
    const error = validateAppName(appName)
    if (error) {
      p.cancel(error)
      process.exit(1)
    }
  }

  let template = args.template ?? defaultTemplate
  if (args.template && !templates.some((candidate) => candidate.name === args.template)) {
    p.cancel(
      `Unknown template '${args.template}'. Available: ${templates.map((candidate) => candidate.name).join(', ')}`,
    )
    process.exit(1)
  }
  if (!args.template && args.interactive) {
    const result = await p.select({
      message: 'Which template?',
      options: templates.map((candidate) => ({
        value: candidate.name,
        label: candidate.name,
        hint: candidate.description,
      })),
    })
    if (p.isCancel(result)) {
      p.cancel('Cancelled')
      process.exit(0)
    }
    template = result as string
  }

  return { appName, local: args.local, template }
}

/** Runtime guard for npm's default non-strict handling of `engines`. */
export function nodeRuntimeRefusal(version = process.versions.node): string | null {
  const [major, minor] = version.split('.').map(Number)
  const supported = (major === 22 && minor >= 15) || major === 24 || major === 26
  return supported
    ? null
    : `create-deepspace requires Node 22.15+, 24, or 26 (current: ${version}). Update Node before scaffolding; no project files were changed.`
}

export function validateAppName(name: string): string | null {
  if (!name) return 'App name is required'
  if (name.length < 2) return 'Name must be at least 2 characters'
  if (name.length > 63) return 'Name must be 63 characters or less'
  if (!/^[a-z0-9](?:-?[a-z0-9])+$/.test(name)) {
    return 'Name must use lowercase letters, digits, and single dashes, with no leading or trailing dash'
  }
  return null
}

function printHelp(templates: TemplateOption[], defaultTemplate: string): void {
  console.log(`create-deepspace — scaffold a new DeepSpace app

USAGE
  npm create deepspace@latest <app-name>
  npx create-deepspace <app-name> [options]

ARGUMENTS
  <app-name>          Lowercase name (a–z, 0–9, single dashes; 2–63 chars).
                      Use "." to scaffold into the current directory.

OPTIONS
  -h, --help          Show this help and exit.
  -v, --version       Print the create-deepspace version and exit.
  -t, --template <name>
                      Template to scaffold from (default: ${defaultTemplate}).
  -i, --interactive   Prompt for missing values instead of erroring.
                      (Default behavior is non-interactive — designed for agents.)
      --local <path>  Use a local SDK monorepo checkout instead of the
                      published deepspace package. Requires a built
                      <path>/packages/deepspace/dist/.

TEMPLATES
${templates.map((template) => `  ${template.name.padEnd(10)}${template.description}`).join('\n')}

IN-PLACE SCAFFOLDING
  The target dir may already exist if it is "near-empty" — only these
  boilerplate entries are tolerated:
    .git, .gitignore, .gitattributes, .github/, LICENSE*, README*,
    any top-level *.md, docs/, .claude/, .vscode/, .idea/, .editorconfig,
    .vite, .wrangler, .dev.vars, .DS_Store
  On a filename collision (e.g. an existing CLAUDE.md) the existing file
  is kept and the template version is written alongside as
  <name>.deepspace<ext> (e.g. CLAUDE.deepspace.md) for hand-merging.
  .git is allowed but not required; a trailing 'git init' runs only if
  no .git exists yet. Anything else blocks scaffolding and is listed
  in the refusal message.

EXAMPLES
  # From a parent directory, create a new dir:
  npm create deepspace@latest my-app

  # Pick a template (note the \`--\` when going through npm create):
  npx create-deepspace my-app --template copilot
  npm create deepspace@latest my-app -- --template copilot

  # From inside an existing (near-empty) repo, scaffold in place:
  cd my-app && npm create deepspace@latest my-app
  cd my-app && npm create deepspace@latest .

  # SDK contributors testing unreleased changes:
  npx create-deepspace my-app --local ~/code/deepspace-sdk
`)
}

function printMissingAppNameUsage(): void {
  console.error(`error: missing required <app-name> argument

Usage:
  npm create deepspace@latest <app-name>

Examples:
  npm create deepspace@latest my-app
  npm create deepspace@latest .

Run \`npm create deepspace@latest -- --help\` for all options.`)
}
