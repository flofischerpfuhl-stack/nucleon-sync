// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared types of accounts, settings, storage and maintenance (additive).
 * Put NEW shared types here instead of editing api.ts/events.ts, so parallel packages never edit the same file.
 */
import type { PairDirection } from './api.ts';

/** API token scopes: `ui` = full access (api-token), `agent` = read + sync/pause/resume (agent-token). */
export type TokenScope = 'ui' | 'agent';

/** POST /v1/accounts */
export interface CreateAccountRequest {
  /** slug [a-z0-9][a-z0-9_-]{0,31} */
  id: string;
  displayName: string;
  /** CLI workers for this account (default 1 for new accounts; global cap applies) */
  workers?: number;
  /** where the session is stored (default: daemon.json secretBackend, else the Secret Service via the shim) */
  credentialBackend?: 'keyring-shim' | 'encfile';
}

/** PATCH /v1/accounts/:id */
export interface PatchAccountRequest {
  displayName?: string;
  workers?: number;
  enabled?: boolean;
}

/** Per-pair behaviour options (PairRow.options JSON), docs/SYNC-RULES.md rows 6/10 and §11 questions 3/4. */
export interface PairOptionsDto {
  remoteChanges?: 'download' | 'conflict';
  remoteDeletions?: 'reupload' | 'ask';
  /** mirror-down pairs: upload files that are new on the PC ("Neue Dateien vom PC hochladen"); never overwrites/deletes remotely */
  uploadLocalNew?: boolean;
  /** read-only, set by the daemon when uploadLocalNew is switched on: only files created locally after it are uploaded */
  uploadLocalNewSince?: number;
}

/** PATCH /v1/pairs/:id — roots are immutable (create a new pair instead). Direction changes need a confirm round-trip. */
export interface PatchPairRequest {
  name?: string;
  direction?: PairDirection;
  enabled?: boolean;
  paused?: boolean;
  options?: PairOptionsDto;
}

/** POST /v1/accounts/:id/cli — passthrough (read-only allowlist unless allowWrite with the ui token). */
export interface CliPassthroughRequest {
  args: string[];
  allowWrite?: boolean;
}
export interface CliPassthroughResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** GET /v1/tokens/agent (ui scope): where agents find their token; POST /v1/tokens/agent/rotate returns the new one. */
export interface AgentTokenDto {
  file: string;
  token: string;
}

/** GET /v1/notifications?limit= — notifier log (notify command), newest first. */
export interface NotificationLogItem {
  id: number;
  ts: string;
  channel: 'command' | 'desktop';
  key: string;
  message: string;
  ok: boolean | null;
  detail: string | null;
}

/** GET /v1/notifications/config — what is configured outside the settings (daemon.json). */
export interface NotificationConfigDto {
  /** daemon.json `notifyCommand` (argv, run without a shell on every notification) */
  command: { configured: boolean; program: string | null };
}

/** POST /v1/notifications/test (UI token only) */
export interface NotificationTestResult {
  channel: 'command';
  ok: boolean;
  detail: string;
}
