// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Browser-safe runtime values from @nucleon-sync/shared. The package index also exports the Node API client
 * (node:http), which cannot be bundled for the sandboxed renderer, so values are imported from the source file.
 * Types keep coming from '@nucleon-sync/shared' (type-only imports are erased).
 */
export { DEFAULT_SETTINGS, HARD_EXCLUDED_LOCAL_PATHS, defaultGlobalExcludes } from '../../../shared/src/defaults.ts';
export { AGENT_PERMISSIONS } from '../../../shared/src/ext-agent.ts';
export { TWO_WAY_DEFAULTS } from '../../../shared/src/ext-twoway.ts';
export { DAEMON_MESSAGES_EN, msg, nested, refOf, renderWith } from '../../../shared/src/messages.ts';
