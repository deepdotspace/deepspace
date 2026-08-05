import { DOCUMENTATION_BASE_CSS } from './styles/base'
import { DOCUMENTATION_CONTENT_CSS } from './styles/content'
import { DOCUMENTATION_NAVIGATION_CSS } from './styles/navigation'
import { DOCUMENTATION_OVERLAYS_CSS } from './styles/overlays'
import { DOCUMENTATION_RESPONSIVE_CSS } from './styles/responsive'

/** One emitted stylesheet, assembled from independently customizable feature layers. */
export const DOCUMENTATION_CSS =
  DOCUMENTATION_BASE_CSS +
  DOCUMENTATION_NAVIGATION_CSS +
  DOCUMENTATION_CONTENT_CSS +
  DOCUMENTATION_OVERLAYS_CSS +
  DOCUMENTATION_RESPONSIVE_CSS
