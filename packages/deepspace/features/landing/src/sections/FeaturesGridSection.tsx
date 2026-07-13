/**
 * Landing Section: Features Grid
 *
 * Bento-style 2-column grid with 4 feature cards.
 */

import { type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Zap, Shield, BarChart3, Sparkles, Check } from 'lucide-react'
import {
  StaggerContainer,
  staggerChild,
  GlassCard,
  PlaceholderImage,
  SectionHeading,
  cn,
} from '../primitives'

// ============================================================================
// Configuration
// ============================================================================

const FEATURES: Array<{
  icon: typeof Zap
  title: string
  description: string
  gradient: string
  iconColor: string
  borderGlow: string
  image: string
  Visual: (() => ReactNode) | null
}> = [
  {
    icon: Zap,
    title: 'Lightning Fast',
    description: 'Real-time sync and instant updates across all devices.',
    gradient: 'from-amber-500/20 to-orange-500/20',
    iconColor: 'text-amber-400',
    borderGlow: 'group-hover:shadow-[0_0_30px_rgba(245,158,11,0.15)]',
    image: '',
    Visual: null,
  },
  {
    icon: Shield,
    title: 'Secure by Default',
    description: 'Enterprise-grade security with role-based access and encryption.',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    iconColor: 'text-emerald-400',
    borderGlow: 'group-hover:shadow-[0_0_30px_rgba(16,185,129,0.15)]',
    image: '',
    Visual: ShieldVisual,
  },
  {
    icon: BarChart3,
    title: 'Powerful Analytics',
    description: 'Built-in dashboards and real-time insights for better decisions.',
    gradient: 'from-blue-500/20 to-cyan-500/20',
    iconColor: 'text-blue-400',
    borderGlow: 'group-hover:shadow-[0_0_30px_rgba(59,130,246,0.15)]',
    image: '',
    Visual: BarChartVisual,
  },
  {
    icon: Sparkles,
    title: 'AI-Powered',
    description: 'Smart automation that learns from your workflow.',
    gradient: 'from-violet-500/20 to-purple-500/20',
    iconColor: 'text-violet-400',
    borderGlow: 'group-hover:shadow-[0_0_30px_rgba(139,92,246,0.15)]',
    image: '',
    Visual: null,
  },
]

// ============================================================================
// Decorative Visuals
// ============================================================================

function ShieldVisual() {
  const checkItems = ['Encryption', 'RBAC', 'Audit Log']
  return (
    <div className="relative h-24 w-full overflow-hidden rounded-lg bg-foreground/[0.02]">
      <div className="flex flex-col gap-2 px-4 py-3">
        {checkItems.map((item, i) => (
          <motion.div
            key={item}
            className="flex items-center gap-2.5"
            initial={{ opacity: 0, x: -12 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15 + i * 0.12, duration: 0.4 }}
          >
            <div className="w-5 h-5 rounded-md bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Check className="w-3 h-3 text-emerald-400" />
            </div>
            <span className="text-xs text-muted-foreground/60 font-medium">{item}</span>
            <div className="flex-1 h-px bg-foreground/[0.04]" />
            <span className="text-[10px] text-emerald-400/60 font-medium">Active</span>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function BarChartVisual() {
  const bars = [
    { h: 35, label: 'Mon' },
    { h: 58, label: 'Tue' },
    { h: 42, label: 'Wed' },
    { h: 78, label: 'Thu' },
    { h: 65, label: 'Fri' },
    { h: 88, label: 'Sat' },
    { h: 52, label: 'Sun' },
  ]
  return (
    <div className="relative h-24 w-full overflow-hidden rounded-lg bg-foreground/[0.02]">
      <div className="absolute inset-0 flex items-end justify-center gap-2 px-4 pb-5 pt-2">
        {bars.map((bar, i) => (
          <div key={bar.label} className="flex flex-col items-center gap-1.5 flex-1">
            <motion.div
              className="w-full max-w-[24px] rounded-t-sm bg-gradient-to-t from-blue-500/50 to-cyan-400/30"
              initial={{ height: 0 }}
              whileInView={{ height: `${bar.h}%` }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06, duration: 0.5, ease: 'easeOut' }}
            />
            <span className="text-[8px] text-muted-foreground/60 font-medium">{bar.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// Feature Card
// ============================================================================

function BentoFeatureCard({
  feature,
  size = 'normal',
}: {
  feature: (typeof FEATURES)[number]
  size?: 'large' | 'normal'
}) {
  const isLarge = size === 'large'

  return (
    <motion.div variants={staggerChild} className={isLarge ? 'md:col-span-2' : ''}>
      <GlassCard className={cn('h-full overflow-hidden', feature.borderGlow)}>
        <div
          className={cn(
            'absolute inset-0 opacity-[0.15] group-hover:opacity-100 transition-opacity duration-700',
            'bg-gradient-to-br',
            feature.gradient,
          )}
        />
        <div className={cn('relative z-10 flex flex-col', isLarge ? 'p-8 md:p-10' : 'p-7')}>
          <div className="flex items-start gap-5">
            <div
              className={cn(
                'shrink-0 rounded-xl flex items-center justify-center',
                'bg-foreground/[0.06] border border-foreground/[0.08]',
                'group-hover:scale-110 transition-transform duration-500',
                isLarge ? 'w-14 h-14' : 'w-11 h-11',
              )}
            >
              <feature.icon className={cn(feature.iconColor, isLarge ? 'w-7 h-7' : 'w-5 h-5')} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className={cn('text-foreground font-semibold mb-2', isLarge ? 'text-xl' : 'text-base')}>
                {feature.title}
              </h3>
              <p className={cn('text-muted-foreground leading-relaxed', isLarge ? 'text-base' : 'text-sm')}>
                {feature.description}
              </p>
            </div>
          </div>
          {feature.Visual ? (
            <div className={cn(isLarge ? 'mt-8' : 'mt-5')}>
              <feature.Visual />
            </div>
          ) : isLarge ? (
            <div className="mt-8">
              <PlaceholderImage label="Add Image" src={feature.image || undefined} aspectRatio="aspect-[16/10]" />
            </div>
          ) : null}
        </div>
      </GlassCard>
    </motion.div>
  )
}

// ============================================================================
// Section
// ============================================================================

export default function FeaturesGridSection() {
  return (
    <section id="features" className="relative py-28 md:py-36">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeading
          tag="Features"
          title="Everything you need"
          titleHighlight="all in one place"
          subtitle="Powerful features designed to streamline your workflow."
        />

        <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-5" staggerDelay={0.08}>
          <BentoFeatureCard feature={FEATURES[0]} size="large" />
          <BentoFeatureCard feature={FEATURES[1]} />
          <BentoFeatureCard feature={FEATURES[2]} />
          <BentoFeatureCard feature={FEATURES[3]} size="large" />
        </StaggerContainer>
      </div>
    </section>
  )
}
