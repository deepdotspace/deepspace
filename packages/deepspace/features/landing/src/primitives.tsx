/**
 * Landing Page Primitives
 *
 * Shared animation and UI primitives used by the landing page shell
 * and all landing section components.
 */

import { useEffect, useState, useRef, type ReactNode } from 'react'
import { motion, AnimatePresence, useInView } from 'framer-motion'
import { ImageIcon, ChevronDown } from 'lucide-react'
import { cn } from '@/components/ui'

// ============================================================================
// Smooth Typewriter
// ============================================================================

function useTypewriter(
  text: string,
  options: { baseSpeed?: number; variance?: number; startDelay?: number } = {},
) {
  const { baseSpeed = 65, variance = 0.4, startDelay = 300 } = options
  const [displayedCount, setDisplayedCount] = useState(0)
  const [isComplete, setIsComplete] = useState(false)
  const [hasStarted, setHasStarted] = useState(false)

  useEffect(() => {
    setDisplayedCount(0)
    setIsComplete(false)
    setHasStarted(false)
    const startTimer = setTimeout(() => setHasStarted(true), startDelay)
    return () => clearTimeout(startTimer)
  }, [text, startDelay])

  useEffect(() => {
    if (!hasStarted || displayedCount >= text.length) {
      if (hasStarted && displayedCount >= text.length) setIsComplete(true)
      return
    }
    const char = text[displayedCount]
    const nextChar = text[displayedCount + 1]
    let delay = baseSpeed
    if (char === ' ') delay = baseSpeed * 0.3
    else if ('.!?,;:'.includes(char)) delay = baseSpeed * 2.5
    else if (nextChar === ' ' || displayedCount === text.length - 1) delay = baseSpeed * 1.3
    const varianceFactor = 1 + (Math.random() - 0.5) * 2 * variance
    delay *= varianceFactor
    const timer = setTimeout(() => setDisplayedCount(prev => prev + 1), delay)
    return () => clearTimeout(timer)
  }, [hasStarted, displayedCount, text, baseSpeed, variance])

  return { displayedText: text.slice(0, displayedCount), isComplete }
}

export function Typewriter({
  text,
  className,
  cursorClassName,
  baseSpeed,
  variance,
  startDelay,
  onComplete,
}: {
  text: string
  className?: string
  cursorClassName?: string
  baseSpeed?: number
  variance?: number
  startDelay?: number
  onComplete?: () => void
}) {
  const { displayedText, isComplete } = useTypewriter(text, { baseSpeed, variance, startDelay })

  useEffect(() => {
    if (isComplete && onComplete) onComplete()
  }, [isComplete, onComplete])

  return (
    <span className={className} aria-label={text}>
      <span>{displayedText}</span>
      <motion.span
        className={cn(
          'inline-block w-[3px] h-[0.9em] ml-[2px] align-middle rounded-full',
          cursorClassName ?? 'bg-foreground',
        )}
        animate={{ opacity: isComplete ? [1, 0] : [1, 1] }}
        transition={
          isComplete
            ? { duration: 0.8, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }
            : { duration: 0 }
        }
      />
    </span>
  )
}

// ============================================================================
// Scroll-triggered animation primitives
// ============================================================================

export function ScrollReveal({
  children,
  className,
  delay = 0,
  direction = 'up',
}: {
  children: ReactNode
  className?: string
  delay?: number
  direction?: 'up' | 'down' | 'left' | 'right'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-80px 0px' })
  const directionMap = {
    up: { y: 40, x: 0 },
    down: { y: -40, x: 0 },
    left: { x: 40, y: 0 },
    right: { x: -40, y: 0 },
  }
  const offset = directionMap[direction]

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, x: offset.x, y: offset.y }}
      animate={isInView ? { opacity: 1, x: 0, y: 0 } : { opacity: 0, x: offset.x, y: offset.y }}
      transition={{ duration: 0.7, delay, ease: [0.25, 0.4, 0.25, 1] }}
    >
      {children}
    </motion.div>
  )
}

export function StaggerContainer({
  children,
  className,
  staggerDelay = 0.1,
}: {
  children: ReactNode
  className?: string
  staggerDelay?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-60px 0px' })

  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={isInView ? 'visible' : 'hidden'}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: staggerDelay } },
      }}
    >
      {children}
    </motion.div>
  )
}

export const staggerChild = {
  hidden: { opacity: 0, y: 30, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.5, ease: 'easeOut' as const },
  },
}

// ============================================================================
// Animated counter
// ============================================================================

function parseStatValue(value: string): { prefix: string; number: number; suffix: string } {
  const match = value.match(/^([<>]?)(\d+(?:\.\d+)?)(.*)$/)
  if (!match) return { prefix: '', number: 0, suffix: value }
  return { prefix: match[1], number: parseFloat(match[2]), suffix: match[3] }
}

function useCountUp(target: number, duration: number = 1800, shouldStart: boolean = false): number {
  const [current, setCurrent] = useState(0)
  const startTimeRef = useRef<number | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (!shouldStart) return
    startTimeRef.current = null

    function tick(timestamp: number) {
      if (startTimeRef.current === null) startTimeRef.current = timestamp
      const elapsed = timestamp - startTimeRef.current
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setCurrent(eased * target)
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, duration, shouldStart])

  return current
}

export function AnimatedStat({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-40px 0px' })
  const { prefix, number, suffix } = parseStatValue(value)
  const animated = useCountUp(number, 1800, isInView)

  const hasDecimal = number % 1 !== 0
  const displayed = hasDecimal ? animated.toFixed(1) : Math.round(animated).toString()

  return (
    <motion.div ref={ref} variants={staggerChild} className="text-center">
      <div className="text-3xl md:text-4xl font-bold text-foreground tracking-tight">
        {prefix}{displayed}{suffix}
      </div>
      <div className="text-muted-foreground/60 text-sm font-medium mt-1">{label}</div>
    </motion.div>
  )
}

// ============================================================================
// Glassmorphic Card
// ============================================================================

export function GlassCard({
  children,
  className,
  hoverEffect = true,
}: {
  children: ReactNode
  className?: string
  hoverEffect?: boolean
}) {
  return (
    <motion.div
      className={cn(
        'relative rounded-2xl overflow-hidden',
        'bg-background/70',
        'border border-foreground/[0.08]',
        'shadow-[0_8px_32px_rgba(0,0,0,0.3)]',
        hoverEffect && 'group transition-all duration-500',
        className,
      )}
      whileHover={hoverEffect ? { y: -4, transition: { duration: 0.3, ease: 'easeOut' } } : undefined}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/20 to-transparent" />
      {children}
    </motion.div>
  )
}

// ============================================================================
// Placeholder Image
// ============================================================================

export function PlaceholderImage({
  className,
  label,
  src,
  aspectRatio = 'aspect-video',
}: {
  className?: string
  label?: string
  src?: string
  aspectRatio?: string
}) {
  if (src) {
    return (
      <div className={cn('relative rounded-xl overflow-hidden', aspectRatio, className)}>
        <img src={src} alt={label ?? ''} className="absolute inset-0 w-full h-full object-cover" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative rounded-xl overflow-hidden',
        'bg-foreground/[0.03] border-2 border-dashed border-foreground/[0.12]',
        aspectRatio,
        className,
      )}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-foreground/[0.06] border border-foreground/[0.1] flex items-center justify-center">
          <ImageIcon className="w-6 h-6 text-muted-foreground/50" />
        </div>
        {label && (
          <span className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground/50">
            {label}
          </span>
        )}
      </div>
      <svg className="absolute inset-0 w-full h-full opacity-[0.04]" preserveAspectRatio="none">
        <pattern id="diag" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="20" stroke="currentColor" strokeWidth="1" />
        </pattern>
        <rect width="100%" height="100%" fill="url(#diag)" />
      </svg>
    </div>
  )
}

// ============================================================================
// Browser Mockup
// ============================================================================

export function BrowserMockup({
  className,
  label,
  src,
  glowBorder = false,
}: {
  className?: string
  label?: string
  src?: string
  glowBorder?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl overflow-hidden border border-foreground/[0.1] shadow-2xl',
        glowBorder && 'landing-gradient-border',
        className,
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3 bg-foreground/[0.04] border-b border-foreground/[0.08]">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-foreground/[0.1]" />
          <div className="w-3 h-3 rounded-full bg-foreground/[0.1]" />
          <div className="w-3 h-3 rounded-full bg-foreground/[0.1]" />
        </div>
        <div className="flex-1 mx-4">
          <div className="h-6 rounded-md bg-foreground/[0.05] border border-foreground/[0.08] max-w-xs mx-auto flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground/50 font-medium">myapp.com</span>
          </div>
        </div>
      </div>
      <PlaceholderImage src={src} label={label} aspectRatio="aspect-[16/10]" className="rounded-none border-0 border-dashed-0" />
    </div>
  )
}

// ============================================================================
// Section Heading
// ============================================================================

export function SectionHeading({
  tag,
  title,
  titleHighlight,
  subtitle,
}: {
  tag: string
  title: string
  titleHighlight?: string
  subtitle?: string
}) {
  return (
    <ScrollReveal className="text-center mb-16">
      <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-primary/80 mb-4">
        {tag}
      </span>
      <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground leading-tight tracking-[-0.02em]">
        {title}
        {titleHighlight && (
          <>
            <br />
            <span className="bg-gradient-to-r from-primary via-violet-400 to-purple-300 bg-clip-text text-transparent">
              {titleHighlight}
            </span>
          </>
        )}
      </h2>
      {subtitle && (
        <p className="mt-5 text-muted-foreground max-w-xl mx-auto text-lg leading-relaxed">
          {subtitle}
        </p>
      )}
    </ScrollReveal>
  )
}

export { cn, AnimatePresence, motion, useInView, ChevronDown }
