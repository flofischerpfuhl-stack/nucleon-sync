// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Additive shared types of the agent layer : scoped agent tokens, user approvals for
 * destructive agent requests, `whoami`. Kept in its own file so parallel branches never edit the same lines.
 * Design: docs/ARCHITECTURE.md §7.
 */

/**
 * What an agent token may do. `read` is implied for every token (status, lists, activity, events).
 * - `sync`        sync now, pause/resume, measure storage, read-only Proton CLI passthrough
 * - `manage`      add accounts/pairs, change pairs/rules/settings, resolve conflicts, accept adoptions, start a login
 * - `destructive` remove pairs/accounts, log out, trash files in Proton, empty the trash, release a safety brake,
 *                 run a digest backfill. **Every destructive request of an agent waits for the user's approval** in
 *                 the dashboard (or `nucleon-sync approvals approve <id>` with the UI token), even with this scope.
 */
export type AgentPermission = 'read' | 'sync' | 'manage' | 'destructive';
export const AGENT_PERMISSIONS: readonly AgentPermission[] = ['read', 'sync', 'manage', 'destructive'];

/** Minimum permission of an API route; `ui` = only the UI token (token management, approvals). */
export type RoutePermission = AgentPermission | 'ui';

/** GET /v1/tokens (ui): one agent token. The secret is only returned once, by POST /v1/tokens. */
export interface AgentTokenInfoDto {
  /** `default` = the legacy token file `agent-token` (read + sync), otherwise 8 hex chars */
  id: string;
  name: string;
  scopes: AgentPermission[];
  createdAt: string;
  lastUsedAt: string | null;
  /** the legacy `agent-token` file: can be rotated and disabled, not deleted */
  builtin: boolean;
  disabled: boolean;
  /** where the token is stored for local agents (0600), null when it was only shown once */
  file: string | null;
  /** first characters of the secret, for recognising it ("nst_Ab3x…") */
  prefix: string;
}

/** POST /v1/tokens (ui) */
export interface CreateAgentTokenRequest {
  /** 1–40 chars: letters, digits, space, . _ - (e.g. "claude", "codex laptop") */
  name: string;
  /** `read` is added automatically */
  scopes: AgentPermission[];
  /** store the secret in <config>/agent-tokens/<id>.token (0600) so `nucleon-sync --agent <name>` finds it; default true */
  writeFile?: boolean;
}
export interface CreateAgentTokenResponse extends AgentTokenInfoDto {
  /** the secret; shown once */
  token: string;
}

/** PATCH /v1/tokens/:id (ui) */
export interface PatchAgentTokenRequest {
  name?: string;
  scopes?: AgentPermission[];
  disabled?: boolean;
}

/**
 * requested = the agent got the confirm token but has not confirmed yet (not shown to the user);
 * pending = the agent repeated the request with the token → waits for the user; approved/denied = the user decided;
 * used = executed; expired = nobody decided within 15 min.
 */
/**
 * Summary of a destructive action (ConfirmRequiredResponse.summary, additive fields): English `title`/`details` for
 * CLI and agents, plus a stable `kind` and `params` so the dashboard can show it in the user's language.
 */
export interface ConfirmSummaryDto {
  title: string;
  items: number;
  bytes: number;
  details: string[];
  /** e.g. 'pair.remove', 'account.logout', 'deletions.trashRemote' (see ui/src/renderer/logic/confirmText.ts) */
  kind?: string;
  params?: Record<string, string | number>;
}

export type ApprovalState = 'requested' | 'pending' | 'approved' | 'denied' | 'expired' | 'used';

/** A destructive request of an agent waiting for (or decided by) the user. GET /v1/approvals (ui). */
export interface ApprovalDto {
  /** public id (shown in the dashboard and by `nucleon-sync approvals`) */
  id: string;
  tokenId: string;
  tokenName: string;
  method: string;
  path: string;
  summary: ConfirmSummaryDto;
  requestedAt: string;
  expiresAt: string;
  state: ApprovalState;
  decidedAt: string | null;
}

/**
 * 409 body for an agent's destructive request: like ConfirmRequiredResponse, plus the approval. Step 1: the request
 * without token answers `approval required` (state `requested`, invisible to the user). Step 2: the agent confirms by
 * repeating the identical request with `confirmToken` → `approval pending`; the dashboard now asks the user. Step 3:
 * after the user approved, the same request with the token executes (once). Denied → 403.
 */
export interface ApprovalRequiredResponse {
  code: 'conflict';
  error: 'approval required' | 'approval pending';
  confirmToken: string;
  expiresAt: string;
  summary: ConfirmSummaryDto;
  approval: ApprovalDto;
}

/** GET /v1/whoami: who the presented token is and what it may do. */
export interface WhoAmIDto {
  scope: 'ui' | 'agent';
  tokenId: string | null;
  name: string;
  permissions: AgentPermission[];
  /** permissions whose requests additionally need the user's approval (agents: ['destructive']) */
  approvalRequired: AgentPermission[];
}
