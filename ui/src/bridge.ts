// SPDX-License-Identifier: GPL-3.0-or-later
/** Typed API exposed by the preload script as window.nucleonSync (renderer has no Node, no network). */
import type { ActivityItem, DaemonEvent, PauseRequest, StatusDto, SyncRequest } from '@nucleon-sync/shared';

import type { ConnectionState, UiPrefs, UiState } from './common/ipc.ts';

export type PauseDuration = number | 'tomorrow' | null | 'resume';

export interface NucleonSyncBridge {
  status(): Promise<StatusDto>;
  activity(limit?: number): Promise<ActivityItem[]>;
  sync(req?: SyncRequest): Promise<{ runId: number }>;
  pause(req?: PauseRequest): Promise<{ ok: true }>;
  resume(req?: PauseRequest): Promise<{ ok: true }>;
  /** generic passthrough to allow-listed `/v1/` endpoints (typed wrappers: renderer/api.ts) */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  onEvent(cb: (e: DaemonEvent) => void): () => void;
  onConnection(cb: (state: ConnectionState) => void): () => void;
  connectionState(): Promise<ConnectionState>;
  uiState(): Promise<UiState>;
  onUiState(cb: (s: UiState) => void): () => void;
  onNavigate(cb: (screen: string) => void): () => void;
  /** minutes, 'tomorrow' (07:00), null = unlimited, 'resume' = resume all; timed pauses are tracked by main */
  pauseFor(d: PauseDuration): Promise<void>;
  showInFolder(path: string): Promise<boolean>;
  /** opens a file with its default app (two-way conflicts: "open both"); only paths inside a pair root */
  openPath(path: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  pickFolder(defaultPath?: string): Promise<string | null>;
  openMain(screen?: string): void;
  closeFlyout(): void;
  smokeReport(data: unknown): void;
  /** first-run setup step performed by main (system check, CLI install, service install, ...) */
  setup<T = unknown>(op: string, args?: unknown): Promise<T>;
  onSetupProgress(cb: (p: unknown) => void): () => void;
  /** store UI preferences (language, follow the desktop theme); answers the new UiState */
  setPrefs(patch: Partial<UiPrefs>): Promise<UiState>;
}

declare global {
  interface Window {
    nucleonSync: NucleonSyncBridge;
  }
}
