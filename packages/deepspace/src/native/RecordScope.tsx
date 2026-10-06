/**
 * RecordScope for React Native. Identical to the browser component except that
 * the WebSocket base defaults to the bound client's origin, since a native app
 * has no `window.location` to derive it from.
 */
import type { ComponentProps, ReactElement } from 'react'
import { RecordScope as SharedRecordScope } from '../client/storage/RecordScope'
import { useNativeClient } from './provider'

export type RecordScopeProps = ComponentProps<typeof SharedRecordScope>

export function RecordScope(props: RecordScopeProps): ReactElement {
  const client = useNativeClient()
  return <SharedRecordScope {...props} wsUrl={props.wsUrl ?? client.origin} />
}
