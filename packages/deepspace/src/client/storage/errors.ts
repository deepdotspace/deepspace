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

/**
 * The room left a confirmed write unanswered on several fresh connections
 * (RecordSocket's MAX_UNANSWERED_SENDS). Waiting offline never causes this;
 * the server not answering the write itself does.
 */
export class WriteUnconfirmedError extends Error {
  readonly code = 'unconfirmed'

  constructor() {
    super('The server did not confirm this change, so it may not have been saved.')
    this.name = 'WriteUnconfirmedError'
  }
}
