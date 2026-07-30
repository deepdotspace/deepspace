import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'

export const actions: Record<string, ActionHandler<Env>> = {}
