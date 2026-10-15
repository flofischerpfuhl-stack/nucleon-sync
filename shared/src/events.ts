// SPDX-License-Identifier: GPL-3.0-or-later
import type { AccountStatus, ActivityItem, JobDto, Notice, RunDto, StatusDto } from './api.ts';
import type { ApprovalDto } from './ext-agent.ts';
import type { MsgRef } from './messages.ts';

/**
 * Server-Sent Events on GET /v1/events. Each SSE message: `event: <type>\ndata: <json>\n\n`.
 * Clients must tolerate unknown event types (forward compatibility).
 */
export type DaemonEvent =
  | { type: 'hello'; status: StatusDto }
  | { type: 'heartbeat'; ts: string }
  | { type: 'status'; status: StatusDto } // coalesced, at most 1/s
  | { type: 'activity'; item: ActivityItem }
  | { type: 'job'; job: JobDto } // state transitions + progress (throttled)
  | { type: 'run'; run: RunDto }
  | { type: 'account'; accountId: string; status: AccountStatus; message?: string; msg?: MsgRef | null }
  | {
      type: 'login';
      accountId: string;
      phase: 'url' | 'done' | 'failed';
      signInUrl?: string;
      message?: string;
      msg?: MsgRef | null;
    }
  | { type: 'conflicts_changed'; open: number }
  | { type: 'deletions_changed'; pending: number }
  /** storage measurement of one account started/finished (fix-ui-round1; additive) */
  | { type: 'storage'; accountId: string; phase: 'start' | 'done' | 'failed'; message?: string }
  /** emitted by the engine; delivered as desktop notification by the UI and by the notifier (Telegram bot, notify command) */
  | { type: 'notice'; notice: Notice }
  /** an agent asked for a destructive action, or an approval was decided/expired (agent layer; additive) */
  | { type: 'approval'; approval: ApprovalDto };

export type DaemonEventType = DaemonEvent['type'];
