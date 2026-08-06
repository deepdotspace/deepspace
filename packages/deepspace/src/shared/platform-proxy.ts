/**
 * The platform endpoints this SDK's client hooks call through an app's proxy.
 *
 * The app's worker forwards these with its own identity, so the proxy is an
 * allow-list rather than a passthrough. That list has to match what the hooks
 * actually call — and only this package knows that, which is why it is stated
 * here instead of copied into each scaffold. A frozen copy in a customer's
 * repo would 404 the next hook we ship, in their browser, silently.
 *
 * The scaffold still registers the proxy itself, visibly and editably; it just
 * reads the routes from here.
 */

export interface ProxyRoute {
  method: string
  path: string
}

export const BROWSER_PROXY_ROUTES: ReadonlyArray<ProxyRoute> = [
  // useSubscription — read state, subscribe, manage billing.
  { method: 'GET', path: '/_deepspace/subscriptions/me' },
  { method: 'POST', path: '/_deepspace/subscriptions/checkout' },
  { method: 'POST', path: '/_deepspace/subscriptions/portal' },
  // useCheckout (one-time charges).
  { method: 'POST', path: '/_deepspace/charges/create' },
  { method: 'GET', path: '/_deepspace/charges/me' },
]
