/**
 * How the person is pointing, in the browser: a mouse or trackpad unless the
 * main pointer is coarse (a phone or tablet browser).
 */

/** True when the app is the iPad build running on a Mac. Never in a browser. */
export const isIOSAppOnMac = false

/**
 * The main input is a mouse or trackpad: click and drag, and a secondary-click
 * menu in place of swipes and touch-and-hold.
 */
export const isPointerPrimary: boolean =
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? true
    : !window.matchMedia('(pointer: coarse)').matches

/** @deprecated Renamed `isPointerPrimary`; this alias goes in a later minor. */
export const pointerInput: boolean = isPointerPrimary
