/**
 * Landing Section: Showcase
 *
 * Alternating left/right product blocks.
 */

import { ArrowRight } from 'lucide-react'
import { ScrollReveal, BrowserMockup, cn } from '../primitives'

const SHOWCASE_ITEMS = [
  {
    label: 'Overview',
    title: 'See everything at a glance',
    description: 'A clear, organized view of what matters most. Stay on top of your work without the clutter.',
    image: '',
  },
  {
    label: 'Workflow',
    title: 'Work the way you want',
    description: 'Flexible tools that adapt to your process. Set things up once and let the app handle the rest.',
    image: '',
  },
]

export default function ShowcaseSection() {
  return (
    <section className="relative py-28 md:py-36">
      <div className="max-w-6xl mx-auto px-6 space-y-24 md:space-y-32">
        {SHOWCASE_ITEMS.map((item, idx) => {
          const isReversed = idx % 2 !== 0
          return (
            <div
              key={item.title}
              className={cn(
                'flex flex-col gap-10 md:gap-16 items-center',
                isReversed ? 'md:flex-row-reverse' : 'md:flex-row',
              )}
            >
              <ScrollReveal className="flex-1 w-full" direction={isReversed ? 'right' : 'left'} delay={0.1}>
                <BrowserMockup label={item.label} src={item.image || undefined} />
              </ScrollReveal>
              <ScrollReveal className="flex-1 w-full md:max-w-md" direction={isReversed ? 'left' : 'right'} delay={0.2}>
                <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-primary/80 mb-3">
                  {item.label}
                </span>
                <h3 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground leading-tight tracking-[-0.01em]">
                  {item.title}
                </h3>
                <p className="mt-4 text-muted-foreground text-base md:text-lg leading-relaxed">
                  {item.description}
                </p>
                <button className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors group">
                  Learn more
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </button>
              </ScrollReveal>
            </div>
          )
        })}
      </div>
    </section>
  )
}
