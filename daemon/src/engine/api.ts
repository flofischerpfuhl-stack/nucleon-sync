// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Contract between the API server and the engine. Optional methods are not implemented yet:
 * the server answers 501 for them, so routes light up automatically as implements methods.
 *
 */
import type { EventEmitter } from 'node:events';

import type {
  AccountDto,
  ActivityItem,
  AdoptionProposalDto,
  ConflictDto,
  ConflictResolution,
  DecideDeletionsRequest,
  JobDto,
  Msg,
  PairDto,
  PauseRequest,
  PendingDeletionDto,
  RunDto,
  SelectionRule,
  StatusDto,
  SyncRequest,
  TreeNodeDto,
} from '@nucleon-sync/shared';

export interface ActivityFilter {
  accountId?: string;
  pairId?: number;
  actions?: ActivityItem['action'][];
  since?: string;
  q?: string;
}

/** Engine emits 'event' with a DaemonEvent payload. */
export interface EngineApi extends EventEmitter {
  // implemented in the skeleton
  status(): StatusDto;
  accounts(): AccountDto[];
  pairs(): PairDto[];
  activity(limit?: number, beforeId?: number, filter?: ActivityFilter): ActivityItem[];
  requestSync(req: SyncRequest, trigger: RunDto['trigger']): number;
  /** every run covering the request (started or queued) */
  requestSyncTicket?(
    req: SyncRequest,
    trigger: RunDto['trigger'],
  ): { runIds: number[]; followUp: boolean; queuedBehind: number[] };
  pause(req: PauseRequest): void;
  resume(req: PauseRequest): void;
  shutdown(): Promise<void>;

  //
  runs?(limit: number): RunDto[];
  runById?(id: number): RunDto | null;
  jobs?(filter: { state?: JobDto['state']; limit?: number }): JobDto[];
  tree?(pairId: number, relPath: string): Promise<TreeNodeDto[]>;
  setRules?(pairId: number, rules: SelectionRule[]): void;
  conflicts?(): ConflictDto[];
  resolveConflict?(id: number, resolution: ConflictResolution, by: string): void;
  deletions?(): PendingDeletionDto[];
  decideDeletions?(req: DecideDeletionsRequest, by: string): { jobIds: number[] };
  adoptions?(): AdoptionProposalDto[];
  decideAdoptions?(ids: number[], accept: boolean, by: string): void;
  startDigestBackfill?(pairId: number, relPrefix?: string, limit?: number): number;
  emptyTrash?(accountId: string, by: string): Promise<void>;
  /** user confirmed a safety brake ("really deleted") -> next run of the pair proceeds once */
  releaseBrake?(pairId: number, by: string): void;
  /** why a sync of this scope would not run right now (pair disabled/paused, account paused/needs login, ...) */
  syncBlocker?(req: SyncRequest): string | null;
  syncBlockerMsg?(req: SyncRequest): Msg | null;
  /** current write guard reason (writes blocked), or null */
  writeGuard?(): string | null;
  writeGuardMsg?(): Msg | null;
  /** two-way mass-delete guard: approve (carry out) or deny (restore) every held deletion of the pair */
  decideHeld?(pairId: number, approve: boolean, by: string): { decided: number; jobIds: number[] };

  // called by when accounts/pairs/settings change (pool resize, rescheduling)
  reload?(): Promise<void>;
}
