import type { ComponentType, ReactElement, ReactNode } from 'react'
import type { DocumentationRuntimeData } from '../types'
import { DocumentationApp, type DocumentationAppProps } from './app'
import { documentationMdxComponents } from './mdx-components'

export type DocumentationPageComponent = ComponentType<{ components?: Record<string, ComponentType<never>> }>

export interface DocumentationSiteProps extends DocumentationAppProps {
  /** The current compiled Markdown or MDX page. */
  children: ReactNode
}

export type DocumentationSiteComponent = ComponentType<DocumentationSiteProps>

/** The polished SDK-owned documentation shell. */
export const DefaultDocumentation = DocumentationApp

export function DocumentationContent({
  data,
  Page,
}: {
  data: DocumentationRuntimeData
  Page?: DocumentationPageComponent
}): ReactElement {
  if (!Page) {
    return <div className="documentation-prose" dangerouslySetInnerHTML={{ __html: data.page.html }} />
  }
  return <div className="documentation-prose"><Page components={documentationMdxComponents as never} /></div>
}

export { DocumentationApp }
export type { DocumentationAppProps }
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
