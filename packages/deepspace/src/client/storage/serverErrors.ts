/**
 * Server Error Parser
 * 
 * Parses server-side error strings into user-friendly messages.
 * Covers RBAC permission errors, validation errors, and generic errors.
 */

export interface ServerErrorInfo {
  title: string
  detail: string
  /** True for RBAC/permission errors (shown as toasts). False for validation/other (shown in error overlay). */
  isPermissionError: boolean
}

/**
 * Humanize a collection slug (e.g. "rbac-notes" → "Notes", "team-posts" → "Team Posts").
 */
function humanizeCollection(slug: string): string {
  return slug
    .replace(/^rbac-/, '')
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Humanize a role name for display (e.g. "viewer" → "Viewer").
 */
function humanizeRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/**
 * Parse a server error string into a user-friendly message.
 * Handles RBAC errors, validation errors, and falls back to a generic error.
 */
export function parseServerError(error: string): ServerErrorInfo {
  // ── RBAC Errors ──────────────────────────────────────────────────────

  // UPDATE DENIED: role=viewer, collection=tasks
  const updateMatch = error.match(/^UPDATE DENIED: role=(\w+), collection=(.+)/)
  if (updateMatch) {
    return {
      title: `${humanizeRole(updateMatch[1])}s can't edit ${humanizeCollection(updateMatch[2])}`,
      detail: '',
      isPermissionError: true,
    }
  }

  const createMatch = error.match(/^CREATE DENIED: role=(\w+), collection=(.+)/)
  if (createMatch) {
    return {
      title: `${humanizeRole(createMatch[1])}s can't create ${humanizeCollection(createMatch[2])}`,
      detail: '',
      isPermissionError: true,
    }
  }

  const deleteMatch = error.match(/^DELETE DENIED: role=(\w+), collection=(.+)/)
  if (deleteMatch) {
    return {
      title: `${humanizeRole(deleteMatch[1])}s can't delete ${humanizeCollection(deleteMatch[2])}`,
      detail: '',
      isPermissionError: true,
    }
  }

  const readMatch = error.match(/^READ DENIED: role=(\w+), collection=(.+)/)
  if (readMatch) {
    return {
      title: `${humanizeRole(readMatch[1])}s can't view ${humanizeCollection(readMatch[2])}`,
      detail: '',
      isPermissionError: true,
    }
  }

  const fieldMatch = error.match(/^FIELD ERROR: Cannot update field '(\w+)'.*role '(\w+)'/)
  if (fieldMatch) {
    return {
      title: `${humanizeRole(fieldMatch[2])}s can't edit "${fieldMatch[1]}"`,
      detail: '',
      isPermissionError: true,
    }
  }

  const fieldGenericMatch = error.match(/^FIELD ERROR: (.+)/)
  if (fieldGenericMatch) {
    return {
      title: 'Field not editable',
      detail: '',
      isPermissionError: true,
    }
  }

  const permMatch = error.match(/^Permission denied: (.+)/)
  if (permMatch) {
    return {
      title: permMatch[1].charAt(0).toUpperCase() + permMatch[1].slice(1),
      detail: '',
      isPermissionError: true,
    }
  }

  // ── Validation Errors ────────────────────────────────────────────────

  // Missing required field: fieldName
  const requiredMatch = error.match(/^Missing required field: (.+)/)
  if (requiredMatch) {
    return {
      title: 'Missing field',
      detail: `"${requiredMatch[1]}" is required`,
      isPermissionError: false,
    }
  }

  // Cannot change immutable field: fieldName
  const immutableMatch = error.match(/^Cannot change immutable field: (.+)/)
  if (immutableMatch) {
    return {
      title: 'Cannot modify',
      detail: `"${immutableMatch[1]}" cannot be changed after creation`,
      isPermissionError: false,
    }
  }

  // Field 'x' must be your user ID
  const userBoundMatch = error.match(/^Field '(.+)' must be your user ID/)
  if (userBoundMatch) {
    return {
      title: 'Invalid value',
      detail: `"${userBoundMatch[1]}" must be your own user ID`,
      isPermissionError: false,
    }
  }

  // ── Fallback ─────────────────────────────────────────────────────────

  return {
    title: 'Error',
    detail: error,
    isPermissionError: false,
  }
}
