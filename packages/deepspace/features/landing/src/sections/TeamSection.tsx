/**
 * Landing Section: Team / About
 *
 * Responsive grid of team member cards.
 */

import { motion } from 'framer-motion'
import { Twitter, Github, Linkedin } from 'lucide-react'
import { StaggerContainer, staggerChild, GlassCard, SectionHeading, cn } from '../primitives'

interface TeamMember {
  name: string
  role: string
  socials?: {
    twitter?: string
    github?: string
    linkedin?: string
  }
}

const TEAM_MEMBERS: TeamMember[] = [
  { name: 'Alex Rivera', role: 'Founder & CEO', socials: { twitter: '#', linkedin: '#' } },
  { name: 'Jordan Lee', role: 'Head of Engineering', socials: { github: '#', linkedin: '#' } },
  { name: 'Sam Patel', role: 'Lead Designer', socials: { twitter: '#' } },
  { name: 'Morgan Chen', role: 'Product Manager', socials: { linkedin: '#' } },
]

const SOCIAL_ICONS = { twitter: Twitter, github: Github, linkedin: Linkedin } as const

export default function TeamSection() {
  return (
    <section id="team" className="relative py-28 md:py-36">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeading
          tag="Team"
          title="Meet the people behind the product"
          subtitle="A small team with big ambitions, building something we believe in."
        />

        <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6" staggerDelay={0.08}>
          {TEAM_MEMBERS.map(member => (
            <motion.div key={member.name} variants={staggerChild}>
              <GlassCard className="p-6 text-center" hoverEffect>
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-primary/30 to-violet-500/30 border border-foreground/[0.1] flex items-center justify-center">
                  <span className="text-lg font-semibold text-muted-foreground">
                    {member.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-foreground">{member.name}</h3>
                <p className="text-sm text-muted-foreground mt-1">{member.role}</p>

                {member.socials && Object.keys(member.socials).length > 0 && (
                  <div className="flex items-center justify-center gap-2 mt-4">
                    {(Object.entries(member.socials) as Array<[keyof typeof SOCIAL_ICONS, string]>).map(
                      ([platform, url]) => {
                        const Icon = SOCIAL_ICONS[platform]
                        if (!url) return null
                        return (
                          <a
                            key={platform}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              'w-8 h-8 rounded-lg flex items-center justify-center',
                              'bg-foreground/[0.04] border border-foreground/[0.08]',
                              'text-muted-foreground/60 hover:text-muted-foreground hover:bg-foreground/[0.08]',
                              'transition-all duration-200',
                            )}
                            aria-label={platform}
                          >
                            <Icon className="w-3.5 h-3.5" />
                          </a>
                        )
                      },
                    )}
                  </div>
                )}
              </GlassCard>
            </motion.div>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
