// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Two-step confirmation for destructive routes (ARCHITECTURE §6 "Confirm round-trip"):
 * the first call without `confirmToken` gets 409 + ConfirmRequiredResponse (token valid 5 min, single use, bound to
 * the exact action = method + path + body without the token); the same call with the token executes.
 *
 * Agent tokens (ARCHITECTURE §7): the token an agent gets is bound to that agent token and only becomes valid after
 * the **user approved** it (dashboard dialog, or `nucleon-sync approvals approve <id>` with the UI token). Until then
 * the repeated call answers 409 `approval pending`; a denied approval answers 403. Agent approvals live 15 min.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { ApprovalDto, ApprovalRequiredResponse, ConfirmRequiredResponse } from '@nucleon-sync/shared';

import { HttpError, notFound } from '../util/http.ts';
import type { Principal } from './agentTokens.ts';

export type ConfirmSummary = ConfirmRequiredResponse['summary'];

interface Pending {
  key: string;
  expiresAt: number;
  /** agent requests only */
  approval?: ApprovalDto;
}

export class ConfirmManager {
  private readonly pending = new Map<string, Pending>();
  private readonly ttlMs: number;
  private readonly approvalTtlMs: number;
  private readonly now: () => number;
  /** approval created/decided/expired (the API broadcasts it as SSE `approval`) */
  onApproval: ((a: ApprovalDto) => void) | null = null;

  constructor(o: { ttlMs?: number; approvalTtlMs?: number; now?: () => number } = {}) {
    this.ttlMs = o.ttlMs ?? 5 * 60_000;
    this.approvalTtlMs = o.approvalTtlMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
  }

  static actionKey(method: string, path: string, body: unknown): string {
    const rest = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {};
    delete rest.confirmToken;
    return createHash('sha256')
      .update(`${method} ${path} ${stableJson(rest)}`)
      .digest('hex');
  }

  /**
   * Returns normally when the body carries a valid token for this action (token is consumed); otherwise throws a
   * 409 HttpError whose body is the ConfirmRequiredResponse (agents: ApprovalRequiredResponse). `summary` is only
   * computed when needed.
   */
  require(method: string, path: string, body: unknown, summary: () => ConfirmSummary, who?: Principal): void {
    this.gc();
    const agent = who?.scope === 'agent' ? who : null;
    const key = ConfirmManager.actionKey(method, path, body);
    const token = body && typeof body === 'object' ? (body as { confirmToken?: unknown }).confirmToken : undefined;
    if (typeof token === 'string' && token) {
      const p = this.pending.get(token);
      if (p && p.key === key && p.expiresAt >= this.now()) {
        if (!agent && !p.approval) {
          this.pending.delete(token);
          return;
        }
        if (agent && p.approval && p.approval.tokenId === agent.tokenId) {
          if (p.approval.state === 'approved') {
            this.pending.delete(token);
            this.setState(p.approval, 'used');
            return;
          }
          if (p.approval.state === 'denied') {
            this.pending.delete(token);
            throw new HttpError(403, 'forbidden', 'the user denied this request', { approval: p.approval });
          }
          // the agent confirmed: from now on the user sees the request
          if (p.approval.state === 'requested') this.setState(p.approval, 'pending', false);
          // still pending: same token again
          const res: ApprovalRequiredResponse = {
            code: 'conflict',
            error: 'approval pending',
            confirmToken: token,
            expiresAt: new Date(p.expiresAt).toISOString(),
            summary: p.approval.summary,
            approval: p.approval,
          };
          throw new HttpError(409, 'conflict', 'approval pending', res as unknown as Record<string, unknown>);
        }
      }
      // unknown/expired/foreign token: fall through and issue a fresh one (never execute)
    }
    // hex: never starts with '-' (safe as a CLI argument: --confirm-token <token>)
    const fresh = randomBytes(18).toString('hex');
    const t = this.now();
    if (agent) {
      const expiresAt = t + this.approvalTtlMs;
      const approval: ApprovalDto = {
        id: randomBytes(3).toString('hex'),
        tokenId: agent.tokenId,
        tokenName: agent.name,
        method,
        path,
        summary: summary(),
        requestedAt: new Date(t).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        state: 'requested',
        decidedAt: null,
      };
      this.pending.set(fresh, { key, expiresAt, approval });
      const res: ApprovalRequiredResponse = {
        code: 'conflict',
        error: 'approval required',
        confirmToken: fresh,
        expiresAt: approval.expiresAt,
        summary: approval.summary,
        approval,
      };
      throw new HttpError(409, 'conflict', 'approval required', res as unknown as Record<string, unknown>);
    }
    const expiresAt = t + this.ttlMs;
    this.pending.set(fresh, { key, expiresAt });
    const res: ConfirmRequiredResponse = {
      code: 'conflict',
      error: 'confirmation required',
      confirmToken: fresh,
      expiresAt: new Date(expiresAt).toISOString(),
      summary: summary(),
    };
    throw new HttpError(409, 'conflict', 'confirmation required', res as unknown as Record<string, unknown>);
  }

  /** agent approvals the user can see (pending and recently decided), newest first */
  approvals(): ApprovalDto[] {
    return this.all().filter((a) => a.state !== 'requested');
  }

  private all(): ApprovalDto[] {
    this.gc();
    return [...this.pending.values()]
      .flatMap((p) => (p.approval ? [p.approval] : []))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  approval(id: string): ApprovalDto {
    const a = this.all().find((x) => x.id === id);
    if (!a) throw notFound(`approval ${id} not found or expired`);
    return a;
  }

  /** the user's decision (UI token only) */
  decide(id: string, approve: boolean): ApprovalDto {
    const a = this.approval(id);
    if (a.state !== 'pending') throw new HttpError(409, 'conflict', `approval ${id} is ${a.state}, not pending`);
    this.setState(a, approve ? 'approved' : 'denied');
    return a;
  }

  /** a revoked agent token: its open approvals are dropped */
  dropToken(tokenId: string): void {
    for (const [k, p] of this.pending)
      if (p.approval?.tokenId === tokenId) {
        this.pending.delete(k);
        if (p.approval.state === 'pending') this.setState(p.approval, 'expired');
      }
  }

  private setState(a: ApprovalDto, state: ApprovalDto['state'], decided = true): void {
    const wasVisible = a.state !== 'requested';
    a.state = state;
    if (decided) a.decidedAt = new Date(this.now()).toISOString();
    if (wasVisible || state === 'pending') this.onApproval?.(a);
  }

  private gc(): void {
    const t = this.now();
    for (const [k, p] of this.pending)
      if (p.expiresAt < t) {
        this.pending.delete(k);
        if (p.approval?.state === 'pending') this.setState(p.approval, 'expired');
      }
  }
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}
