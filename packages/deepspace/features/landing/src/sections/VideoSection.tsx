/**
 * Landing Section: Video Embed
 *
 * Click-to-play video section with a glassmorphic container.
 */

import { useState } from 'react'
import { Play } from 'lucide-react'
import { ScrollReveal, PlaceholderImage, SectionHeading, cn, motion } from '../primitives'

const VIDEO_URL = ''
const VIDEO_THUMBNAIL = ''
const SECTION_TITLE = 'See it in action'
const SECTION_SUBTITLE = 'Watch a quick walkthrough of how everything works.'

export default function VideoSection() {
  const [isPlaying, setIsPlaying] = useState(false)

  return (
    <section className="relative py-28 md:py-36">
      <div className="max-w-4xl mx-auto px-6">
        <SectionHeading tag="Demo" title={SECTION_TITLE} subtitle={SECTION_SUBTITLE} />

        <ScrollReveal>
          <div className="relative rounded-2xl overflow-hidden border border-foreground/[0.1] shadow-2xl landing-gradient-border">
            {isPlaying && VIDEO_URL ? (
              <div className="aspect-video">
                <iframe
                  src={VIDEO_URL}
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  title="Demo video"
                />
              </div>
            ) : (
              <button
                onClick={() => { if (VIDEO_URL) setIsPlaying(true) }}
                className="relative w-full group"
                aria-label="Play video"
              >
                {VIDEO_THUMBNAIL ? (
                  <div className="aspect-video">
                    <img src={VIDEO_THUMBNAIL} alt="Video preview" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-background/50 group-hover:bg-background/30 transition-colors duration-300" />
                  </div>
                ) : (
                  <PlaceholderImage label="Video Preview" aspectRatio="aspect-video" className="rounded-none border-0" />
                )}

                <div className="absolute inset-0 flex items-center justify-center">
                  <motion.div
                    className={cn(
                      'w-20 h-20 rounded-full flex items-center justify-center',
                      'bg-foreground/[0.1] backdrop-blur-sm border border-foreground/[0.2]',
                      'group-hover:bg-foreground/[0.2] group-hover:scale-110',
                      'transition-all duration-300',
                    )}
                    whileHover={{ scale: 1.1 }}
                  >
                    <Play className="w-8 h-8 text-foreground ml-1" />
                  </motion.div>
                </div>
              </button>
            )}
          </div>
        </ScrollReveal>
      </div>
    </section>
  )
}
