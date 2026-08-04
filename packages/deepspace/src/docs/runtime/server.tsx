import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { DocsRuntimeData } from '../types'
import {
  DefaultDocs,
  DocsContent,
  type DocsPageComponent,
  type DocsSiteComponent,
} from './public'
export * from './public'

export function renderDocs({
  data,
  Page,
  Site = DefaultDocs as DocsSiteComponent,
}: {
  data: DocsRuntimeData
  Page?: DocsPageComponent
  Site?: DocsSiteComponent
}): string {
  const content: ReactElement = createElement(DocsContent, { data, Page })
  return renderToString(createElement(Site, { children: content, data }))
}
