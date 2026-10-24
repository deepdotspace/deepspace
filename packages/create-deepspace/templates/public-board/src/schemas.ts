import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { ideasSchema } from './schemas/ideas-schema'
export const schemas: CollectionSchema[] = [usersSchema, settingsSchema, ideasSchema]
