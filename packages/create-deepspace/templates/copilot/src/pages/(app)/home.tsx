/**
 * Placeholder home — replace this with the app's real home.
 *
 * The shell around this page (sidebar, chat dock, the main panel) is the
 * app's layout and stays; this file is the empty canvas inside it. Design
 * the app's own look (content, theme tokens, typography) from your
 * product's point of view instead of extending this placeholder.
 */

export default function HomePage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Your app goes here</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Replace <code>src/pages/(app)/home.tsx</code> with the app&apos;s real home.
        The sidebar, AI chat dock, and this panel are already wired.
      </p>
    </div>
  )
}
