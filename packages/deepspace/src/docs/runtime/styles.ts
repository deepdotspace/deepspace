import { DOCS_BASE_CSS } from './styles/base'
import { DOCS_CONTENT_CSS } from './styles/content'
import { DOCS_NAVIGATION_CSS } from './styles/navigation'
import { DOCS_OVERLAYS_CSS } from './styles/overlays'
import { DOCS_RESPONSIVE_CSS } from './styles/responsive'

/** One emitted stylesheet, assembled from independently customizable feature layers. */
export const DOCS_CSS =
  DOCS_BASE_CSS +
  DOCS_NAVIGATION_CSS +
  DOCS_CONTENT_CSS +
  DOCS_OVERLAYS_CSS +
  DOCS_RESPONSIVE_CSS
