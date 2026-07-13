/**
 * Landing Section: Stats Band
 *
 * Full-width gradient band with animated counter stats.
 */

import { StaggerContainer, AnimatedStat } from '../primitives'

const STATS = [
  { value: '99.9%', label: 'Uptime' },
  { value: '10x', label: 'Faster' },
  { value: '50K+', label: 'Users' },
  { value: '<50ms', label: 'Response Time' },
]

export default function StatsSection() {
  return (
    <section className="relative py-20 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-r from-primary/[0.08] via-violet-500/[0.06] to-primary/[0.08]" />
      <div className="absolute inset-0 border-y border-foreground/[0.06]" />

      <div className="relative max-w-5xl mx-auto px-6">
        <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-4" staggerDelay={0.08}>
          {STATS.map(stat => (
            <AnimatedStat key={stat.label} value={stat.value} label={stat.label} />
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
