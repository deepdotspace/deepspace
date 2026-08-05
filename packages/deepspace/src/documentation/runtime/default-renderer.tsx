import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { DocumentationRuntimeData } from '../types'
import { DocumentationApp } from './app'

export function renderDefaultDocumentation(data: DocumentationRuntimeData): string {
  return renderToString(createElement(DocumentationApp, { data }))
}
