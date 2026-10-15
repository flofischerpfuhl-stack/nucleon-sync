// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Demo/fixture adapter. Enabled with NUCLEON_SYNC_UI_FIXTURES=1 (answers endpoints that still
 * return 501/404) or =demo (answers everything, simulates runs and SSE events; no daemon needed).
 * Stateful and deterministic, so the UI behaves realistically: rules change the tree, decisions remove rows,
 * destructive calls use the confirm round-trip. Tests drive it via `window.__psFixtures`.
 */
import type {
  AccountDto,
  ActivityAction,
  ActivityItemWithRun,
  AdoptionProposalDto,
  ConfirmRequiredResponse,
  ConflictDto,
  CreatePairRequest,
  DaemonEvent,
  DecideDeletionsRequest,
  DoctorCheck,
  MaintenanceSummaryDto,
  PairDto,
  PairPreviewDto,
  PendingDeletionDto,
  RemoteBrowseEntry,
  RunDto,
  SelectionRule,
  SettingsDto,
  StatusDto,
  StorageDto,
  StorageHistoryPoint,
  StoragePoolDto,
  TreeNodeDto,
} from '@nucleon-sync/shared';
import type {
  AgentPermission,
  AgentTokenInfoDto,
  ApprovalDto,
  ConfirmSummaryDto,
  CreateAgentTokenResponse,
  NotificationLogItem,
} from '@nucleon-sync/shared';

import { ApiError } from '../errors.ts';
import { DEFAULT_SETTINGS, msg, nested, refOf } from '../shared.ts';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const KiB = 1024;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ static folder trees

interface FolderSpec {
  name: string;
  bytes: number;
  files: number;
  remoteBytes?: number | null; // default = bytes
  remoteOnly?: boolean;
  states?: TreeNodeDto['states'];
  children?: FolderSpec[];
  file?: boolean;
}

const f = (
  name: string,
  gb: number,
  files: number,
  children?: FolderSpec[],
  extra: Partial<FolderSpec> = {},
): FolderSpec => ({ name, bytes: Math.round(gb * GiB), files, children, ...extra });

const TREES: Record<number, FolderSpec[]> = {
  1: [
    f('Home', 0.6, 1840, [
      f('Bills', 0.08, 210),
      f('Finance', 0.31, 960, [
        f('Taxes 2024', 0.12, 380),
        f('Taxes 2025', 0.19, 580, undefined, { states: { local_new: 4 } }),
      ]),
      f('Insurance', 0.05, 140),
      f('Apartment', 0.16, 530),
    ]),
    f('Work', 2.4, 5210, [f('Project A', 0.9, 1800), f('Project B', 1.1, 2400), f('Invoices', 0.4, 1010)]),
    f(
      'Projects',
      7.9,
      18_400,
      [
        f('nucleon-sync', 0.012, 240, [f('node_modules', 0.31, 12_800), f('src', 0.002, 61), f('docs', 0.001, 9)], {
          remoteBytes: null,
          states: { local_new: 70 },
        }),
        f('GameDemo', 6.1, 14_000, [f('Library', 5.7, 52_000), f('Assets', 0.4, 2100)], { states: { local_new: 59 } }),
        f('Website', 0.2, 900),
      ],
      { remoteBytes: Math.round(7.1 * GiB), states: { local_new: 129 } },
    ),
    f(
      'Studies',
      7.1,
      9800,
      [f('Thesis', 4.2, 5200, undefined, { states: { conflict: 2 } }), f('Bachelor', 2.9, 4600)],
      {
        states: { conflict: 2 },
      },
    ),
    f('Family', 31.4, 22_000, [f('Vacation', 18.2, 9400), f('Trip 2025', 13.2, 12_600)]),
    f('Old-Archive', 12.8, 31_000, [f('2015', 4.1, 9000), f('2016', 8.7, 22_000)]),
    f('Scratch', 3.2, 6100, [f('Inbox', 1.3, 2100), f('Current', 1.9, 4000)]),
    f('Remote-only', 0, 0, [f('Scans 2023', 0, 0, undefined, { remoteOnly: true, remoteBytes: 0.4 * GiB })], {
      remoteOnly: true,
      remoteBytes: Math.round(0.4 * GiB),
    }),
  ],
  2: ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'].map((y, i) =>
    f(y, 12 + i * 4.5, 2400 + i * 900, [
      f('Phone', 6 + i * 2, 1800 + i * 500),
      f('Camera', 6 + i * 2.5, 600 + i * 400),
    ]),
  ),
  3: [f('Old', 1, 100)],
  4: [
    f('Pictures', 41, 4100, [f('Holiday', 22, 2100, undefined, { states: { remote_new: 2 } }), f('Family', 19, 2000)], {
      states: { remote_new: 2 },
    }),
    f('Documents', 2.1, 900, [f('Applications', 0.3, 120)]),
    f('Music', 14.2, 3100),
  ],
  5: [f('Recipes', 0.01, 12), f('Photos to share', 0.2, 40)],
};

const DEFAULT_GLOB_NAMES = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'Library']);

// ------------------------------------------------------------------ demo paths for activity

const ALEX_PATHS = [
  'Work/Project A/Quote.xlsx',
  'Work/Invoices/2026/INV-2026-041.pdf',
  'Home/Finance/Taxes 2025/Receipts October.pdf',
  'Studies/Thesis/Thesis.docx',
  'Projects/nucleon-sync/docs/notes.md',
  'Projects/GameDemo/Assets/Textures/Roof_Tiles.png',
  'Family/Vacation/Itinerary/Itinerary-final.pdf',
  'Family/Trip 2025/Gardasee/IMG_4471.jpg',
  'Home/Apartment/Utilities 2025.pdf',
  'Work/Project B/Plans/Floor plan.dwg',
];
const PICTURE_PATHS = ['2026/Phone/IMG_20261009_181233.jpg', '2026/Camera/DSC07112.ARW', '2025/Phone/VID_20250812.mp4'];
const SAM_PATHS = [
  'Pictures/Holiday/IMG_0001.jpg',
  'Pictures/Family/Birthday.jpg',
  'Documents/Resume.pdf',
  'Documents/Applications/Cover-letter.docx',
];

// ------------------------------------------------------------------ fixture state

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

type Mode = 'fallback' | 'demo';

class Fixtures {
  mode: Mode | null = null;
  readonly calls: Recorded[] = [];
  private readonly listeners = new Set<(ev: DaemonEvent) => void>();
  private now = Date.now();
  private accounts: AccountDto[] = [];
  private pairs: PairDto[] = [];
  private runs: RunDto[] = [];
  private activity: ActivityItemWithRun[] = [];
  private rules = new Map<number, SelectionRule[]>();
  private conflicts: ConflictDto[] = [];
  private deletions: PendingDeletionDto[] = [];
  private adoptions: AdoptionProposalDto[] = [];
  private settings: SettingsDto = structuredClone(DEFAULT_SETTINGS);
  private tokens: AgentTokenInfoDto[] = [
    {
      id: 'default',
      name: 'default',
      scopes: ['read', 'sync'],
      createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
      lastUsedAt: new Date(Date.now() - 4 * MIN).toISOString(),
      builtin: true,
      disabled: false,
      file: '~/.config/nucleon-sync/agent-token',
      prefix: 'q3Xw9a…',
    },
    {
      id: '5e1c09ab',
      name: 'claude',
      scopes: ['read', 'sync', 'manage', 'destructive'],
      createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
      lastUsedAt: new Date(Date.now() - 50 * MIN).toISOString(),
      builtin: false,
      disabled: false,
      file: '~/.config/nucleon-sync/agent-tokens/5e1c09ab.token',
      prefix: 'nst_k2Pq…',
    },
  ];
  private approvals: ApprovalDto[] = [];
  private telegramTokenSet = true;
  private notificationLog: NotificationLogItem[] = [
    {
      id: 1,
      ts: new Date(Date.now() - 3 * HOUR).toISOString(),
      channel: 'desktop',
      key: 'error:auth:sam',
      message: 'Sam: Sign-in required',
      ok: true,
      detail: null,
    },
  ];

  /** demo/screenshot hook: an agent asks for approval */
  demoApproval(): void {
    const a: ApprovalDto = {
      id: 'a1b2c3',
      tokenId: '5e1c09ab',
      tokenName: 'claude',
      method: 'DELETE',
      path: '/v1/pairs/3',
      summary: {
        kind: 'pair.remove',
        params: { name: 'Outbox', local: '/home/demo/Outbox', remote: '/my-files/Outbox' },
        title: 'Remove pair "Outbox"',
        items: 412,
        bytes: 3.2 * GiB,
        details: [],
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * MIN).toISOString(),
      state: 'pending',
      decidedAt: null,
    };
    this.approvals = [a];
    this.emit({ type: 'approval', approval: a });
  }
  private paused = false;
  private currentRun: RunDto | null = null;
  private nextId = 1;
  private confirmTokens = new Map<string, string>();
  private loginTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private backfill: MaintenanceSummaryDto['backfill'] = null;
  private trashEmptied = new Set<string>();
  /** storage: last measurement per account (null = never measured) and measurements in progress */
  private measuredAt = new Map<string, string | null>();
  private measuring = new Set<string>();
  /** test overrides: [method, path regex, value] answered before the normal routes */
  private overrides: [string, RegExp, unknown][] = [];
  /** demo: successful mutations, replayed in the other window (main window ⇄ tray flyout share one demo state) */
  private readonly mutations: Recorded[] = [];
  private channel: BroadcastChannel | null = null;
  private replaying = false;
  private synced = false;

  install(mode: Mode): void {
    if (this.mode) return;
    this.mode = mode;
    this.seed();
    const hook = {
      calls: this.calls,
      rules: (pairId: number) => this.rules.get(pairId) ?? [],
      completeLogin: (id: string) => this.finishLogin(id, true),
      failLogin: (id: string) => this.finishLogin(id, false),
      seedActivity: (n: number) => this.seedActivity(n),
      emit: (ev: DaemonEvent) => this.emit(ev),
      reset: () => {
        this.calls.length = 0;
      },
      /** answer `method path` (regex source on the path without query) with `value` until clearOverrides() */
      override: (method: string, pathRe: string, value: unknown) =>
        this.overrides.unshift([method, new RegExp(pathRe), value]),
      clearOverrides: () => {
        this.overrides = [];
      },
      /** forget all storage measurements ("noch nicht gemessen") */
      unmeasure: () => {
        for (const a of this.accounts) this.measuredAt.set(a.id, null);
        this.emit({ type: 'storage', accountId: this.accounts[0]?.id ?? 'alex', phase: 'done' });
      },
      /** make a screen throw while rendering (error boundary test; read by app.tsx CrashProbe) */
      crashScreen: (screen: string | null) => {
        (window as unknown as { __psCrashScreen?: string | null }).__psCrashScreen = screen;
      },
      /** an agent asks for approval of a destructive action (approval dialog) */
      demoApproval: () => this.demoApproval(),
      /** direct API call against the fixture backend (tests) */
      call: (method: string, path: string, body?: unknown) => this.handle(method, path, body),
    };
    (window as unknown as { __psFixtures: typeof hook }).__psFixtures = hook;
    if (mode === 'demo') this.joinChannel();
  }

  // ---------------------------------------------------------------- cross-window demo state

  private joinChannel(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('nucleon-sync-demo-fixtures');
    this.channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { kind: 'hello' } | { kind: 'log'; log: Recorded[] } | ({ kind: 'mutation' } & Recorded);
      if (msg.kind === 'hello') {
        if (this.mutations.length) this.channel?.postMessage({ kind: 'log', log: this.mutations });
      } else if (msg.kind === 'log') {
        if (this.synced) return;
        this.synced = true;
        // catch up on what the other window changed before this one existed; no simulated runs/logins/timers
        for (const m of msg.log)
          if (
            !/\/v1\/(sync|accounts\/[^/]+\/login|storage\/measure|maintenance\/digest-backfill)$/.test(
              m.path.split('?')[0]!,
            )
          )
            this.replay(m);
      } else if (msg.kind === 'mutation') {
        this.synced = true;
        this.replay(msg);
      }
    };
    this.channel.postMessage({ kind: 'hello' });
  }

  private replay(m: Recorded): void {
    const [pathname, query] = m.path.split('?') as [string, string | undefined];
    const route = this.routes.find(([meth, re]) => meth === m.method && re.test(pathname));
    if (!route) return;
    this.replaying = true;
    try {
      route[2](pathname.match(route[1])!, m.body, new URLSearchParams(query ?? ''));
      this.mutations.push(m);
    } catch {
      /* the other window already validated it; ignore divergent replays */
    } finally {
      this.replaying = false;
    }
  }

  onEvent(cb: (ev: DaemonEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: DaemonEvent): void {
    for (const l of this.listeners) l(ev);
  }

  // ---------------------------------------------------------------- seed

  private seed(): void {
    const now = this.now;
    this.accounts = [
      {
        id: 'alex',
        displayName: 'Alex',
        email: 'alex@example.org',
        status: 'ok',
        lastError: null,
        lastOkAt: new Date(now - 4 * MIN).toISOString(),
        credentialBackend: 'keyring-shim',
        workers: { configured: 2, active: 2 },
        paused: false,
      },
      {
        id: 'sam',
        displayName: 'Sam',
        email: 'sam@example.org',
        status: 'ok',
        lastError: null,
        lastOkAt: new Date(now - 6 * MIN).toISOString(),
        credentialBackend: 'keyring-shim',
        workers: { configured: 1, active: 1 },
        paused: false,
      },
    ];
    const lastRun = new Date(now - 58 * MIN).toISOString();
    const pair = (
      id: number,
      accountId: string,
      name: string,
      localRoot: string,
      remoteRoot: string,
      direction: PairDto['direction'],
      counts: PairDto['counts'],
      gb: number,
      enabled = true,
    ): PairDto => ({
      id,
      accountId,
      name,
      localRoot,
      remoteRoot,
      direction,
      enabled,
      paused: false,
      counts,
      bytesTracked: Math.round(gb * GiB),
      lastRunAt: enabled ? lastRun : null,
      lastFullAt: enabled ? new Date(now - 5 * DAY).toISOString() : null,
    });
    this.pairs = [
      pair(
        1,
        'alex',
        'Documents',
        '/home/alex/Documents',
        '/devices/Workstation/Documents',
        'backup',
        { synced: 18_420, local_new: 129, conflict: 2 },
        182,
      ),
      pair(
        2,
        'alex',
        'Photos',
        '/home/alex/Pictures/Photos',
        '/devices/Workstation/Photos',
        'backup',
        { synced: 12_904 },
        206,
      ),
      pair(3, 'alex', 'Archive', '/home/alex/Archive', '/devices/Workstation/Archive', 'backup', {}, 0, false),
      pair(
        4,
        'sam',
        'Laptop-Backup',
        '/home/alex/Shared/Sam/Laptop-Backup',
        '/my-files/Laptop-Backup',
        'mirror-down',
        { synced: 5120, remote_new: 2, conflict: 1 },
        57,
      ),
      pair(
        5,
        'sam',
        'For Sam',
        '/home/alex/Shared/Sam/For Sam',
        '/my-files/From Alex',
        'upload-only',
        { synced: 14 },
        0.2,
      ),
    ];
    this.rules.set(1, [
      { id: 1, kind: 'exclude', patternType: 'prefix', pattern: 'Old-Archive', source: 'user' },
      { id: 2, kind: 'exclude', patternType: 'prefix', pattern: 'Scratch/Inbox', source: 'user' },
    ]);
    this.settings.storagePoolBytes = 500 * GiB;

    // runs: every 2 h for 30 days (scheduled incremental), Sunday 03:00 full, a few manual/agent runs
    const r = rng(42);
    const runs: RunDto[] = [];
    let id = 812;
    for (let t = now - 58 * MIN; t > now - 30 * DAY; t -= 2 * HOUR) {
      const busy = r();
      const full = new Date(t).getDay() === 0 && new Date(t).getHours() < 5;
      const uploaded = busy > 0.75 ? Math.floor(r() * 40) : busy > 0.45 ? Math.floor(r() * 6) : 0;
      const downloaded = busy > 0.8 ? Math.floor(r() * 8) : 0;
      const errors = r() > 0.95 ? 1 + Math.floor(r() * 2) : 0;
      const dur = (full ? 40 : 2) * MIN + Math.floor(r() * 3 * MIN);
      runs.push({
        id: id--,
        trigger: r() > 0.93 ? 'manual' : 'schedule',
        mode: full ? 'full' : 'incremental',
        accountId: null,
        pairId: null,
        startedAt: new Date(t - dur).toISOString(),
        finishedAt: new Date(t).toISOString(),
        status: errors ? 'partial' : 'ok',
        counters: {
          scannedLocal: 124_000 + Math.floor(r() * 400),
          listedRemoteFolders: full ? 20_400 : 180 + Math.floor(r() * 60),
          uploaded,
          uploadedBytes: Math.round(uploaded * (0.2 + r() * 6) * MiB),
          downloaded,
          downloadedBytes: Math.round(downloaded * (1 + r() * 4) * MiB),
          moved: r() > 0.85 ? 1 + Math.floor(r() * 3) : 0,
          adopted: 0,
          conflicts: 0,
          pendingDeletions: 0,
          errors,
        },
      });
    }
    this.runs = runs;
    this.activity = [];
    this.nextId = 1;
    for (const run of [...runs].reverse()) this.activityForRun(run, r);
    this.activity.sort((a, b) => a.ts.localeCompare(b.ts));
    this.activity.forEach((a, i) => (a.id = i + 1));

    const ts = (ago: number) => new Date(now - ago).toISOString();
    this.conflicts = [
      {
        id: 1,
        pairId: 1,
        accountId: 'alex',
        relPath: 'Studies/Thesis/Thesis.docx',
        kind: 'both_changed',
        detectedAt: ts(62 * MIN),
        local: { size: 2.1 * MiB, mtime: ts(80 * MIN), sha1: '3fa4c1d0e9b2a7f6c5d4e3b2a1f0e9d8c7b6a5f4' },
        remote: { size: 2.0 * MiB, mtime: ts(3.5 * HOUR), sha1: null },
        base: { size: 2.0 * MiB, mtime: ts(19 * HOUR), sha1: '9b1e44aa0c7d2e8f1a3b5c7d9e0f2a4b6c8d0e1f' },
      },
      {
        id: 2,
        pairId: 1,
        accountId: 'alex',
        relPath: 'Studies/Thesis/Bibliography.xlsx',
        kind: 'initial_mismatch',
        detectedAt: ts(62 * MIN),
        local: { size: 88 * KiB, mtime: ts(2 * DAY), sha1: 'aa01bb02cc03dd04ee05ff0611223344556677ab' },
        remote: { size: 91 * KiB, mtime: ts(9 * DAY), sha1: null },
        base: null,
      },
      {
        id: 3,
        pairId: 4,
        accountId: 'sam',
        relPath: 'Documents/Resume.pdf',
        kind: 'mirror_local_edit',
        detectedAt: ts(3 * HOUR),
        local: { size: 412 * KiB, mtime: ts(4 * HOUR), sha1: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c' },
        remote: { size: 398 * KiB, mtime: ts(6 * DAY), sha1: '77aa88bb99cc00dd11ee22ff33aa44bb55cc66dd' },
        base: { size: 398 * KiB, mtime: ts(6 * DAY), sha1: '77aa88bb99cc00dd11ee22ff33aa44bb55cc66dd' },
      },
    ];
    let did = 1;
    const del = (pairId: number, accountId: string, relPath: string, size: number, ago: number, changed = false) => ({
      id: did++,
      pairId,
      accountId,
      relPath,
      size: Math.round(size),
      detectedAt: ts(ago),
      remoteChangedSinceDelete: changed,
    });
    this.deletions = [
      del(1, 'alex', 'Projects/alt/report-v1.pdf', 1.2 * MiB, 3 * HOUR),
      ...[
        'index.html',
        'style.css',
        'app.js',
        'logo.svg',
        'impressum.html',
        'bilder/team.jpg',
        'bilder/header.jpg',
        'README.md',
      ].map((n, i) =>
        del(1, 'alex', `Projects/website-2019/${n}`, [8, 4, 30, 3, 6, 4200, 9800, 2][i]! * KiB * 6, 3 * HOUR),
      ),
      del(1, 'alex', 'Family/Vacation/Rough-cut/Vacation-Rough-cut.mp4', 1.4 * GiB, 26 * HOUR),
      del(2, 'alex', '2019/Phone/IMG_2231.jpg', 3.4 * MiB, 2 * DAY, true),
      del(2, 'alex', '2019/Phone/IMG_2232.jpg', 3.1 * MiB, 2 * DAY),
      del(1, 'alex', 'Home/Apartment/Lease-draft.docx', 64 * KiB, 4 * DAY),
    ];
    const ar = rng(7);
    this.adoptions = Array.from({ length: 40 }, (_, i) => {
      const year = 2016 + (i % 8);
      const name = `IMG_${String(3100 + i * 7).padStart(4, '0')}.jpg`;
      return {
        id: i + 1,
        accountId: 'alex',
        pairId: 1,
        targetRelPath: `Family/Fotos ${year}/${name}`,
        sourceRemotePath: `/devices/Workstation/Archivee/Photos/${year}/${name}`,
        sourceUid: `vol~${(1000 + i).toString(16)}`,
        size: Math.round((1.5 + ar() * 4) * MiB),
        matchedBy: i % 5 === 0 ? 'name_size_mtime' : 'sha1',
        outsidePair: true,
      } satisfies AdoptionProposalDto;
    });
  }

  private activityForRun(run: RunDto, r: () => number): void {
    const t0 = Date.parse(run.startedAt);
    const t1 = Date.parse(run.finishedAt ?? run.startedAt);
    const add = (
      accountId: string,
      pairId: number,
      action: ActivityAction,
      relPath: string | null,
      bytes: number | null,
      message: string | ReturnType<typeof msg> | null = null,
    ) => {
      this.activity.push({
        id: this.nextId++,
        ts: new Date(t0 + (t1 - t0) * r()).toISOString(),
        accountId,
        pairId,
        action,
        relPath,
        bytes,
        durationMs: bytes ? Math.round(200 + (bytes / MiB) * 280) : null,
        message: typeof message === 'string' || message === null ? message : message.text,
        ...(message && typeof message !== 'string' ? { msg: refOf(message) } : {}),
        runId: run.id,
      });
    };
    const c = run.counters;
    for (let i = 0; i < Math.min(c.uploaded, 12); i++) {
      const inPictures = r() > 0.75;
      add(
        'alex',
        inPictures ? 2 : 1,
        r() > 0.5 ? 'new_revision' : 'uploaded',
        (inPictures ? PICTURE_PATHS : ALEX_PATHS)[Math.floor(r() * (inPictures ? 3 : 10))]!,
        c.uploaded ? Math.round(c.uploadedBytes / c.uploaded) : null,
      );
    }
    for (let i = 0; i < Math.min(c.downloaded, 6); i++)
      add(
        'sam',
        4,
        'downloaded',
        SAM_PATHS[Math.floor(r() * SAM_PATHS.length)]!,
        Math.round(c.downloadedBytes / c.downloaded),
      );
    for (let i = 0; i < c.moved; i++)
      add(
        'alex',
        1,
        'moved',
        `Studies/Thesis/Chapter ${i + 1}.docx`,
        null,
        `Studies/Drafts/Chapter ${i + 1}.docx → Studies/Thesis/Chapter ${i + 1}.docx`,
      );
    for (let i = 0; i < c.errors; i++)
      add(
        'alex',
        1,
        'error',
        null,
        null,
        msg('activity.listingFailed', { error: 'Too many requests (429) – retried automatically' }),
      );
  }

  private seedActivity(n: number): void {
    const r = rng(99);
    const span = 30 * DAY;
    const base = this.now - span;
    this.activity = Array.from({ length: n }, (_, i) => {
      const sam = r() > 0.8;
      return {
        id: i + 1,
        ts: new Date(base + (span * i) / n).toISOString(),
        accountId: sam ? 'sam' : 'alex',
        pairId: sam ? 4 : 1,
        action: sam ? 'downloaded' : r() > 0.5 ? 'uploaded' : 'new_revision',
        relPath: sam
          ? SAM_PATHS[i % SAM_PATHS.length]!
          : `${ALEX_PATHS[i % ALEX_PATHS.length]!}`.replace('.', `-${i}.`),
        bytes: Math.round(r() * 8 * MiB),
        durationMs: Math.round(r() * 2000),
        message: null,
        runId: null,
      } satisfies ActivityItemWithRun;
    });
    this.nextId = n + 1;
  }

  // ---------------------------------------------------------------- derived

  private status(): StatusDto {
    const now = Date.now();
    const nextInc = new Date(now);
    nextInc.setMinutes(0, 0, 0);
    nextInc.setHours(nextInc.getHours() + (nextInc.getHours() % 2 === 0 ? 2 : 1));
    const full = new Date(now);
    full.setDate(full.getDate() + ((7 - full.getDay()) % 7 || 7));
    full.setHours(3, 0, 0, 0);
    const last = this.runs.find((x) => x.finishedAt) ?? null;
    return {
      apiVersion: 'v1',
      daemonVersion: '0.1.0-demo',
      pid: 4242,
      startedAt: new Date(this.now - 3 * HOUR).toISOString(),
      mode: 'mock',
      state: this.paused ? 'paused' : this.currentRun ? 'syncing' : 'idle',
      paused: this.paused,
      currentRun: this.currentRun,
      lastRun: last,
      nextRuns: [
        { mode: 'incremental', at: nextInc.toISOString() },
        { mode: 'full', at: full.toISOString() },
      ],
      accounts: this.accounts,
      pairs: this.pairs,
      queue: this.currentRun
        ? { queued: 14, running: 3, retryWait: 0, failed: 0, blocked: 0 }
        : { queued: 0, running: 0, retryWait: 0, failed: 0, blocked: 0 },
      openConflicts: this.conflicts.length,
      pendingDeletions: this.deletions.length,
      rate: this.currentRun
        ? { uploadBps: 3.8 * MiB, downloadBps: 1.1 * MiB, metaLatencyMsEwma: 210 }
        : { uploadBps: 0, downloadBps: 0, metaLatencyMsEwma: 210 },
    };
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() });
  }

  private ruleFor(
    pairId: number,
    relPath: string,
    name: string,
  ): { sel: 'included' | 'excluded'; by: TreeNodeDto['excludedBy'] } {
    let best: SelectionRule | null = null;
    for (const r of this.rules.get(pairId) ?? [])
      if (r.patternType === 'prefix' && (relPath === r.pattern || relPath.startsWith(r.pattern + '/')))
        if (!best || r.pattern.length > best.pattern.length) best = r;
    const isGlob = (p: string) => p.split('/').some((seg) => DEFAULT_GLOB_NAMES.has(seg));
    const globbed = DEFAULT_GLOB_NAMES.has(name) || isGlob(relPath);
    // a default-excluded folder is included only by an explicit include rule at (or below) the globbed folder
    if (best?.kind === 'include' && (!globbed || isGlob(best.pattern))) return { sel: 'included', by: null };
    if (best?.kind === 'exclude') return { sel: 'excluded', by: 'user' };
    if (globbed) return { sel: 'excluded', by: 'default' };
    return { sel: 'included', by: null };
  }

  private subtreeSelection(pairId: number, spec: FolderSpec, relPath: string): TreeNodeDto['selection'] {
    const own = this.ruleFor(pairId, relPath, spec.name).sel;
    for (const c of spec.children ?? []) {
      const cs = this.subtreeSelection(pairId, c, `${relPath}/${c.name}`);
      if (cs !== own) return 'partial';
    }
    return own;
  }

  private tree(pairId: number, path: string): TreeNodeDto[] {
    let list = TREES[pairId] ?? [];
    const parts = path ? path.split('/') : [];
    for (const p of parts) list = list.find((x) => x.name === p)?.children ?? [];
    return list.map((spec) => {
      const relPath = path ? `${path}/${spec.name}` : spec.name;
      const rule = this.ruleFor(pairId, relPath, spec.name);
      const selection = this.subtreeSelection(pairId, spec, relPath);
      return {
        name: spec.name,
        relPath,
        kind: spec.file ? 'file' : 'folder',
        selection,
        excludedBy: rule.sel === 'excluded' ? rule.by : null,
        localBytes: spec.remoteOnly ? null : spec.bytes,
        remoteBytes:
          spec.remoteBytes === undefined
            ? rule.sel === 'excluded' && rule.by === 'default'
              ? null
              : spec.bytes
            : spec.remoteBytes,
        localFiles: spec.remoteOnly ? null : spec.files,
        states:
          spec.states ??
          (rule.sel === 'excluded'
            ? { excluded: spec.files }
            : spec.remoteOnly
              ? { remote_new: 3 }
              : { synced: spec.files }),
        hasChildren: !!spec.children?.length,
      } satisfies TreeNodeDto;
    });
  }

  private measuredOf(id: string): string | null {
    if (!this.measuredAt.has(id))
      this.measuredAt.set(id, id === 'alex' || id === 'sam' ? new Date(this.now - 2 * HOUR).toISOString() : null);
    return this.measuredAt.get(id) ?? null;
  }

  private unmeasured(accountId: string): StorageDto {
    return {
      accountId,
      measuredAt: null,
      areas: [],
      activeBytes: 0,
      totalBytes: 0,
      reclaimableOldRevisionsBytes: 0,
      trashBytes: 0,
    };
  }

  private storage(): StoragePoolDto {
    const pool = this.measuredStorage();
    return {
      ...pool,
      accounts: pool.accounts.map((a) =>
        this.measuredOf(a.accountId)
          ? { ...a, measuredAt: this.measuredOf(a.accountId) }
          : this.unmeasured(a.accountId),
      ),
      measuring: [...this.measuring],
    };
  }

  /** start a (simulated, 1.5 s) background measurement like POST /v1/storage/measure {wait:false} */
  private measure(body: unknown): unknown {
    const b = (body ?? {}) as { wait?: boolean; accountId?: string };
    const ids = this.accounts
      .filter((a) => a.status === 'ok' && (!b.accountId || a.id === b.accountId))
      .map((a) => a.id);
    if (b.wait !== false) {
      for (const id of ids) this.measuredAt.set(id, new Date().toISOString());
      return this.storage();
    }
    const started = ids.filter((id) => !this.measuring.has(id));
    for (const id of started) {
      this.measuring.add(id);
      this.emit({ type: 'storage', accountId: id, phase: 'start' });
    }
    setTimeout(() => {
      for (const id of started) {
        this.measuring.delete(id);
        this.measuredAt.set(id, new Date().toISOString());
        this.emit({ type: 'storage', accountId: id, phase: 'done' });
      }
    }, 1500);
    const skipped = this.accounts
      .filter((a) => a.status !== 'ok' && (!b.accountId || a.id === b.accountId))
      .map((a) => ({ accountId: a.id, reason: `Account ${a.displayName} is not ready (${a.status})` }));
    return { ...this.storage(), started: ids, skipped };
  }

  private measuredStorage(): StoragePoolDto {
    const measuredAt = new Date(this.now - 2 * HOUR).toISOString();
    const alex: StorageDto = {
      accountId: 'alex',
      measuredAt,
      areas: [
        { path: '/devices/Workstation', label: '/devices/Workstation', bytes: 212 * GiB, files: 48_310 },
        { path: '/devices/Laptop', label: '/devices/Laptop (old)', bytes: 96 * GiB, files: 20_450 },
        { path: '/my-files', label: '/my-files', bytes: 74 * GiB, files: 7120 },
      ],
      activeBytes: 382 * GiB,
      totalBytes: 392 * GiB,
      reclaimableOldRevisionsBytes: this.trashEmptied.has('alex') ? 0 : 9 * GiB,
      trashBytes: this.trashEmptied.has('alex') ? 0 : 1 * GiB,
    };
    const sam: StorageDto = {
      accountId: 'sam',
      measuredAt,
      areas: [
        { path: '/my-files', label: '/my-files', bytes: 42 * GiB, files: 3900 },
        { path: '/devices', label: '/devices/Sam-Laptop', bytes: 2 * GiB, files: 350 },
      ],
      activeBytes: 43.8 * GiB,
      totalBytes: 44 * GiB,
      reclaimableOldRevisionsBytes: 0,
      trashBytes: 0.2 * GiB,
    };
    const extra: StorageDto[] = this.accounts
      .filter((a) => a.id !== 'alex' && a.id !== 'sam')
      .map((a) => ({
        accountId: a.id,
        measuredAt: null,
        areas: [],
        activeBytes: 0,
        totalBytes: 0,
        reclaimableOldRevisionsBytes: 0,
        trashBytes: 0,
      }));
    return { poolBytes: this.settings.storagePoolBytes, accounts: [alex, sam, ...extra] };
  }

  private history(days: number): StorageHistoryPoint[] {
    const out: StorageHistoryPoint[] = [];
    const r = rng(5);
    let fl = 360 * GiB;
    let an = 40 * GiB;
    for (let d = days; d >= 0; d--) {
      const at = new Date(this.now - d * DAY).toISOString();
      fl += (r() * 1.1 - 0.2) * GiB;
      an += r() * 0.12 * GiB;
      out.push({ accountId: 'alex', at, bytes: Math.round(fl) }, { accountId: 'sam', at, bytes: Math.round(an) });
    }
    return out;
  }

  // ---------------------------------------------------------------- confirm round-trip

  private requireConfirm(key: string, body: unknown, summary: ConfirmSummaryDto): boolean {
    if (this.replaying) return true; // confirmed in the other window
    const token = (body as { confirmToken?: string } | null)?.confirmToken;
    if (token && this.confirmTokens.get(token) === key) {
      this.confirmTokens.delete(token);
      return true;
    }
    const t = `ct-${Math.random().toString(36).slice(2, 10)}`;
    this.confirmTokens.set(t, key);
    const resp: ConfirmRequiredResponse = {
      code: 'conflict',
      error: 'confirmation required',
      confirmToken: t,
      expiresAt: new Date(Date.now() + 5 * MIN).toISOString(),
      summary,
    };
    throw new ApiError(409, resp, 'confirmation required');
  }

  // ---------------------------------------------------------------- simulated runs and login

  private startRun(trigger: RunDto['trigger']): number {
    if (this.currentRun) return this.currentRun.id;
    const id = (this.runs[0]?.id ?? 0) + 1;
    const run: RunDto = {
      id,
      trigger,
      mode: 'incremental',
      accountId: null,
      pairId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      counters: {
        scannedLocal: 0,
        listedRemoteFolders: 0,
        uploaded: 0,
        uploadedBytes: 0,
        downloaded: 0,
        downloadedBytes: 0,
        moved: 0,
        adopted: 0,
        conflicts: 0,
        pendingDeletions: 0,
        errors: 0,
      },
    };
    this.currentRun = run;
    this.runs.unshift(run);
    this.emit({ type: 'run', run });
    this.emitStatus();
    const steps = [
      ['alex', 1, 'new_revision', 'Work/Project A/Quote.xlsx', 41 * KiB],
      ['sam', 4, 'downloaded', 'Pictures/Holiday/IMG_0002.jpg', 3.1 * MiB],
      ['alex', 1, 'uploaded', 'Projects/nucleon-sync/docs/CHANGELOG.md', 6 * KiB],
      ['alex', 2, 'uploaded', '2026/Phone/IMG_20261010_120144.jpg', 4.2 * MiB],
      ['sam', 4, 'downloaded', 'Pictures/Holiday/IMG_0003.jpg', 2.8 * MiB],
    ] as const;
    let i = 0;
    const tick = () => {
      if (!this.currentRun || this.currentRun.id !== id) return;
      const s = steps[i++];
      if (!s) {
        run.finishedAt = new Date().toISOString();
        run.status = 'ok';
        run.counters.scannedLocal = 124_380;
        this.currentRun = null;
        this.emit({ type: 'run', run });
        this.emitStatus();
        return;
      }
      const [accountId, pairId, action, relPath, bytes] = s;
      const item: ActivityItemWithRun = {
        id: this.nextId++,
        ts: new Date().toISOString(),
        accountId,
        pairId,
        action,
        relPath,
        bytes: Math.round(bytes),
        durationMs: Math.round(300 + (bytes / MiB) * 300),
        message: null,
        runId: id,
      };
      this.activity.push(item);
      if (action === 'downloaded') {
        run.counters.downloaded++;
        run.counters.downloadedBytes += item.bytes ?? 0;
      } else {
        run.counters.uploaded++;
        run.counters.uploadedBytes += item.bytes ?? 0;
      }
      run.counters.scannedLocal = Math.round((124_380 * i) / steps.length);
      this.emit({ type: 'activity', item });
      this.emitStatus();
      setTimeout(tick, 700);
    };
    setTimeout(tick, 500);
    return id;
  }

  private startLogin(id: string): string {
    const url = `https://account.proton.me/authorize?app=proton-drive-cli&session=${id}-${Math.random().toString(36).slice(2, 10)}`;
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) acc.status = 'login_pending';
    this.emit({ type: 'account', accountId: id, status: 'login_pending' });
    setTimeout(() => this.emit({ type: 'login', accountId: id, phase: 'url', signInUrl: url }), 150);
    clearTimeout(this.loginTimers.get(id));
    if (this.mode === 'demo')
      this.loginTimers.set(
        id,
        setTimeout(() => this.finishLogin(id, true), 30_000),
      );
    return url;
  }

  private finishLogin(id: string, ok: boolean): void {
    clearTimeout(this.loginTimers.get(id));
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) {
      acc.status = ok ? 'ok' : 'needs_login';
      if (ok) {
        acc.email ??= `${id}@example.org`;
        acc.lastOkAt = new Date().toISOString();
      }
    }
    this.emit({
      type: 'login',
      accountId: id,
      phase: ok ? 'done' : 'failed',
      ...(ok ? {} : { message: msg('login.notConfirmed').text, msg: refOf(msg('login.notConfirmed')) }),
    });
    this.emit({ type: 'account', accountId: id, status: ok ? 'ok' : 'needs_login' });
    this.emitStatus();
  }

  // ---------------------------------------------------------------- routing

  private readonly routes: [string, RegExp, (m: RegExpMatchArray, body: unknown, q: URLSearchParams) => unknown][] = [
    ['GET', /^\/v1\/status$/, () => this.status()],
    ['GET', /^\/v1\/accounts$/, () => this.accounts],
    ['GET', /^\/v1\/pairs$/, () => this.pairs],
    ['GET', /^\/v1\/activity$/, (_m, _b, q) => this.queryActivity(q)],
    ['GET', /^\/v1\/runs$/, (_m, _b, q) => this.runs.slice(0, Number(q.get('limit') ?? 200))],
    ['GET', /^\/v1\/jobs$/, () => []],
    // agent layer (demo): tokens, approvals, whoami, notification log
    [
      'GET',
      /^\/v1\/whoami$/,
      () => ({ scope: 'ui', tokenId: null, name: 'ui', permissions: [], approvalRequired: [] }),
    ],
    ['GET', /^\/v1\/tokens$/, () => this.tokens],
    [
      'POST',
      /^\/v1\/tokens$/,
      (_m, b) => {
        const req = b as { name: string; scopes: AgentPermission[]; writeFile?: boolean };
        const id = Math.random().toString(16).slice(2, 10);
        const tk: AgentTokenInfoDto = {
          id,
          name: req.name,
          scopes: [...new Set<AgentPermission>(['read', ...req.scopes])],
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          builtin: false,
          disabled: false,
          file: req.writeFile === false ? null : `~/.config/nucleon-sync/agent-tokens/${id}.token`,
          prefix: 'nst_demo…',
        };
        this.tokens.push(tk);
        const out: CreateAgentTokenResponse = { ...tk, token: `nst_demo${id}secret` };
        return out;
      },
    ],
    [
      'PATCH',
      /^\/v1\/tokens\/(\w+)$/,
      (m, b) => {
        const tk = this.tokens.find((x) => x.id === m[1]);
        if (!tk) throw new ApiError(404, { error: 'no token', code: 'not_found' }, 'no token');
        Object.assign(tk, b);
        return tk;
      },
    ],
    [
      'DELETE',
      /^\/v1\/tokens\/(\w+)$/,
      (m, b) => {
        const tk = this.tokens.find((x) => x.id === m[1]);
        this.requireConfirm(`token:${m[1]}`, b, {
          kind: 'token.revoke',
          params: { name: tk?.name ?? '' },
          title: `Revoke ${tk?.name ?? ''}`,
          items: 1,
          bytes: 0,
          details: [],
        });
        this.tokens = this.tokens.filter((x) => x.id !== m[1]);
        return { ok: true };
      },
    ],
    ['GET', /^\/v1\/approvals$/, () => this.approvals],
    [
      'POST',
      /^\/v1\/approvals\/(\w+)\/(approve|deny)$/,
      (m) => {
        const a = this.approvals.find((x) => x.id === m[1]);
        if (!a) throw new ApiError(404, { error: 'no approval', code: 'not_found' }, 'no approval');
        a.state = m[2] === 'approve' ? 'approved' : 'denied';
        a.decidedAt = new Date().toISOString();
        this.emit({ type: 'approval', approval: { ...a } });
        return a;
      },
    ],
    ['GET', /^\/v1\/notifications$/, () => this.notificationLog],
    [
      'GET',
      /^\/v1\/notifications\/config$/,
      () => ({ telegram: { tokenSet: this.telegramTokenSet }, command: { configured: false, program: null } }),
    ],
    [
      'PUT',
      /^\/v1\/notifications\/telegram-token$/,
      (_m, b) => {
        this.telegramTokenSet = (b as { token: string | null }).token !== null;
        return { ok: true };
      },
    ],
    ['POST', /^\/v1\/notifications\/test$/, () => [{ channel: 'telegram', ok: true, detail: 'sent' }]],
    [
      'DELETE',
      /^\/v1\/pairs\/(\d+)$/,
      (m, b) => {
        const p = this.pairs.find((x) => x.id === Number(m[1]));
        if (!p) throw new ApiError(404, { error: 'no pair', code: 'not_found' }, 'no pair');
        this.requireConfirm(`pair:${p.id}`, b, {
          kind: 'pair.remove',
          params: { name: p.name, local: p.localRoot, remote: p.remoteRoot },
          title: `Remove pair "${p.name}"`,
          items: Object.values(p.counts).reduce((x, y) => x + (y ?? 0), 0),
          bytes: p.bytesTracked,
          details: [],
        });
        this.pairs = this.pairs.filter((x) => x !== p);
        this.emitStatus();
        return { ok: true };
      },
    ],
    [
      'PATCH',
      /^\/v1\/accounts\/([^/]+)$/,
      (m, b) => {
        const acc = this.accounts.find((a) => a.id === decodeURIComponent(m[1]!));
        if (!acc) throw new ApiError(404, { error: 'no account', code: 'not_found' }, 'no account');
        const req = b as { displayName?: string; workers?: number };
        if (req.displayName) acc.displayName = req.displayName;
        if (req.workers) acc.workers = { ...acc.workers, configured: req.workers };
        this.emitStatus();
        return acc;
      },
    ],
    [
      'DELETE',
      /^\/v1\/accounts\/([^/]+)$/,
      (m, b) => {
        const id = decodeURIComponent(m[1]!);
        const acc = this.accounts.find((a) => a.id === id);
        this.requireConfirm(`account:${id}`, b, {
          kind: 'account.remove',
          params: { name: acc?.displayName ?? id },
          title: `Remove account "${acc?.displayName ?? id}"`,
          items: 1,
          bytes: 0,
          details: [],
        });
        this.accounts = this.accounts.filter((a) => a.id !== id);
        this.emitStatus();
        return { ok: true };
      },
    ],
    ['DELETE', /^\/v1\/accounts\/([^/]+)\/login$/, () => ({ ok: true })],
    [
      'POST',
      /^\/v1\/accounts\/([^/]+)\/cli$/,
      (_m, b) => ({
        exitCode: 0,
        stdout: JSON.stringify(
          [
            { name: 'Documents', type: 'folder' },
            { name: 'Pictures', type: 'folder' },
          ],
          null,
          2,
        ),
        stderr: '',
        args: (b as { args: string[] }).args,
      }),
    ],
    ['POST', /^\/v1\/sync$/, () => ({ runId: this.startRun('manual') })],
    [
      'POST',
      /^\/v1\/pause$/,
      (_m, b) => {
        const req = (b ?? {}) as { scope?: string; id?: string | number };
        if (req.scope === 'account') this.setAccountPaused(String(req.id), true);
        else if (req.scope === 'pair') this.setPairPaused(Number(req.id), true);
        else this.paused = true;
        this.emitStatus();
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/v1\/resume$/,
      (_m, b) => {
        const req = (b ?? {}) as { scope?: string; id?: string | number };
        if (req.scope === 'account') this.setAccountPaused(String(req.id), false);
        else if (req.scope === 'pair') this.setPairPaused(Number(req.id), false);
        else this.paused = false;
        this.emitStatus();
        return { ok: true };
      },
    ],
    ['GET', /^\/v1\/pairs\/(\d+)\/tree$/, (m, _b, q) => this.tree(Number(m[1]), q.get('path') ?? '')],
    ['GET', /^\/v1\/pairs\/(\d+)\/rules$/, (m) => this.rules.get(Number(m[1])) ?? []],
    [
      'PUT',
      /^\/v1\/pairs\/(\d+)\/rules$/,
      (m, b) => {
        this.rules.set(
          Number(m[1]),
          (b as SelectionRule[]).map((r, i) => ({ ...r, id: i + 1 })),
        );
        return { ok: true };
      },
    ],
    ['POST', /^\/v1\/pairs\/preview$/, (_m, b) => this.preview(b as CreatePairRequest)],
    [
      'POST',
      /^\/v1\/pairs$/,
      (_m, b) => {
        const req = b as CreatePairRequest;
        const p: PairDto = {
          id: Math.max(...this.pairs.map((x) => x.id)) + 1,
          ...req,
          paused: false,
          counts: {},
          bytesTracked: 0,
          lastRunAt: null,
          lastFullAt: null,
        };
        this.pairs.push(p);
        this.emitStatus();
        return p;
      },
    ],
    [
      'PATCH',
      /^\/v1\/pairs\/(\d+)$/,
      (m, b) => {
        const p = this.pairs.find((x) => x.id === Number(m[1]));
        if (!p) throw new ApiError(404, { error: 'no pair', code: 'not_found' }, 'no pair');
        Object.assign(p, b);
        this.emitStatus();
        return p;
      },
    ],
    [
      'GET',
      /^\/v1\/remote\/([^/]+)\/browse$/,
      (m, _b, q) => this.browse(decodeURIComponent(m[1]!), q.get('path') ?? '/'),
    ],
    ['GET', /^\/v1\/conflicts$/, () => this.conflicts],
    [
      'POST',
      /^\/v1\/conflicts\/(\d+)\/resolve$/,
      (m, b) => {
        const c = this.conflicts.find((x) => x.id === Number(m[1]));
        if (!c) throw new ApiError(404, { error: 'no conflict', code: 'not_found' }, 'no conflict');
        const res = (b as { resolution: string }).resolution;
        if (res === 'keep_remote')
          this.requireConfirm(`conflict:${c.id}`, b, {
            kind: 'conflict.keepRemote',
            params: { path: c.relPath },
            title: 'Replace the local file with the Proton version',
            items: 1,
            bytes: c.local?.size ?? 0,
            details: [`${c.relPath} → local trash`],
          });
        this.conflicts = this.conflicts.filter((x) => x !== c);
        const pair = this.pairs.find((p) => p.id === c.pairId);
        if (pair?.counts.conflict) {
          pair.counts = { ...pair.counts, conflict: pair.counts.conflict - 1 };
          if (!pair.counts.conflict) delete pair.counts.conflict;
        }
        this.emit({ type: 'conflicts_changed', open: this.conflicts.length });
        this.emitStatus();
        return { ok: true };
      },
    ],
    ['GET', /^\/v1\/deletions$/, () => this.deletions],
    [
      'POST',
      /^\/v1\/deletions\/decide$/,
      (_m, b) => this.decideDeletions(b as DecideDeletionsRequest & { confirmToken?: string }),
    ],
    ['GET', /^\/v1\/adoptions$/, () => this.adoptions],
    [
      'POST',
      /^\/v1\/adoptions\/decide$/,
      (_m, b) => {
        const ids = new Set((b as { ids: number[] }).ids);
        this.adoptions = this.adoptions.filter((a) => !ids.has(a.id));
        return { ok: true };
      },
    ],
    ['GET', /^\/v1\/storage$/, () => this.storage()],
    ['POST', /^\/v1\/storage\/measure$/, (_m, b) => this.measure(b)],
    ['GET', /^\/v1\/storage\/history$/, (_m, _b, q) => this.history(Number(q.get('days') ?? 90))],
    ['GET', /^\/v1\/accounts\/([^/]+)\/storage$/, (m) => this.storage().accounts.find((a) => a.accountId === m[1])],
    [
      'POST',
      /^\/v1\/accounts$/,
      (_m, b) => {
        const req = b as { id: string; displayName: string };
        if (!/^[a-z][a-z0-9-]{1,30}$/.test(req.id))
          throw new ApiError(400, { error: 'invalid id', code: 'bad_request' }, 'invalid id');
        if (this.accounts.some((a) => a.id === req.id))
          throw new ApiError(400, { error: 'account exists already', code: 'bad_request' }, 'account exists already');
        const acc: AccountDto = {
          id: req.id,
          displayName: req.displayName,
          email: null,
          status: 'needs_login',
          lastError: null,
          lastOkAt: null,
          credentialBackend: 'keyring-shim',
          workers: { configured: 1, active: 0 },
          paused: false,
        };
        this.accounts.push(acc);
        this.emitStatus();
        return acc;
      },
    ],
    [
      'POST',
      /^\/v1\/accounts\/([^/]+)\/login$/,
      (m) => ({ accountId: m[1]!, signInUrl: this.startLogin(decodeURIComponent(m[1]!)) }),
    ],
    [
      'DELETE',
      /^\/v1\/accounts\/([^/]+)\/session$/,
      (m, b) => {
        const id = decodeURIComponent(m[1]!);
        const acc = this.accounts.find((a) => a.id === id);
        this.requireConfirm(`logout:${id}`, b, {
          kind: 'account.logout',
          params: { name: acc?.displayName ?? id, shared: 0 },
          title: `Log out ${acc?.displayName ?? id}`,
          items: 1,
          bytes: 0,
          details: [
            'The session is removed from the keyring.',
            'Syncing of this account stops until the next sign-in.',
          ],
        });
        if (acc) acc.status = 'needs_login';
        this.emit({ type: 'account', accountId: id, status: 'needs_login' });
        this.emitStatus();
        return { ok: true };
      },
    ],
    ['GET', /^\/v1\/settings$/, () => this.settings],
    [
      'PUT',
      /^\/v1\/settings$/,
      (_m, b) => {
        this.settings = { ...this.settings, ...(b as Partial<SettingsDto>) };
        return this.settings;
      },
    ],
    ['GET', /^\/v1\/doctor$/, () => this.doctor()],
    ['GET', /^\/v1\/maintenance\/summary$/, () => this.maintenance()],
    [
      'POST',
      /^\/v1\/maintenance\/digest-backfill$/,
      (_m, b) => {
        const req = b as { pairId: number; relPrefix?: string };
        const runId = (this.runs[0]?.id ?? 0) + 1;
        this.backfill = { runId, pairId: req.pairId, relPrefix: req.relPrefix ?? null, done: 0, total: 1315 };
        const step = () => {
          if (!this.backfill) return;
          this.backfill.done = Math.min(this.backfill.total, this.backfill.done + 37);
          if (this.backfill.done < this.backfill.total) setTimeout(step, 1000);
        };
        setTimeout(step, 1000);
        return { runId };
      },
    ],
    [
      'POST',
      /^\/v1\/maintenance\/empty-trash$/,
      (_m, b) => {
        const id = (b as { accountId: string }).accountId;
        const t = this.maintenance().trash.find((x) => x.accountId === id);
        this.requireConfirm(`trash:${id}`, b, {
          kind: 'maintenance.emptyTrash',
          params: { name: this.accounts.find((a) => a.id === id)?.displayName ?? id },
          title: 'Empty the Proton trash permanently',
          items: t?.items ?? 0,
          bytes: t?.bytes ?? 0,
          details: [
            'Everything in the trash is deleted permanently – also items that do not come from Nucleon Sync.',
            '1,315 items: replaced revisions of 2026-10-09 (checksums added)',
            '87 items: deleted in the Proton web app',
          ],
        });
        this.trashEmptied.add(id);
        return { ok: true };
      },
    ],
  ];

  private setAccountPaused(id: string, paused: boolean): void {
    const a = this.accounts.find((x) => x.id === id);
    if (a) a.paused = paused;
  }

  private setPairPaused(id: number, paused: boolean): void {
    const p = this.pairs.find((x) => x.id === id);
    if (p) p.paused = paused;
  }

  private queryActivity(q: URLSearchParams): ActivityItemWithRun[] {
    const limit = Math.min(Number(q.get('limit') ?? 100), 1000);
    const before = Number(q.get('before')) || Infinity;
    const account = q.get('account');
    const pair = q.get('pair');
    const actions = q.get('action')?.split(',');
    const since = q.get('since');
    const text = q.get('q')?.toLowerCase();
    const out: ActivityItemWithRun[] = [];
    for (let i = this.activity.length - 1; i >= 0 && out.length < limit; i--) {
      const a = this.activity[i]!;
      if (a.id >= before) continue;
      if (account && a.accountId !== account) continue;
      if (pair && String(a.pairId) !== pair) continue;
      if (actions && !actions.includes(a.action)) continue;
      if (since && a.ts < since) continue;
      if (text && !`${a.relPath ?? ''} ${a.message ?? ''}`.toLowerCase().includes(text)) continue;
      out.push(a);
    }
    return out;
  }

  private decideDeletions(req: DecideDeletionsRequest & { confirmToken?: string }): { ok: true; jobIds: number[] } {
    const rows = this.deletions.filter((d) => req.ids.includes(d.id));
    const bytes = rows.reduce((s, d) => s + d.size, 0);
    if (req.decision === 'trash_remote' && (rows.length > 100 || bytes > GiB))
      this.requireConfirm(`deletions:${req.ids.join(',')}`, req, {
        kind: 'deletions.trashRemote',
        params: { count: rows.length, size: `${(bytes / GiB).toFixed(1)} GB` },
        title: 'Delete in Proton (trash)',
        items: rows.length,
        bytes,
        details: ['', ...rows.slice(0, 8).map((d) => d.relPath)],
      });
    const ids = new Set(req.ids);
    this.deletions = this.deletions.filter((d) => !ids.has(d.id));
    for (const d of rows) {
      const item: ActivityItemWithRun = {
        id: this.nextId++,
        ts: new Date().toISOString(),
        accountId: d.accountId,
        pairId: d.pairId,
        action:
          req.decision === 'trash_remote' ? 'trashed_remote' : req.decision === 'restore_local' ? 'downloaded' : 'info',
        relPath: d.relPath,
        bytes: d.size,
        durationMs: 300,
        message: req.decision === 'keep_remote_only' ? 'kept in Proton only' : null,
        runId: null,
      };
      this.activity.push(item);
      this.emit({ type: 'activity', item });
    }
    this.emit({ type: 'deletions_changed', pending: this.deletions.length });
    this.emitStatus();
    return { ok: true, jobIds: rows.map((d) => 10_000 + d.id) };
  }

  private preview(req: CreatePairRequest): PairPreviewDto {
    const seed = [...req.remoteRoot].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const r = rng(seed);
    return {
      adopt: Math.floor(r() * 3000),
      upload: Math.floor(r() * 200),
      uploadBytes: Math.round(r() * 4 * GiB),
      download: req.direction === 'upload-only' ? 0 : Math.floor(r() * 40),
      downloadBytes: Math.round(r() * 300 * MiB),
      conflicts: Math.floor(r() * 3),
      excluded: Math.floor(r() * 500),
      warnings: [],
    };
  }

  private browse(accountId: string, path: string): RemoteBrowseEntry[] {
    const tree: Record<string, string[]> = {
      '/': ['my-files', 'devices', 'shared-with-me'],
      '/devices': accountId === 'sam' ? ['Sam-Laptop'] : ['Workstation', 'Laptop'],
      '/devices/Workstation': ['Documents', 'Photos', 'Archive'],
      '/devices/Laptop': ['Documents', 'Desktop'],
      '/my-files': accountId === 'sam' ? ['Laptop-Backup', 'From Alex', 'Photos'] : ['Scans', 'Shared', 'Vacation'],
      '/shared-with-me': [],
    };
    const names = tree[path] ?? ['Unterordner A', 'Unterordner B'];
    return names.map((name, i) => ({ name, uid: `vol~${path.length}${i}`, type: 'folder' }));
  }

  private doctor(): DoctorCheck[] {
    const check = (id: string, ok: boolean, m: ReturnType<typeof msg>): DoctorCheck => ({
      id,
      ok,
      severity: ok ? 'info' : 'warn',
      message: m.text,
      msg: refOf(m)!,
    });
    return [
      check(
        'cli_version',
        true,
        msg('doctor.cliPresent', { path: '/usr/local/bin/proton-drive', mb: 98, version: '0.9.0' }),
      ),
      check(
        'keyring:alex',
        true,
        msg('doctor.sessionPresent', { name: 'Alex', where: nested(msg('doctor.where.keyring')) }),
      ),
      check(
        'keyring:sam',
        true,
        msg('doctor.sessionPresent', { name: 'Sam', where: nested(msg('doctor.where.keyring')) }),
      ),
      check(
        'disk_space',
        true,
        msg('doctor.diskSpace', { path: '/home/alex/Documents', free: 620 * GiB, percent: 41.2 }),
      ),
      check('api', true, msg('doctor.apiOk')),
      check('service', true, msg('doctor.unitInstalled', { state: 'enabled' })),
      check('inotify', false, msg('doctor.inotify', { value: 65_536 })),
    ];
  }

  private maintenance(): MaintenanceSummaryDto {
    const flTrash = this.trashEmptied.has('alex');
    return {
      digestMissing: [
        { accountId: 'alex', files: 2310, bytes: 9.8 * GiB, duplicateFiles: 412, duplicateBytes: 4.6 * GiB },
        { accountId: 'sam', files: 0, bytes: 0, duplicateFiles: 0, duplicateBytes: 0 },
      ],
      trash: [
        {
          accountId: 'alex',
          items: flTrash ? 0 : 1402,
          bytes: flTrash ? 0 : 31.4 * GiB,
          ownItems: flTrash ? 0 : 1315,
        },
        {
          accountId: 'sam',
          items: this.trashEmptied.has('sam') ? 0 : 3,
          bytes: this.trashEmptied.has('sam') ? 0 : 0.2 * GiB,
          ownItems: 0,
        },
      ],
      backfill: this.backfill,
    };
  }

  canHandle(method: string, path: string): boolean {
    const pathname = path.split('?')[0]!;
    return this.routes.some(([m, re]) => m === method && re.test(pathname));
  }

  async handle<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body: body === undefined ? undefined : structuredClone(body) });
    const [pathname, query] = path.split('?') as [string, string | undefined];
    await new Promise((r) => setTimeout(r, 40));
    const ov = this.overrides.find(([m, re]) => m === method && re.test(pathname));
    if (ov) return structuredClone(ov[2]) as T;
    const route = this.routes.find(([m, re]) => m === method && re.test(pathname));
    if (!route)
      throw new ApiError(404, { error: `no fixture for ${method} ${pathname}`, code: 'not_found' }, 'not found');
    const out = route[2](pathname.match(route[1])!, body, new URLSearchParams(query ?? ''));
    if (method !== 'GET' && this.channel) {
      const m: Recorded = { method, path, body: body === undefined ? undefined : structuredClone(body) };
      this.mutations.push(m);
      this.channel.postMessage({ kind: 'mutation', ...m });
    }
    return structuredClone(out) as T;
  }
}

export const fixtures = new Fixtures();
