/**
 * Landing Section: How It Works
 *
 * Numbered 3-step horizontal flow.
 */

import { motion } from 'framer-motion'
import { StaggerContainer, staggerChild, SectionHeading } from '../primitives'

const STEPS = [
  {
    number: '01',
    title: 'Sign Up',
    description: 'Create your account in seconds. No credit card required, no complicated setup.',
  },
  {
    number: '02',
    title: 'Set Up',
    description: 'Configure your workspace and invite your team. Everything is guided step by step.',
  },
  {
    number: '03',
    title: 'Go',
    description: 'Start using the app right away. Everything you need is ready from day one.',
  },
]

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="relative py-28 md:py-36">
      <div className="max-w-5xl mx-auto px-6">
        <SectionHeading
          tag="How It Works"
          title="Up and running in minutes"
          subtitle="Three simple steps to get started."
        />

        <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-6 relative" staggerDelay={0.15}>
          <div className="hidden md:block absolute top-[36px] left-[16.67%] right-[16.67%] h-px">
            <div className="w-full h-full bg-gradient-to-r from-primary/40 via-violet-400/40 to-primary/40" />
          </div>

          {STEPS.map(step => (
            <motion.div key={step.number} variants={staggerChild}>
              <div className="relative text-center">
                <div className="relative z-10 w-[72px] h-[72px] mx-auto mb-6 rounded-2xl bg-background/80 border border-foreground/[0.1] flex items-center justify-center shadow-lg">
                  <span className="text-2xl font-bold bg-gradient-to-br from-primary to-violet-400 bg-clip-text text-transparent">
                    {step.number}
                  </span>
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-3">{step.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed max-w-[280px] mx-auto">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
