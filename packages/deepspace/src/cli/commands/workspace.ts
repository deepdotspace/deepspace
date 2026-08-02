/**
 * `deepspace workspace` — durable, named lines of work for parallel agents.
 *
 * Command implementations live beside this registry under `workspace/`.
 */

import { defineCommand } from 'citty'
import { newWorkspaceCommand } from './workspace/new'
import { attachWorkspaceCommand } from './workspace/attach'
import { syncWorkspaceCommand } from './workspace/sync'
import { listWorkspacesCommand } from './workspace/list'
import { workspaceStatusCommand } from './workspace/status'
import { landWorkspaceCommand } from './workspace/land'
import { dropWorkspaceCommand } from './workspace/drop'

export default defineCommand({
  meta: {
    name: 'workspace',
    description: 'Durable parallel-agent workspaces (new/attach/sync/list/status/land/drop)',
  },
  subCommands: {
    new: newWorkspaceCommand,
    attach: attachWorkspaceCommand,
    sync: syncWorkspaceCommand,
    list: listWorkspacesCommand,
    status: workspaceStatusCommand,
    land: landWorkspaceCommand,
    drop: dropWorkspaceCommand,
  },
})
