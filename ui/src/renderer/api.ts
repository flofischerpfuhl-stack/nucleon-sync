// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Typed API wrappers on top of the preload bridge (ARCHITECTURE §6). Errors become `ApiError` with the HTTP status
 * and parsed body; a 409 with `confirmToken` carries the `ConfirmRequiredResponse` for the confirm round-trip.
 * Fixture modes (dev/fixtures.ts): 'fallback' answers endpoints that return 501/404, 'demo' answers everything.
 */
import type {
  AccountDto,
  AgentPermission,
  AgentTokenInfoDto,
  ApprovalDto,
  CliPassthroughResponse,
  CreateAgentTokenResponse,
  NotificationConfigDto,
  NotificationLogItem,
  NotificationTestResult,
  PatchAccountRequest,
  PatchAgentTokenRequest,
  WhoAmIDto,
  ActivityItemWithRun,
  AdoptionProposalDto,
  ConflictDto,
  ConflictResolution,
  CreatePairRequest,
  DecideDeletionsRequest,
  DecideHeldDeletionsRequest,
  DecideHeldDeletionsResponse,
  DoctorCheck,
  JobDto,
  LoginStartResponse,
  MaintenanceSummaryDto,
  PairDto,
  PairPreviewDto,
  PendingDeletionDto,
  RemoteBrowseEntry,
  RunDto,
  SelectionRule,
  SettingsDto,
  StatusDto,
  StorageHistoryPoint,
  StoragePoolDto,
  SyncRequest,
  SyncResponse,
  TimedPauseRequest,
  TreeNodeDto,
} from '@nucleon-sync/shared';

import type { UiState } from '../common/ipc.ts';
import { fixtures } from './dev/fixtures.ts';
import { ApiError, toApiError } from './errors.ts';

export { ApiError, toApiError };

let mode: UiState['fixtures'] = 'off';
let modeKnown = false;
let markModeKnown: () => void = () => undefined;
/** resolves once main told the renderer the fixture mode (first screens mount before initStore finished) */
const modeReady = new Promise<void>((resolve) => {
  markModeKnown = resolve;
  setTimeout(resolve, 3000); // never block requests forever
});
export function setFixtureMode(m: UiState['fixtures']): void {
  mode = m;
  if (m !== 'off') fixtures.install(m);
  modeKnown = true;
  markModeKnown();
}
export const fixtureMode = () => mode;

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // without this, a screen that fetches on mount in demo mode would ask the real daemon (and keep the error)
  if (!modeKnown) await modeReady;
  if (mode === 'demo') return fixtures.handle<T>(method, path, body);
  try {
    return await window.nucleonSync.request<T>(method, path, body);
  } catch (e) {
    const err = toApiError(e);
    if (mode === 'fallback' && err.notImplemented && fixtures.canHandle(method, path))
      return fixtures.handle<T>(method, path, body);
    throw err;
  }
}

/** POST /v1/storage/measure {wait:false}; older daemons answer with the plain pool after measuring */
export type StorageMeasureResponse = StoragePoolDto & {
  started?: string[];
  skipped?: { accountId: string; reason: string }[];
};

const q = (path: string) => encodeURIComponent(path);
const withToken = <T extends object>(body: T, confirmToken?: string) =>
  confirmToken ? { ...body, confirmToken } : body;

export const api = {
  status: () => call<StatusDto>('GET', '/v1/status'),
  accounts: () => call<AccountDto[]>('GET', '/v1/accounts'),
  pairs: () => call<PairDto[]>('GET', '/v1/pairs'),
  activity: (query: string) => call<ActivityItemWithRun[]>('GET', `/v1/activity?${query}`),
  runs: (limit = 200) => call<RunDto[]>('GET', `/v1/runs?limit=${limit}`),
  jobs: (state?: JobDto['state'], limit = 200) =>
    call<JobDto[]>('GET', `/v1/jobs?limit=${limit}${state ? `&state=${state}` : ''}`),
  sync: (req: SyncRequest = {}) => call<SyncResponse>('POST', '/v1/sync', req),
  pause: (req: TimedPauseRequest) => call<{ ok: true }>('POST', '/v1/pause', req),
  resume: (req: TimedPauseRequest) => call<{ ok: true }>('POST', '/v1/resume', req),

  tree: (pairId: number, path: string) => call<TreeNodeDto[]>('GET', `/v1/pairs/${pairId}/tree?path=${q(path)}`),
  rules: (pairId: number) => call<SelectionRule[]>('GET', `/v1/pairs/${pairId}/rules`),
  setRules: (pairId: number, rules: SelectionRule[]) => call<{ ok: true }>('PUT', `/v1/pairs/${pairId}/rules`, rules),
  createPair: (req: CreatePairRequest) => call<PairDto>('POST', '/v1/pairs', req),
  previewPair: (req: CreatePairRequest) => call<PairPreviewDto>('POST', '/v1/pairs/preview', req),
  patchPair: (
    id: number,
    patch: Partial<Pick<PairDto, 'direction' | 'enabled' | 'paused' | 'name' | 'options'>>,
    confirmToken?: string,
  ) => call<PairDto>('PATCH', `/v1/pairs/${id}`, withToken(patch, confirmToken)),
  removePair: (id: number, confirmToken?: string) =>
    call<{ ok: true }>('DELETE', `/v1/pairs/${id}`, withToken({}, confirmToken)),
  releaseBrake: (pairId: number, confirmToken?: string) =>
    call<{ ok: true }>('POST', `/v1/pairs/${pairId}/release-brake`, withToken({}, confirmToken)),
  /** two-way mass-delete guard: approve (carry out) or deny (restore) all held deletions of a pair */
  decideHeld: (pairId: number, approve: boolean, confirmToken?: string) =>
    call<DecideHeldDeletionsResponse>(
      'POST',
      `/v1/pairs/${pairId}/held-deletions`,
      withToken({ approve } satisfies DecideHeldDeletionsRequest, confirmToken),
    ),
  browse: (accountId: string, path: string) =>
    call<RemoteBrowseEntry[]>('GET', `/v1/remote/${encodeURIComponent(accountId)}/browse?path=${q(path)}`),

  conflicts: () => call<ConflictDto[]>('GET', '/v1/conflicts'),
  resolveConflict: (id: number, resolution: ConflictResolution, confirmToken?: string) =>
    call<{ ok: true }>('POST', `/v1/conflicts/${id}/resolve`, withToken({ resolution }, confirmToken)),
  deletions: () => call<PendingDeletionDto[]>('GET', '/v1/deletions'),
  decideDeletions: (req: DecideDeletionsRequest, confirmToken?: string) =>
    call<{ ok: true; jobIds: number[] }>('POST', '/v1/deletions/decide', withToken(req, confirmToken)),
  adoptions: () => call<AdoptionProposalDto[]>('GET', '/v1/adoptions'),
  decideAdoptions: (ids: number[], accept: boolean) =>
    call<{ ok: true }>('POST', '/v1/adoptions/decide', { ids, accept }),

  storage: () => call<StoragePoolDto>('GET', '/v1/storage'),
  /** starts a measurement in the background (all ready accounts or one); progress via SSE `storage` */
  measureStorage: (accountId?: string) =>
    call<StorageMeasureResponse>('POST', '/v1/storage/measure', { wait: false, ...(accountId ? { accountId } : {}) }),
  storageHistory: (days = 90) => call<StorageHistoryPoint[]>('GET', `/v1/storage/history?days=${days}`),

  createAccount: (id: string, displayName: string) => call<AccountDto>('POST', '/v1/accounts', { id, displayName }),
  login: (id: string) => call<LoginStartResponse>('POST', `/v1/accounts/${encodeURIComponent(id)}/login`),
  patchAccount: (id: string, patch: PatchAccountRequest) =>
    call<AccountDto>('PATCH', `/v1/accounts/${encodeURIComponent(id)}`, patch),
  removeAccount: (id: string, confirmToken?: string) =>
    call<{ ok: true }>('DELETE', `/v1/accounts/${encodeURIComponent(id)}`, withToken({}, confirmToken)),
  cancelLogin: (id: string) => call<{ ok: true }>('DELETE', `/v1/accounts/${encodeURIComponent(id)}/login`),
  cli: (id: string, args: string[]) =>
    call<CliPassthroughResponse>('POST', `/v1/accounts/${encodeURIComponent(id)}/cli`, { args }),
  logout: (id: string, confirmToken?: string) =>
    call<{ ok: true }>('DELETE', `/v1/accounts/${encodeURIComponent(id)}/session`, withToken({}, confirmToken)),

  settings: () => call<SettingsDto>('GET', '/v1/settings'),
  putSettings: (patch: Partial<SettingsDto>) => call<SettingsDto>('PUT', '/v1/settings', patch),
  doctor: () => call<DoctorCheck[]>('GET', '/v1/doctor'),
  notifications: (limit = 20) => call<NotificationLogItem[]>('GET', `/v1/notifications?limit=${limit}`),
  notificationConfig: () => call<NotificationConfigDto>('GET', '/v1/notifications/config'),
  testNotification: (channel?: 'command') =>
    call<NotificationTestResult[]>('POST', '/v1/notifications/test', channel ? { channel } : {}),

  whoami: () => call<WhoAmIDto>('GET', '/v1/whoami'),
  tokens: () => call<AgentTokenInfoDto[]>('GET', '/v1/tokens'),
  createToken: (name: string, scopes: AgentPermission[], writeFile = true) =>
    call<CreateAgentTokenResponse>('POST', '/v1/tokens', { name, scopes, writeFile }),
  patchToken: (id: string, patch: PatchAgentTokenRequest) =>
    call<AgentTokenInfoDto>('PATCH', `/v1/tokens/${encodeURIComponent(id)}`, patch),
  revokeToken: (id: string, confirmToken?: string) =>
    call<{ ok: true }>('DELETE', `/v1/tokens/${encodeURIComponent(id)}`, withToken({}, confirmToken)),
  rotateDefaultToken: (confirmToken?: string) =>
    call<{ file: string; token: string }>('POST', '/v1/tokens/agent/rotate', withToken({}, confirmToken)),
  approvals: () => call<ApprovalDto[]>('GET', '/v1/approvals'),
  decideApproval: (id: string, approve: boolean) =>
    call<ApprovalDto>('POST', `/v1/approvals/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`, {}),

  maintenanceSummary: () => call<MaintenanceSummaryDto>('GET', '/v1/maintenance/summary'),
  digestBackfill: (pairId: number, relPrefix?: string) =>
    call<{ runId: number }>('POST', '/v1/maintenance/digest-backfill', { pairId, ...(relPrefix ? { relPrefix } : {}) }),
  emptyTrash: (accountId: string, confirmToken?: string) =>
    call<{ ok: true }>('POST', '/v1/maintenance/empty-trash', withToken({ accountId }, confirmToken)),
};
