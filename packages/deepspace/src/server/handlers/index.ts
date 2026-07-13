/**
 * Handler exports for RecordRoom
 */

// Subscription handlers
export {
  handleSubscribe,
  handleUnsubscribe,
  executeQuery,
  recordMatchesSubscription,
  broadcastChange,
  type SubscriptionContext,
} from './subscriptions'

// Record handlers
export {
  handlePut,
  handleDelete,
  getRecord,
  type RecordContext,
} from './records'

// User handlers
export {
  handleUserList,
  handleUserUpdate,
  handleSetRole,
  registerUser,
  getUser,
  getAllUsers,
  type UserContext,
} from './users'

// Yjs handlers
export {
  handleYjsJoin,
  handleYjsLeave,
  handleYjsBinaryMessage,
  getYjsDocKey,
  getOrCreateYjsDoc,
  saveYjsDoc,
  broadcastYjsUpdate,
  SYSTEM_COLLECTION_SCHEMAS,
  type YjsContext,
} from './yjs'

// Debug API handlers
export {
  handleApiRequest,
  type DebugApiContext,
} from './debug-api'

// Tools API handlers
export {
  handleToolsRequest,
  type ToolsApiContext,
} from './tools-api'

// Shared record operations (used by WebSocket handlers and Tools API)
export {
  putRecord,
  deleteRecord,
  readRecord,
} from './records'
