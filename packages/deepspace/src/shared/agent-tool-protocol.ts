/** Wire-size limits shared by the app Worker and the stateless CLI bridge. */

/** Maximum JSON body accepted by one tool invocation. */
export const AGENT_TOOL_REQUEST_BODY_CAP = 64 * 1024

/** Maximum JSON response accepted or emitted by the discovery bridge. */
export const AGENT_TOOL_RESPONSE_BODY_CAP = 1024 * 1024
