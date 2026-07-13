/**
 * Landing Section: Logo Cloud
 *
 * Responsive grid of partner/integration logos.
 */

import { ScrollReveal, SectionHeading, cn } from '../primitives'

interface Logo {
  name: string
  imageUrl?: string
}

const LOGOS: Logo[] = [
  { name: 'Acme Corp' },
  { name: 'Globex' },
  { name: 'Initech' },
  { name: 'Umbrella' },
  { name: 'Stark Ind.' },
  { name: 'Wayne Ent.' },
]

export default function LogoCloudSection() {
  return (
    <section className="relative py-20 md:py-28">
      <div className="max-w-5xl mx-auto px-6">
        <SectionHeading tag="Trusted By" title="Used by teams you know" />

        <ScrollReveal>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-6">
            {LOGOS.map(logo => (
              <div
                key={logo.name}
                className={cn(
                  'flex items-center justify-center h-20 rounded-xl',
                  'bg-foreground/[0.03] border border-foreground/[0.06]',
                  'opacity-50 hover:opacity-100 transition-opacity duration-300',
                )}
              >
                {logo.imageUrl ? (
                  <img
                    src={logo.imageUrl}
                    alt={logo.name}
                    className="max-h-10 max-w-[80%] object-contain brightness-0 invert opacity-60"
                  />
                ) : (
                  <span className="text-sm font-medium text-muted-foreground tracking-wide">
                    {logo.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  )
}
