/**
 * Landing Section: FAQ
 *
 * Accordion FAQ inside a glassmorphic card.
 */

import { useState, useCallback } from 'react'
import { Plus, Minus } from 'lucide-react'
import { ScrollReveal, GlassCard, SectionHeading, cn, motion, AnimatePresence } from '../primitives'

const FAQ_ITEMS = [
  {
    question: 'How do I get started?',
    answer: 'Just launch the app and follow the guided setup. You\'ll be up and running in under a minute -- no complicated configuration needed.',
  },
  {
    question: 'Is it free to use?',
    answer: 'Yes, the core features are completely free. Premium features are available for teams and power users who need more.',
  },
  {
    question: 'Can I customize it?',
    answer: 'Absolutely. The app is designed to be flexible -- adjust settings, layouts, and workflows to match exactly how you like to work.',
  },
  {
    question: 'How does collaboration work?',
    answer: 'Invite your team and work together in real time. Everyone sees changes instantly, and permissions keep things organized.',
  },
  {
    question: 'Where can I get help?',
    answer: 'Check out the built-in help section, browse the documentation, or reach out to the community. Support is always available.',
  },
]

function FAQItem({ item, isOpen, onToggle }: {
  item: typeof FAQ_ITEMS[number]
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <div className="border-b border-foreground/[0.06] last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-4 py-5 text-left group"
      >
        <span className={cn(
          'text-base font-medium transition-colors duration-200',
          isOpen ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
        )}>
          {item.question}
        </span>
        <div className={cn(
          'shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-300',
          isOpen
            ? 'bg-primary/20 text-primary rotate-0'
            : 'bg-foreground/[0.06] text-muted-foreground group-hover:bg-foreground/[0.1]',
        )}>
          {isOpen ? <Minus className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        </div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.25, 0.4, 0.25, 1] }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm text-muted-foreground leading-relaxed max-w-2xl">
              {item.answer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const handleToggle = useCallback((index: number) => {
    setOpenIndex(prev => prev === index ? null : index)
  }, [])

  return (
    <section id="faq" className="relative py-28 md:py-36">
      <div className="max-w-3xl mx-auto px-6">
        <SectionHeading
          tag="FAQ"
          title="Common questions"
          subtitle="Everything you need to know to get started."
        />

        <ScrollReveal>
          <GlassCard className="px-7 md:px-10 py-2" hoverEffect={false}>
            {FAQ_ITEMS.map((item, idx) => (
              <FAQItem
                key={item.question}
                item={item}
                isOpen={openIndex === idx}
                onToggle={() => handleToggle(idx)}
              />
            ))}
          </GlassCard>
        </ScrollReveal>
      </div>
    </section>
  )
}
