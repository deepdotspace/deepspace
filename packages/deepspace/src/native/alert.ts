/**
 * `Alert.alert`, the same call on every platform: React Native's alert here,
 * an in-page dialog in the web build (`native/web-alert.tsx`).
 */
import { Alert as NativeAlert, type AlertButton } from 'react-native'

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]): void {
    NativeAlert.alert(title, message, buttons)
  },
}
