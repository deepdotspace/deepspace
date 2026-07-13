/**
 * Landing Section: Testimonials
 *
 * 3-column grid of testimonial cards.
 */

import { motion } from 'framer-motion'
import { Star } from 'lucide-react'
import { StaggerContainer, staggerChild, GlassCard, SectionHeading } from '../primitives'

const TESTIMONIALS = [
  {
    quote: 'This completely changed how I work. Everything is faster and more organized now.',
    name: 'Alex Johnson',
    role: 'Product Manager',
    rating: 5,
  },
  {
    quote: 'The simplicity is what sold me. I was up and running in minutes, not hours.',
    name: 'Sarah Chen',
    role: 'Designer',
    rating: 5,
  },
  {
    quote: 'Finally an app that works the way I think. The flexibility is incredible.',
    name: 'Marcus Williams',
    role: 'Developer',
    rating: 5,
  },
]

export default function TestimonialsSection() {
  return (
    <section id="testimonials" className="relative py-28 md:py-36">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeading tag="Testimonials" title="Loved by people everywhere" />

        <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-6" staggerDelay={0.12}>
          {TESTIMONIALS.map(t => (
            <motion.div key={t.name} variants={staggerChild}>
              <GlassCard className="p-7 h-full flex flex-col" hoverEffect={false}>
                <div className="flex gap-1 mb-5">
                  {Array.from({ length: t.rating }).map((_, i) => (
                    <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
                  ))}
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed flex-1">
                  &ldquo;{t.quote}&rdquo;
                </p>
                <div className="flex items-center gap-3 mt-6 pt-5 border-t border-foreground/[0.06]">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/30 to-violet-500/30 border border-foreground/[0.1] flex items-center justify-center">
                    <span className="text-xs font-semibold text-muted-foreground">
                      {t.name.split(' ').map(n => n[0]).join('')}
                    </span>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">{t.name}</div>
                    <div className="text-xs text-muted-foreground/60">{t.role}</div>
                  </div>
                </div>
              </GlassCard>
            </motion.div>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
