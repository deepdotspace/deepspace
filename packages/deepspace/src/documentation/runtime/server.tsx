import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { DocumentationRuntimeData } from '../types'
import {
  DefaultDocumentation,
  DocumentationContent,
  type DocumentationPageComponent,
  type DocumentationSiteComponent,
} from './public'
export * from './public'

export function renderDocumentation({
  data,
  Page,
  Site = DefaultDocumentation as DocumentationSiteComponent,
}: {
  data: DocumentationRuntimeData
  Page?: DocumentationPageComponent
  Site?: DocumentationSiteComponent
}): string {
  const content: ReactElement = createElement(DocumentationContent, { data, Page })
  return renderToString(createElement(Site, { children: content, data }))
}
