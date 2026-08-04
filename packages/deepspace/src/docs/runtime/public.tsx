import type { ComponentType, ReactElement, ReactNode } from 'react'
import type { DocsRuntimeData } from '../types'
import { DocsApp, type DocsAppProps } from './app'
import { docsMdxComponents } from './mdx-components'

export type DocsPageComponent = ComponentType<{ components?: Record<string, ComponentType<never>> }>

export interface DocsSiteProps extends DocsAppProps {
  /** The current compiled Markdown or MDX page. */
  children: ReactNode
}

export type DocsSiteComponent = ComponentType<DocsSiteProps>

/** The polished SDK-owned documentation shell. */
export const DefaultDocs = DocsApp

export function DocsContent({
  data,
  Page,
}: {
  data: DocsRuntimeData
  Page?: DocsPageComponent
}): ReactElement {
  if (!Page) {
    return <div className="docs-prose" dangerouslySetInnerHTML={{ __html: data.page.html }} />
  }
  return <div className="docs-prose"><Page components={docsMdxComponents as never} /></div>
}

export { DocsApp }
export type { DocsAppProps }
export {
  Accordion,
  AccordionGroup,
  Card,
  CodeGroup,
  Info,
  Note,
  Step,
  Steps,
  Tab,
  Tabs,
  Tip,
  Warning,
} from './mdx-components'
