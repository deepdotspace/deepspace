import { useAuthProfileReady } from 'deepspace'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  Database,
  KeyRound,
  Sparkles,
  Wifi,
  Folder,
} from 'lucide-react'
import { APP_NAME } from '../../constants'
import { getActiveTheme, getTheme } from '../../themes'

const FEATURES = [
  {
    icon: Wifi,
    title: 'Real-time data',
    body:
      'Collections, presence, and CRDT-backed records sync across every connected client without you wiring sockets.',
  },
  {
    icon: Bot,
    title: 'AI assistant',
    body:
      'A streaming chat surface, tool calls, and provider-agnostic model routing — drop it in or compose your own.',
  },
  {
    icon: KeyRound,
    title: 'Auth & roles',
    body:
      'Email, OAuth, and anonymous sessions with role-aware route gates. No third-party dashboards to wrangle.',
  },
  {
    icon: Folder,
    title: 'Storage built-in',
    body:
      'File uploads, blob URLs, and durable per-room state are first-class — backed by Cloudflare under the hood.',
  },
] as const

export default function HomePage() {
  const { isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })

  const themeLabel = getTheme(getActiveTheme()).label
  const showSignedInGreeting = isSignedIn && !userLoading && !!user

  return (
    <div className="relative min-h-full overflow-hidden bg-background text-foreground">
      <BackgroundDecor />

      <div className="relative mx-auto max-w-6xl px-6 pb-24 pt-16 sm:pt-24">
        {/* Hero */}
        <section className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
            Built on the DeepSpace SDK
          </span>

          <h1 className="mt-6 text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
            {showSignedInGreeting ? (
              <>
                Welcome back,{' '}
                <span className="bg-gradient-to-br from-primary via-primary to-foreground bg-clip-text text-transparent">
                  {user?.name?.split(' ')[0] ?? 'friend'}
                </span>
              </>
            ) : (
              <>
                A starter that{' '}
                <span className="bg-gradient-to-br from-primary via-primary to-foreground bg-clip-text text-transparent">
                  ships ready
                </span>
              </>
            )}
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-pretty text-lg text-muted-foreground">
            Real-time data, auth, AI, and file storage — pre-wired into a single
            Cloudflare Workers app. Edit a file, hit save, see it live.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/settings"
              className="group inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-card transition-all hover:opacity-90 hover:shadow-card-hover"
            >
              Open settings
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="https://docs.deep.space"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-5 py-2.5 text-sm font-medium text-foreground backdrop-blur-md transition-colors hover:bg-card"
            >
              Read the docs
            </a>
          </div>
        </section>

        {/* Feature grid */}
        <section className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <article
              key={title}
              className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
              />
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/20">
                <Icon className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="text-base font-semibold tracking-tight">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {body}
              </p>
            </article>
          ))}
        </section>

        {/* Quick-start panel */}
        <section className="mt-16 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 sm:p-8">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/15 blur-3xl"
            />
            <h2 className="text-xl font-semibold tracking-tight">
              Where to look first
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              The seams a new {APP_NAME === '__APP_NAME__' ? 'app' : APP_NAME} touches most.
            </p>
            <ul className="mt-5 space-y-3 text-sm">
              <FileLine path="src/schemas.ts" hint="Define your data collections and their shape." />
              <FileLine path="src/pages/" hint="Add routes — the file tree maps to URLs." />
              <FileLine path="src/actions/" hint="Server-side mutations and tool handlers." />
              <FileLine path="src/themes.ts" hint="Available themes. Switch via data-theme in index.html." />
            </ul>
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-6 sm:p-8">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-primary ring-1 ring-inset ring-primary/30">
              <Database className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="mt-4 text-xl font-semibold tracking-tight">Resources</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Everything you need to keep building.
            </p>
            <ul className="mt-5 space-y-2 text-sm">
              <ResourceLink href="https://docs.deep.space" label="Documentation" />
              <ResourceLink href="https://deep.space" label="deep.space" />
            </ul>
          </div>
        </section>

        {/* Theme footnote */}
        <p className="mt-12 text-center text-xs text-muted-foreground">
          Currently using the{' '}
          <span className="font-medium text-foreground">{themeLabel}</span>{' '}
          theme · edit{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
            data-theme
          </code>{' '}
          in <code className="text-foreground">index.html</code> to switch.
        </p>
      </div>
    </div>
  )
}

function FileLine({ path, hint }: { path: string; hint: string }) {
  return (
    <li className="flex items-start gap-3">
      <code className="mt-0.5 shrink-0 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[12px] text-foreground">
        {path}
      </code>
      <span className="text-muted-foreground">{hint}</span>
    </li>
  )
}

function ResourceLink({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-1.5 text-foreground transition-colors hover:text-primary"
      >
        {label}
        <ArrowRight className="h-3.5 w-3.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
      </a>
    </li>
  )
}

function BackgroundDecor() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-24 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" />
      <div className="absolute bottom-0 right-1/4 h-[260px] w-[460px] rounded-full bg-primary/10 blur-[100px]" />
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)',
          backgroundSize: '32px 32px',
          color: 'var(--color-foreground)',
        }}
      />
    </div>
  )
}
