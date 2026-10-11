/** The Expo client's errors, without its native dependencies, so the web build of deepspace/native can share them. */

export class DeepSpaceExpoError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'DeepSpaceExpoError'
    this.status = status
    this.body = body
  }
}

/**
 * Thrown by `signIn` when the person closes the sign-in sheet. It isn't a
 * failure, so apps usually return to where they were without showing an error.
 * Check `code`: `instanceof` fails if the bundler includes two copies of
 * this package.
 */
export class DeepSpaceSignInCancelledError extends Error {
  readonly code = 'sign_in_cancelled' as const

  constructor() {
    super('DeepSpace sign-in was cancelled')
    this.name = 'DeepSpaceSignInCancelledError'
  }
}
