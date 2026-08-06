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

/**
 * The prose subtree has exactly one writer, and `data-prose` names it. `react`
 * means the reconciler owns every node inside and only React components may
 * enhance it; `html` means the compiler's markup owns it and the article's
 * imperative pass may enhance it. Nothing may write across that line — moving a
 * React-owned node out from under its fiber makes the next route swap fail with
 * `removeChild ... not a child of this node`.
 */
export function DocumentationContent({
  data,
  Page,
}: {
  data: DocumentationRuntimeData
  Page?: DocumentationPageComponent
}): ReactElement {
  if (!Page) {
    return (
      <div
        className="documentation-prose"
        data-prose="html"
        dangerouslySetInnerHTML={{ __html: data.page.html }}
      />
    )
  }
  return (
    <div className="documentation-prose" data-prose="react">
      <Page components={documentationMdxComponents as never} />
    </div>
  )
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
