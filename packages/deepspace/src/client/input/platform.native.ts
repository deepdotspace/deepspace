/**
 * How the person is pointing, natively: the iPad build on an Apple silicon Mac
 * has a pointer and keyboard; iPhone and iPad have touch.
 */
import { requireOptionalNativeModule } from 'expo'

const keyboard = requireOptionalNativeModule<{ isIOSAppOnMac?: boolean }>('DeepSpaceKeyboard')

/** True when the app is the iPad build running on a Mac. */
export const isIOSAppOnMac: boolean = keyboard?.isIOSAppOnMac === true

/**
 * The main input is a mouse or trackpad: click and drag, and a secondary-click
 * menu in place of swipes and touch-and-hold.
 */
export const pointerInput: boolean = isIOSAppOnMac
