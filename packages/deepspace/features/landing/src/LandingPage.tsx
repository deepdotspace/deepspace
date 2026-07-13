/**
 * Landing Page Shell
 *
 * Composable landing page with an optional fixed background and scrolling
 * glassmorphic content overlay. The shell renders Hero, CTA, and Footer.
 * Additional sections are imported and placed in the JSX stack.
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence, useScroll, useTransform } from 'framer-motion'
import {
  ArrowRight, Menu, X, ChevronDown, Play,
  Github, Twitter, Linkedin, Mail, Sparkles, ChevronRight, Plus, Minus,
} from 'lucide-react'
import { useUser } from 'deepspace'
import { Button, cn } from '@/components/ui'
import {
  Typewriter,
  ScrollReveal,
  GlassCard,
  BrowserMockup,
} from '../components/landing/primitives'

// ============================================================================
// CSS injection
// ============================================================================

const LANDING_CSS = `@layer base {
  .fixed-bg-layer {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
  }
  .scrollable-content-layer {
    position: relative;
    z-index: 1;
    height: 100dvh;
    height: 100vh;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
  }
  @supports (height: 100dvh) {
    .scrollable-content-layer { height: 100dvh; }
  }
}
@keyframes gradient-shimmer {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@keyframes border-rotate {
  0% { --border-angle: 0deg; }
  100% { --border-angle: 360deg; }
}
@layer base {
  .landing-shimmer-text {
    background-size: 200% 200%;
    animation: gradient-shimmer 6s ease-in-out infinite;
  }
  .landing-gradient-border { position: relative; }
  .landing-gradient-border::before {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    padding: 1px;
    background: conic-gradient(
      from var(--border-angle, 0deg),
      transparent 25%,
      rgba(139, 92, 246, 0.5) 50%,
      transparent 75%
    );
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    animation: border-rotate 4s linear infinite;
  }
  .landing-noise-overlay {
    position: fixed;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    opacity: 0.035;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-repeat: repeat;
    background-size: 128px 128px;
  }
}
@property --border-angle {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}`

let landingCssInjected = false

function useLandingCSS() {
  useEffect(() => {
    if (landingCssInjected) return
    landingCssInjected = true
    const style = document.createElement('style')
    style.textContent = LANDING_CSS
    document.head.appendChild(style)
    return () => {
      document.head.removeChild(style)
      landingCssInjected = false
    }
  }, [])
}

// ============================================================================
// Landing page "seen" flag
// ============================================================================

const LANDING_SEEN_KEY = 'app-landing-seen'

export function hasSeenLanding(): boolean {
  try { return localStorage.getItem(LANDING_SEEN_KEY) === 'true' } catch { return false }
}

export function markLandingSeen(): void {
  try { localStorage.setItem(LANDING_SEEN_KEY, 'true') } catch { /* storage unavailable (private mode/quota): non-critical */ }
}

// ============================================================================
// Configuration
// ============================================================================

const LANDING_BG_URL = ''
const APP_NAME = 'My App'
const HERO_HEADLINE = 'Welcome to My App'
const HERO_SUBHEADLINE = 'A simple, powerful way to get things done. Explore what\'s possible and start building today.'
const HERO_IMAGE = ''

const NAV_SECTIONS = [
  { id: 'features', label: 'Features' },
  { id: 'faq', label: 'FAQ' },
] as const

const NAV_LINKS = NAV_SECTIONS.map(s => ({ label: s.label, href: `#${s.id}` }))

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

const FAQ_ITEMS = [
  { question: 'How do I get started?', answer: 'Just launch the app and follow the guided setup. You\'ll be up and running in under a minute -- no complicated configuration needed.' },
  { question: 'Is it free to use?', answer: 'Yes, the core features are completely free. Premium features are available for teams and power users who need more.' },
  { question: 'Can I customize it?', answer: 'Absolutely. The app is designed to be flexible -- adjust settings, layouts, and workflows to match exactly how you like to work.' },
  { question: 'How does collaboration work?', answer: 'Invite your team and work together in real time. Everyone sees changes instantly, and permissions keep things organized.' },
  { question: 'Where can I get help?', answer: 'Check out the built-in help section, browse the documentation, or reach out to the community. Support is always available.' },
]

const FOOTER_LINKS = {
  Product: ['Features', 'Pricing', 'Changelog', 'Documentation'],
  Company: ['About', 'Blog', 'Careers'],
  Resources: ['Community', 'Help Center', 'API Reference'],
  Legal: ['Privacy', 'Terms'],
}

// ============================================================================
// Navbar
// ============================================================================

function useActiveSection(
  sectionIds: readonly string[],
  scrollRoot: React.RefObject<HTMLElement | null>,
): string | null {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    const root = scrollRoot.current
    if (!root) return

    const calculate = () => {
      const rootRect = root.getBoundingClientRect()
      const triggerY = rootRect.top + rootRect.height * 0.3

      const entries = sectionIds
        .map(id => ({ id, el: document.getElementById(id) }))
        .filter((e): e is { id: string; el: HTMLElement } => e.el !== null)
        .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top)

      let current: string | null = null
      for (const { id, el } of entries) {
        if (el.getBoundingClientRect().top <= triggerY) {
          current = id
        }
      }
      setActive(current)
    }

    calculate()
    root.addEventListener('scroll', calculate, { passive: true })
    return () => root.removeEventListener('scroll', calculate)
  }, [sectionIds, scrollRoot])

  return active
}

function LandingNav({ isScrolled, scrollRoot }: {
  isScrolled: boolean
  scrollRoot: React.RefObject<HTMLElement | null>
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigate = useNavigate()
  const sectionIds = NAV_SECTIONS.map(s => s.id)
  const activeSection = useActiveSection(sectionIds, scrollRoot)

  const scrollTo = (href: string) => {
    setMobileOpen(false)
    const target = document.querySelector(href) as HTMLElement | null
    const container = scrollRoot.current
    if (target && container) {
      const targetTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTo({ top: targetTop, behavior: 'smooth' })
    }
  }

  const mobileDropdown = (
    <AnimatePresence>
      {mobileOpen && (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ duration: 0.2, ease: [0.25, 0.4, 0.25, 1] }}
          className={cn(
            'md:hidden mt-2 rounded-2xl overflow-hidden',
            'bg-foreground/[0.06] backdrop-blur-2xl',
            'border border-foreground/[0.1]',
            'shadow-[0_8px_32px_rgba(0,0,0,0.4)]',
          )}
        >
          <div className="p-2 flex flex-col gap-0.5">
            {NAV_LINKS.map(link => {
              const isActive = activeSection === link.href.replace('#', '')
              return (
                <button
                  key={link.href}
                  onClick={() => scrollTo(link.href)}
                  className={cn(
                    'px-4 py-2.5 rounded-xl text-sm font-medium text-left transition-colors',
                    isActive
                      ? 'text-foreground bg-foreground/[0.1]'
                      : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]',
                  )}
                >
                  {link.label}
                </button>
              )
            })}
            <div className="h-px bg-foreground/[0.08] my-1" />
            <button
              onClick={() => { markLandingSeen(); navigate('/home') }}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-left text-primary hover:bg-foreground/[0.08] transition-colors"
            >
              Get Started
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  return (
    <>
      <motion.div
        className="absolute top-0 left-0 right-0 z-50"
        initial={{ opacity: 0 }}
        animate={{ opacity: isScrolled ? 0 : 1 }}
        transition={{ duration: 0.3 }}
        style={{ pointerEvents: isScrolled ? 'none' : 'auto' }}
      >
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <span className="font-semibold text-lg tracking-tight text-foreground">{APP_NAME}</span>
          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-8">
              {NAV_LINKS.map(link => {
                const isActive = activeSection === link.href.replace('#', '')
                return (
                  <button key={link.href} onClick={() => scrollTo(link.href)} className={cn('text-sm font-medium transition-colors duration-200', isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    {link.label}
                  </button>
                )
              })}
            </div>
            <Button size="sm" onClick={() => { markLandingSeen(); navigate('/home') }} className="hidden md:inline-flex">
              Get Started
            </Button>
            <button className="md:hidden transition-colors text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(prev => !prev)} aria-label="Toggle menu">
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-6">{mobileDropdown}</div>
      </motion.div>

      <AnimatePresence>
        {isScrolled && (
          <motion.nav
            className="fixed top-4 inset-x-0 z-50 flex justify-center pointer-events-none"
            initial={{ y: -80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -80, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.25, 0.4, 0.25, 1] }}
          >
            <div className={cn('pointer-events-auto flex items-center gap-1 px-2 py-1.5 rounded-full', 'bg-background/80 backdrop-blur-2xl', 'border border-foreground/[0.1]', 'shadow-[0_8px_32px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)]')}>
              <span className="text-foreground font-semibold text-sm px-3 whitespace-nowrap">{APP_NAME}</span>
              <div className="w-px h-4 bg-foreground/10 mx-1 hidden md:block" />
              <div className="hidden md:flex items-center gap-0.5">
                {NAV_LINKS.map(link => {
                  const isActive = activeSection === link.href.replace('#', '')
                  return (
                    <button key={link.href} onClick={() => scrollTo(link.href)} className={cn('relative px-3.5 py-1.5 rounded-full text-sm font-medium transition-all duration-200', isActive ? 'text-foreground bg-foreground/[0.12]' : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]')}>
                      {link.label}
                    </button>
                  )
                })}
              </div>
              <button className="md:hidden p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] transition-colors" onClick={() => setMobileOpen(prev => !prev)} aria-label="Toggle menu">
                {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              </button>
            </div>
            <div className="pointer-events-auto">{mobileDropdown}</div>
          </motion.nav>
        )}
      </AnimatePresence>
    </>
  )
}

// ============================================================================
// Hero
// ============================================================================

function HeroSection() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [typewriterDone, setTypewriterDone] = useState(false)
  const headline = user?.name ? `Welcome, ${user.name}` : HERO_HEADLINE

  const heroRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] })
  const mockupY = useTransform(scrollYProgress, [0, 1], [0, 80])

  return (
    <section ref={heroRef} className="relative">
      <div className="min-h-screen flex flex-col items-center justify-center px-6">
        <div className="relative z-10 max-w-4xl mx-auto text-center">
          <motion.div initial={{ opacity: 0, y: 20, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6, delay: 0.1, ease: [0.25, 0.4, 0.25, 1] }} className="mb-8">
            <span className={cn('inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase', 'bg-foreground/[0.06] backdrop-blur-sm border border-foreground/[0.1]', 'text-muted-foreground')}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Now Available
            </span>
          </motion.div>

          <h1 className={cn('text-4xl sm:text-5xl md:text-7xl font-bold leading-[1.08] tracking-[-0.02em]', typewriterDone ? 'bg-gradient-to-r from-foreground via-foreground/80 via-50% to-foreground bg-clip-text text-transparent landing-shimmer-text' : 'text-foreground')}>
            <Typewriter text={headline} cursorClassName="bg-foreground" baseSpeed={70} variance={0.35} startDelay={400} onComplete={() => setTypewriterDone(true)} />
          </h1>

          <motion.p initial={{ opacity: 0, y: 20 }} animate={typewriterDone ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }} transition={{ duration: 0.8, ease: [0.25, 0.4, 0.25, 1] }} className="mt-6 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed text-muted-foreground">
            {HERO_SUBHEADLINE}
          </motion.p>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={typewriterDone ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }} transition={{ duration: 0.7, delay: 0.15, ease: [0.25, 0.4, 0.25, 1] }} className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" onClick={() => { markLandingSeen(); navigate('/home') }} className="min-w-[180px] group">
              Get Started
              <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
            </Button>
            <button
              onClick={() => {
                const target = document.getElementById('features')
                const container = document.querySelector('.scrollable-content-layer') as HTMLElement | null
                if (target && container) {
                  const targetTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
                  container.scrollTo({ top: targetTop, behavior: 'smooth' })
                }
              }}
              className={cn('inline-flex items-center gap-2 min-w-[180px] justify-center', 'px-6 py-3 rounded-md text-sm font-medium', 'border border-foreground/20 text-foreground bg-foreground/[0.06] hover:bg-foreground/[0.12]', 'transition-all duration-200')}
            >
              <Play className="w-4 h-4" />
              Learn More
            </button>
          </motion.div>
        </div>

        <motion.div initial={{ opacity: 0 }} animate={typewriterDone ? { opacity: 1 } : { opacity: 0 }} transition={{ delay: 1.2, duration: 0.8 }} className="absolute bottom-8 left-1/2 -translate-x-1/2">
          <motion.div animate={{ y: [0, 8, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}>
            <ChevronDown className="w-5 h-5 text-muted-foreground/50" />
          </motion.div>
        </motion.div>
      </div>

      <motion.div initial={{ opacity: 0, y: 60 }} animate={typewriterDone ? { opacity: 1, y: 0 } : { opacity: 0, y: 60 }} transition={{ duration: 1, delay: 0.3, ease: [0.25, 0.4, 0.25, 1] }} style={{ y: mockupY }} className="relative z-10 w-full max-w-4xl mx-auto px-6 pb-32">
        <BrowserMockup label="App Screenshot" src={HERO_IMAGE || undefined} glowBorder />
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-3/4 h-24 bg-primary/20 blur-3xl rounded-full" />
      </motion.div>
    </section>
  )
}

// ============================================================================
// Showcase
// ============================================================================

function ShowcaseSection() {
  return (
    <section id="features" className="relative py-28 md:py-36">
      <div className="max-w-6xl mx-auto px-6 space-y-24 md:space-y-32">
        {SHOWCASE_ITEMS.map((item, idx) => {
          const isReversed = idx % 2 !== 0
          return (
            <div key={item.title} className={cn('flex flex-col gap-10 md:gap-16 items-center', isReversed ? 'md:flex-row-reverse' : 'md:flex-row')}>
              <ScrollReveal className="flex-1 w-full" direction={isReversed ? 'right' : 'left'} delay={0.1}>
                <BrowserMockup label={item.label} src={item.image || undefined} />
              </ScrollReveal>
              <ScrollReveal className="flex-1 w-full md:max-w-md" direction={isReversed ? 'left' : 'right'} delay={0.2}>
                <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-primary/80 mb-3">{item.label}</span>
                <h3 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground leading-tight tracking-[-0.01em]">{item.title}</h3>
                <p className="mt-4 text-muted-foreground text-base md:text-lg leading-relaxed">{item.description}</p>
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

// ============================================================================
// FAQ
// ============================================================================

function FAQItem({ item, isOpen, onToggle }: { item: typeof FAQ_ITEMS[number]; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-foreground/[0.06] last:border-b-0">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-4 py-5 text-left group">
        <span className={cn('text-base font-medium transition-colors duration-200', isOpen ? 'text-foreground' : 'text-foreground/70 group-hover:text-foreground')}>{item.question}</span>
        <div className={cn('shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-300', isOpen ? 'bg-primary/20 text-primary rotate-0' : 'bg-foreground/[0.06] text-muted-foreground group-hover:bg-foreground/[0.1]')}>
          {isOpen ? <Minus className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        </div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.25, 0.4, 0.25, 1] }} className="overflow-hidden">
            <p className="pb-5 text-sm text-muted-foreground leading-relaxed max-w-2xl">{item.answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const handleToggle = useCallback((index: number) => { setOpenIndex(prev => prev === index ? null : index) }, [])

  return (
    <section id="faq" className="relative py-28 md:py-36">
      <div className="max-w-3xl mx-auto px-6">
        <ScrollReveal className="text-center mb-16">
          <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-primary/80 mb-4">FAQ</span>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground leading-tight tracking-[-0.02em]">Common questions</h2>
          <p className="mt-5 text-muted-foreground max-w-lg mx-auto text-lg leading-relaxed">Everything you need to know to get started.</p>
        </ScrollReveal>

        <ScrollReveal>
          <GlassCard className="px-7 md:px-10 py-2" hoverEffect={false}>
            {FAQ_ITEMS.map((item, idx) => (
              <FAQItem key={item.question} item={item} isOpen={openIndex === idx} onToggle={() => handleToggle(idx)} />
            ))}
          </GlassCard>
        </ScrollReveal>
      </div>
    </section>
  )
}

// ============================================================================
// CTA
// ============================================================================

function CTASection() {
  const navigate = useNavigate()
  return (
    <section className="relative py-28 md:py-36">
      <div className="max-w-3xl mx-auto px-6">
        <ScrollReveal>
          <GlassCard className="p-10 md:p-16 text-center" hoverEffect={false}>
            <div className="relative z-10">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground leading-tight tracking-[-0.02em]">Ready to get started?</h2>
              <p className="mt-5 text-muted-foreground text-lg max-w-md mx-auto leading-relaxed">Jump in and start exploring. No setup required.</p>
              <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
                <Button size="lg" onClick={() => { markLandingSeen(); navigate('/home') }} className="min-w-[200px] group">
                  Launch App
                  <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
                </Button>
              </div>
            </div>
          </GlassCard>
        </ScrollReveal>
      </div>
    </section>
  )
}

// ============================================================================
// Footer
// ============================================================================

function Footer() {
  return (
    <footer className="relative border-t border-foreground/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-10 md:gap-8">
          <div className="col-span-2">
            <span className="text-lg font-semibold text-foreground tracking-tight">{APP_NAME}</span>
            <p className="mt-3 text-sm text-muted-foreground/60 leading-relaxed max-w-xs">{HERO_SUBHEADLINE}</p>
            <div className="flex items-center gap-3 mt-6">
              {[
                { icon: Twitter, label: 'Twitter' },
                { icon: Github, label: 'GitHub' },
                { icon: Linkedin, label: 'LinkedIn' },
                { icon: Mail, label: 'Email' },
              ].map(social => (
                <a key={social.label} href="#" aria-label={social.label} className={cn('w-9 h-9 rounded-lg flex items-center justify-center', 'bg-foreground/[0.04] border border-foreground/[0.08]', 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-foreground/[0.08]', 'transition-all duration-200')}>
                  <social.icon className="w-4 h-4" />
                </a>
              ))}
            </div>
          </div>

          {Object.entries(FOOTER_LINKS).map(([heading, links]) => (
            <div key={heading}>
              <h4 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground/60 mb-4">{heading}</h4>
              <ul className="space-y-2.5">
                {links.map(link => (
                  <li key={link}><a href="#" className="text-sm text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-200">{link}</a></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-foreground/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground/50">&copy; {new Date().getFullYear()} {APP_NAME}. All rights reserved.</span>
          <div className="flex items-center gap-6">
            <a href="#" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">Privacy Policy</a>
            <a href="#" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">Terms of Service</a>
          </div>
        </div>
      </div>

      <div className="border-t border-foreground/[0.04]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-center">
          <a href="https://deep.space" target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-center gap-2 px-3 py-1.5 rounded-full', 'bg-foreground/[0.03] border border-foreground/[0.06]', 'text-[11px] text-muted-foreground/50 hover:text-muted-foreground hover:bg-foreground/[0.06]', 'transition-all duration-200')}>
            <Sparkles className="w-3 h-3" />
            Built with DeepSpace
            <ChevronRight className="w-3 h-3" />
          </a>
        </div>
      </div>
    </footer>
  )
}

// ============================================================================
// Page Shell
// ============================================================================

export default function LandingPage() {
  useLandingCSS()

  const containerRef = useRef<HTMLDivElement>(null)
  const [isScrolled, setIsScrolled] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handleScroll = () => setIsScrolled(el.scrollTop > 50)
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <div className="relative h-screen overflow-hidden bg-background">
      {LANDING_BG_URL && (
        <div className="fixed-bg-layer">
          <div className="absolute inset-0 bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url(${LANDING_BG_URL})` }} />
          <div className="absolute inset-0 bg-background/70" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-transparent to-background/90" />
        </div>
      )}

      <div className="landing-noise-overlay" />

      <div ref={containerRef} className="scrollable-content-layer">
        <LandingNav isScrolled={isScrolled} scrollRoot={containerRef} />
        <HeroSection />
        <ShowcaseSection />
        <FAQSection />
        <CTASection />
        <Footer />
      </div>
    </div>
  )
}
