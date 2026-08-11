/** A write was attempted before its RecordRoom connection became ready. */
export class RecordRoomNotReadyError extends Error {
  readonly code = 'not_ready'

  constructor(collection?: string) {
    super(
      collection
        ? `RecordRoom is not ready for "${collection}" writes.`
        : 'RecordRoom is not ready for writes.',
    )
    this.name = 'RecordRoomNotReadyError'
  }
}
