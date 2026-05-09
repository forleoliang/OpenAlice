/**
 * Ordered registry of all migrations.
 *
 * Order is determined by array position — keep entries in numeric ID
 * order. Never reorder a migration that has already shipped; the
 * journal records ids, so reordering would cause runners to try to
 * apply already-applied work in a different order.
 *
 * Adding a migration: import it here and append. The
 * `pnpm build:migration-index` script regenerates
 * `src/migrations/INDEX.md` from this list at build time.
 */

import type { Migration } from './types.js'
import { migration as migration_0001_initial_unified } from './0001_initial_unified/index.js'
import { migration as migration_0002_extract_credentials } from './0002_extract_credentials/index.js'

export const REGISTRY: Migration[] = [
  migration_0001_initial_unified,
  migration_0002_extract_credentials,
]
