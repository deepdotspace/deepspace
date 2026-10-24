// This template serves the live board at /. There are no static landing pages.
export { seo } from './seo'
export const PRERENDER_ROUTES: string[] = []
export function render(): string {
  throw new Error('No static pages in public-board')
}
