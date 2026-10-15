// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Daemon message catalogue. Every user-facing text the daemon produces (activity messages, notices, doctor checks,
 * brake reasons, account errors, preview warnings, …) has a key and params:
 *
 *  - the daemon keeps the English rendering in the existing text field (CLI, logs, agents, `--json` consumers), and
 *    sends the key + params next to it (`MsgRef`, e.g. `ActivityItem.msg`, `DoctorCheck.msg`);
 *  - the dashboard translates the key with its own table (`ui/src/renderer/i18n/<lang>.ts`, section `daemon`, typed
 *    against `DaemonMessages` so every language must provide every key) and falls back to the English text for keys
 *    it does not know (an older UI against a newer daemon) and for rows written before keys existed.
 *
 * Text stored in a plain TEXT column (accounts.last_error, pair brake reasons, …) is encoded with `encodeMsg` and read
 * back with `decodeMsg`; plain strings (CLI error texts) pass through unchanged.
 *
 * Adding a message: add the key here (English), then to every UI language. Params are strings or numbers only
 * (numbers are formatted by the UI in its locale).
 */

export type MsgParams = Record<string, string | number>;

export interface MsgRef {
  key: string;
  params?: MsgParams;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** English byte size with binary units ("512 B", "1.5 MB", "12 GB"). */
export function fmtBytesEn(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 9.95 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** English duration of a remaining time in seconds ("45 s", "12 min", "2 h 5 min", "3 days"). */
export function fmtSecondsEn(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h ${m} min`;
}

/** English texts (source of truth; the UI's `en.daemon` is this table). */
export const DAEMON_MESSAGES_EN = {
  // ------------------------------------------------------------------ doctor
  'doctor.node': (p: { version: string; electron: string; ok: number }) =>
    `Node ${p.version}${p.electron ? ` (Electron ${p.electron})` : ''}${p.ok ? '' : ' (≥ 26 required)'}`,
  'doctor.cliMissing': (p: { path: string }) => `proton-drive not found: ${p.path}`,
  'doctor.cliNotExecutable': (p: { path: string }) => `proton-drive is not executable: ${p.path}`,
  'doctor.cliPresent': (p: { path: string; mb: number; version: string }) =>
    `proton-drive present (${p.path}, ${p.mb} MB)` +
    (p.version ? ` · version ${p.version}` : ' · the version is checked on the first run'),
  'doctor.secretToolsOk': () => 'secret-tool and busctl present',
  'doctor.secretToolsMissing': (p: { missing: string }) => `missing: ${p.missing}`,
  'doctor.sessionPresent': (p: { name: string; where: string }) => `${p.name}: session present (${p.where})`,
  'doctor.sessionLocked': (p: { name: string }) => `${p.name}: keyring locked – unlock it`,
  'doctor.sessionMissing': (p: { name: string; where: string }) =>
    `${p.name}: no session (${p.where}) – sign-in required`,
  'doctor.sessionUnavailable': (p: { name: string }) => `${p.name}: keyring (Secret Service) not reachable`,
  'doctor.where.mock': () => 'mock session',
  'doctor.where.encfile': () => 'encrypted file',
  'doctor.where.adopted': () => 'shared proton-drive CLI entry in the keyring',
  'doctor.where.keyring': () => 'own keyring entry',
  'doctor.noAccounts': () => 'no accounts configured',
  'doctor.foreignCli': (p: { count: number; pids: string; command: string }) =>
    `${p.count} other proton-drive processes are running (PID ${p.pids}: ${p.command}) – accounts using the same ` +
    'session wait until they have finished',
  'doctor.noForeignCli': () => 'no other proton-drive processes',
  'doctor.mounted': (p: { path: string }) => `${p.path} is mounted`,
  'doctor.notMounted': (p: { path: string }) => `${p.path} is not mounted`,
  'doctor.diskSpace': (p: { path: string; free: number; percent: number }) =>
    `${p.path}: ${gb(p.free)} free (${p.percent.toFixed(1)} %)`,
  'doctor.diskSpaceUnknown': (p: { error: string }) => `free space unknown: ${p.error}`,
  'doctor.stagingOtherFs': (p: { dir: string; roots: string }) =>
    `staging ${p.dir} is on a different filesystem than ${p.roots} (downloads are copied instead of renamed; set ` +
    '"stagingDir" in daemon.json)',
  'doctor.stagingOk': (p: { dir: string; exists: number }) =>
    `staging ${p.dir} is writable${p.exists ? '' : ' (created on the first download)'}`,
  'doctor.stagingNotWritable': (p: { dir: string }) => `staging directory ${p.dir} is not writable`,
  'doctor.pairRootOk': (p: { path: string }) => `${p.path} present`,
  'doctor.pairRootMissing': (p: { path: string }) => `${p.path} is missing`,
  'doctor.unitInstalled': (p: { state: string }) => `systemd user unit installed (${p.state})`,
  'doctor.unitMissing': () => 'systemd user unit not installed',
  'doctor.inotify': (p: { value: number }) => `inotify max_user_watches = ${p.value}`,
  'doctor.writesAllowed': () => 'writing to Proton is allowed',
  'doctor.tokenMode': (p: { file: string; mode: string }) => `${p.file} permissions ${p.mode}`,
  'doctor.apiOk': () => 'API reachable',
  'doctor.apiOffline': (p: { detail: string }) => `service not reachable (${p.detail}) – checks ran locally`,
  'doctor.noDatabase': () => 'no state database yet – checking the first-start configuration',

  // ---------------------------------------------------------------- activity feed (ActivityItem.msg)
  'activity.backOnline': () => 'back online',
  /** `status` is a nested message (account.throttled*), `reason` the limiter's technical reason */
  'activity.throttled': (p: { status: string; reason: string }) => `${p.status} (${p.reason})`,
  'activity.bigUpload': (p: { bytes: number; eta?: number }) =>
    `Big upload running (${fmtBytesEn(p.bytes)}${p.eta !== undefined ? `, about ${fmtSecondsEn(p.eta)}` : ''})`,
  'activity.bigDownload': (p: { bytes: number; eta?: number }) =>
    `Big download running (${fmtBytesEn(p.bytes)}${p.eta !== undefined ? `, about ${fmtSecondsEn(p.eta)}` : ''})`,
  'activity.gitAutoResolved': () => '.git internals: conflict resolved automatically – the local version wins',
  'activity.unreadableFolders': (p: { count: number; example: string }) =>
    `${p.count} folders not readable – nothing in them counts as deleted (e.g. ${p.example})`,
  'activity.symlinksSkipped': (p: { count: number; example: string }) =>
    `${p.count} symbolic links skipped (e.g. ${p.example})`,
  'activity.listingFailed': (p: { error: string }) => `Folder listing failed: ${p.error}`,
  'activity.runAborted': (p: { pair: string; errorClass: string; error: string }) =>
    `Run for ${p.pair} aborted (${p.errorClass}): ${p.error}`,
  'activity.twoWayAdoptionDone': () =>
    'Two-way sync: initial comparison finished – deletions are passed on from now on (to the trash)',
  /** `reason` is a nested message (brake.*) */
  'activity.brake': (p: { reason: string }) => `Safety brake: ${p.reason}`,
  'activity.brakeReleased': (p: { by: string }) => `Safety brake released (${p.by})`,
  'activity.heldDecided': (p: { by: string }) => `Held deletions decided (${p.by}) – the pair runs again`,
  'activity.backfillPlanned': (p: { count: number }) => `Add checksums: ${p.count} files scheduled`,
  'activity.pauseExpired': () => 'Pause ended (time is up)',
  'activity.trashEmptied': () => 'Proton trash emptied',
  'activity.keptBothTwoWay': (p: { name: string; copy: string }) =>
    `"${p.name}" already exists in Proton (a different file) – both kept, the local version as "${p.copy}"`,
  'activity.keptBothFromPc': (p: { name: string; copy: string }) =>
    `"${p.name}" already exists in Proton (a different file) – both kept, the one from the PC as "${p.copy}"`,
  'activity.changedDuringUpload': () => 'The file changed during the upload – it is uploaded again',
  'activity.adopted': () => 'adopted',
  'activity.adoptedNoChecksum': () => 'adopted (without checksum)',
  'activity.adoptedVerified': () => 'adopted (content verified, no checksum in Proton)',
  'activity.adoptedMore': (p: { count: number }) => `${p.count} more files adopted`,
  /** label of uploads from the PC into a mirror-down pair (the UI shows it instead of "uploaded") */
  'activity.uploadedFromPc': () => 'uploaded from the PC',
  'activity.uploadedFromPcRenamed': (p: { name: string }) =>
    `uploaded from the PC (renamed, "${p.name}" already existed in Proton)`,
  'activity.changedInProton': () => 'changed in Proton',
  'activity.adoptedFromProton': (p: { from: string; to: string }) => `adopted from Proton: ${p.from} → ${p.to}`,
  'activity.folderKeptRemoteFiles': () => 'Folder deleted here, but Proton still holds other files in it – it is kept',
  'activity.notDeletedChanged': () => 'not deleted: changed in Proton after the decision',
  'activity.movedToProtonTrash': () => 'moved to the Proton trash',
  'activity.deletedInProtonTrashedLocal': () => 'deleted in Proton → moved to the local trash',
  'activity.folderDeletedInProtonRemoved': () => 'Folder deleted in Proton → removed locally (it was empty)',
  'activity.folderDeletedInProtonKept': () =>
    'Folder was deleted in Proton, but still holds other files locally – it is kept',
  'activity.keptBothConflict': (p: { copy: string }) =>
    `both versions kept: the Proton version under the name, the local one as "${p.copy}"`,
  'activity.localVersionKept': (p: { from: string; to: string }) => `local version kept: ${p.from} → ${p.to}`,
  'activity.movedInProton': (p: { from: string; to: string }) =>
    `moved in Proton – followed locally: ${p.from} → ${p.to}`,
  'activity.checksumAdded': (p: { reason?: string }) =>
    `Checksum added (old file in the Proton trash)${p.reason ? ` – ${p.reason}` : ''}`,
  'activity.restoredFromProton': () => 'deleted locally, but changed in Proton – the Proton version was restored',
  'activity.reuploadedLocal': () => 'deleted in Proton, but changed locally – the local version was uploaded again',
  'activity.deletionPending': () => 'Deletion pending',
  'activity.deletionPendingChanged': () => 'Deletion pending (changed in Proton after the deletion)',

  // ---------------------------------------------------------------- notices (Notice.titleMsg / bodyMsg)
  'notice.loginNeeded': () => 'Sign-in required',
  'notice.loginNeededBody': (p: { account: string }) => `The account ${p.account} must be signed in again.`,
  'notice.quotaFull': () => 'Proton storage full',
  'notice.diskFull': () => 'Disk almost full',
  'notice.throttled': () => 'Proton is throttling',
  'notice.throttledBody': () => 'Throttled for more than 30 minutes.',
  'notice.offline': () => 'Offline',
  'notice.offlineBody': () => 'No connection to Proton for more than 2 hours.',
  'notice.cliUpdated': () => 'CLI updated – check compatibility',
  'notice.runErrors': () => 'Sync finished with errors',
  'notice.runErrorsBody': (p: { run: number; errors: number }) => `Run #${p.run}: ${p.errors} errors.`,
  'notice.newConflicts': () => 'New conflicts',
  'notice.newConflictsBody': (p: { count: number }) => `${p.count} new conflicts – please decide.`,
  'notice.pendingDeletions': () => 'Pending deletions',
  'notice.pendingDeletionsBody': (p: { count: number }) =>
    `${p.count} files deleted locally are waiting for a decision.`,
  'notice.adoption': () => 'Found in Proton',
  'notice.adoptionBody': (p: { count: number }) => `${p.count} files can be adopted instead of uploaded again.`,
  'notice.brake': (p: { pair: string }) => `Safety brake: ${p.pair}`,
  'notice.massDeleteHeld': (p: { pair: string }) => `Mass deletion held: ${p.pair}`,

  // ---------------------------------------------------------------- account status details (AccountDto.lastErrorMsg)
  'account.networkError': () => 'Network error',
  'account.loginNeeded': () => 'Sign-in required',
  'account.storageFull': () => 'Storage full',
  'account.throttledUntil': (p: { time: string }) => `Proton is throttling – paused until ${p.time}`,
  'account.throttledOneWorker': () => 'Proton is throttling – 1 worker',
  'account.keyringLocked': () => 'The keyring is locked',
  'account.keyringUnavailable': () => 'Keyring (Secret Service) not reachable',
  'account.noSession': () => 'no stored session',
  'account.foreignCli': (p: { pids: string }) =>
    `Another proton-drive process uses the same session (PID ${p.pids}) – the account waits`,
  'account.notReady': (p: { account: string; status: string }) => `Account ${p.account} is not ready (${p.status})`,

  // ---------------------------------------------------------------- sign-in (login event, account error)
  'login.noUrl': () => 'No sign-in URL received from the CLI (timeout)',
  'login.notConfirmed': () => 'Sign-in not confirmed (timeout after 10 min)',
  'login.cliStartFailed': (p: { error: string }) => `The CLI could not be started: ${p.error}`,
  'login.cliAborted': (p: { signal: string }) => `aborted (${p.signal})`,
  'login.cliExited': (p: { code: string }) => `CLI exited with code ${p.code}`,
  'login.cancelled': () => 'Sign-in cancelled',

  // ---------------------------------------------------------------- write guard, gates, why a sync does not run
  'guard.writesDisabled': () => 'Writing disabled – planning only (NUCLEON_SYNC_ALLOW_WRITES=1 is missing)',
  'guard.cliUpdated': (p: { version: string }) => `CLI updated (${p.version}) – check compatibility, read-only`,
  'gate.shuttingDown': () => 'The service is shutting down',
  'gate.paused': () => 'Syncing is paused',
  'gate.pausedGlobally': () => 'Syncing is paused globally',
  'gate.accountPaused': (p: { account: string }) => `Account ${p.account} is paused`,
  'gate.accountDisabled': (p: { account: string }) => `Account ${p.account} is disabled`,
  'gate.accountStatus': (p: { account: string; status: string }) => `Account ${p.account}: ${p.status}`,
  'gate.accountWaitsForeign': (p: { account: string }) =>
    `Account ${p.account} is waiting for another proton-drive process`,
  'gate.unknownAccount': (p: { id: string }) => `unknown account ${p.id}`,
  'gate.unknownPair': (p: { id: string }) => `unknown pair ${p.id}`,
  'gate.pairDisabled': (p: { id: number; pair: string }) => `Pair #${p.id} "${p.pair}" is disabled`,
  'gate.pairPaused': (p: { id: number; pair: string }) => `Pair #${p.id} "${p.pair}" is paused`,

  // ---------------------------------------------------------------- safety brakes (PairDto.brake.reasonMsg)
  'brake.remoteRootNotFound': (p: { path: string }) => `Proton folder ${p.path} not found`,
  'brake.remoteRootMissing': (p: { path: string }) => `Proton folder ${p.path} is missing or in the trash`,
  'brake.remoteRootEmpty': () => 'The Proton folder is suddenly empty – nothing is deleted locally',
  'brake.localRootMissing': (p: { path: string }) => `Local folder ${p.path} is missing – is the drive mounted?`,
  'brake.localRootEmpty': (p: { path: string }) => `Local folder ${p.path} is empty – nothing counts as deleted`,
  'brake.massDeleteDetected': (p: { gone: number; tracked: number }) =>
    `Mass deletion detected: ${p.gone} of ${p.tracked} files are missing locally – really deleted?`,
  'brake.massDeleteWaiting': (p: { count: number }) =>
    `Mass deletion held: ${p.count} deletions are waiting for approval or rejection`,
  'brake.massDeleteHeld': (p: { count: number; tracked: number; local: number; remote: number }) =>
    `Mass deletion held: ${p.count} of ${p.tracked} files would be deleted (${p.local} deleted locally → Proton ` +
    `trash, ${p.remote} deleted in Proton → local trash) – please approve or reject`,
  'brake.massDeleteHeldShort': () => 'Mass deletion held',

  // ---------------------------------------------------------------- job states (JobDto.lastErrorMsg)
  /** `reason` is a nested message (gate.*, guard.*) or a plain text */
  'job.waiting': (p: { reason: string }) => `waiting: ${p.reason}`,
  'job.abortedPause': (p: { error: string }) => `aborted (pause): ${p.error}`,
  'job.nameTaken': () => 'Name already taken in Proton – uploading under a new name',

  // ---------------------------------------------------------------- new-pair preview (PairPreviewDto.warningMsgs)
  'preview.accountNotReady': (p: { account: string; status: string }) =>
    `Account ${p.account} is not ready (${p.status}); the Proton folder is checked on the first run`,
  'preview.folderUnreadable': (p: { path: string }) => `Folder not readable: ${p.path}`,
  'preview.truncatedLocal': (p: { max: number }) => `Preview incomplete: more than ${p.max} local files`,
  'preview.remoteMissing': (p: { path: string }) =>
    `Proton folder ${p.path} does not exist yet – everything will be uploaded`,
  'preview.remoteNotChecked': () => 'Proton side not checked (account not ready)',
  'preview.truncatedRemote': (p: { max: number }) => `Preview incomplete: more than ${p.max} Proton folders`,
  'preview.sizeOnly': (p: { count: number }) => `${p.count} files compared by size only (checksum budget used up)`,
  'preview.nestedInner': (p: { pair: string; path: string }) =>
    `Sub folder of pair "${p.pair}": "${p.path}" is excluded there and belongs to this pair`,
  'preview.nestedOuter': (p: { pair: string; path: string }) =>
    `Pair "${p.pair}" lies in this folder: "${p.path}" is excluded here (it belongs to "${p.pair}")`,

  // ---------------------------------------------------------------- storage areas (StorageDto.areas[].labelMsg)
  'storage.myFiles': () => 'My files',
  'storage.trash': () => 'Trash',
} satisfies Record<string, (p: never) => string>;

export type DaemonMessages = typeof DAEMON_MESSAGES_EN;
export type MsgKey = keyof DaemonMessages;
export type MsgParamsOf<K extends MsgKey> = Parameters<DaemonMessages[K]>[0] extends undefined
  ? undefined
  : Parameters<DaemonMessages[K]>[0];

/** A message reference plus its English text. */
export interface Msg extends MsgRef {
  text: string;
}

/** Builds a typed message: `msg('doctor.mounted', { path })`. */
export function msg<K extends MsgKey>(key: K, ...params: Parameters<DaemonMessages[K]>): Msg {
  const p = params[0] as MsgParams | undefined;
  const fn = DAEMON_MESSAGES_EN[key] as (p?: MsgParams) => string;
  return { key, ...(p ? { params: p } : {}), text: fn(expandParams(p, renderMsg)) };
}

/** English text of a reference (null for unknown keys). */
export function renderMsg(ref: MsgRef): string | null {
  return renderWith(DAEMON_MESSAGES_EN as unknown as MessageTable, ref);
}

type MessageTable = Record<string, ((p?: MsgParams) => string) | undefined>;

/**
 * Text of a reference in any message table (the UI passes its `t.daemon`); nested params are rendered with the same
 * table. Null for unknown keys, throwing functions and empty results.
 */
export function renderWith(table: MessageTable, ref: MsgRef, depth = 0): string | null {
  const fn = Object.hasOwn(table, ref.key) ? table[ref.key] : undefined;
  if (typeof fn !== 'function' || depth > 4) return null;
  try {
    return fn(expandParams(ref.params, (r) => renderWith(table, r, depth + 1))) || null;
  } catch {
    return null;
  }
}

const PREFIX = 'msg:';

/**
 * A param value that is itself a message, e.g. the reason inside "Safety brake: <reason>": `msg('activity.brake',
 * { reason: nested(reasonMsg) })`. It is stored encoded (`msg:{…}`) and rendered in the reader's language. Plain
 * strings pass through unchanged.
 */
export function nested(m: Msg | MsgRef | string | null | undefined): string {
  if (m == null) return '';
  return typeof m === 'string' ? m : encodeMsg(m);
}

/** Params with nested messages (see `nested`) replaced by their rendering (unknown keys: the key). */
export function expandParams(
  params: MsgParams | undefined,
  render: (ref: MsgRef) => string | null,
): MsgParams | undefined {
  if (!params) return params;
  let out: MsgParams | undefined;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'string' || !v.startsWith(`${PREFIX}{`)) continue;
    const ref = parseRef(v);
    if (ref) (out ??= { ...params })[k] = render(ref) ?? ref.key;
  }
  return out ?? params;
}

function parseRef(stored: string): MsgRef | null {
  try {
    const ref = JSON.parse(stored.slice(PREFIX.length)) as MsgRef;
    return typeof ref?.key === 'string' ? ref : null;
  } catch {
    return null;
  }
}

/** A plain text or a message (`Engine.addActivity`, account errors, …). */
export type TextOrMsg = string | Msg;

export function isMsg(v: unknown): v is Msg {
  return (
    typeof v === 'object' && v !== null && typeof (v as Msg).key === 'string' && typeof (v as Msg).text === 'string'
  );
}

/** English text of a plain text or message. */
export function textOf(v: TextOrMsg): string;
export function textOf(v: TextOrMsg | null | undefined): string | null;
export function textOf(v: TextOrMsg | null | undefined): string | null {
  return v == null ? null : typeof v === 'string' ? v : v.text;
}

/** Value for a TEXT column: messages encoded (`encodeMsg`), plain texts unchanged. */
export function storeMsg(v: TextOrMsg | null | undefined): string | null {
  return v == null ? null : typeof v === 'string' ? v : encodeMsg(v);
}

/** Strips `text` so only the reference travels next to the English text field. */
export function refOf(m: Msg | MsgRef | null | undefined): MsgRef | null {
  if (!m) return null;
  return m.params ? { key: m.key, params: m.params } : { key: m.key };
}

/** For TEXT columns that hold either a plain string or a message: `msg:{"key":…,"params":…}`. */
export function encodeMsg(m: Msg | MsgRef): string {
  return PREFIX + JSON.stringify(refOf(m));
}

/** Reads a TEXT column written by `encodeMsg` (or a plain string) back as English text + optional reference. */
export function decodeMsg(stored: string | null | undefined): { text: string | null; msg: MsgRef | null } {
  if (stored == null) return { text: null, msg: null };
  if (!stored.startsWith(PREFIX)) return { text: stored, msg: null };
  const ref = parseRef(stored);
  return ref ? { text: renderMsg(ref) ?? ref.key, msg: ref } : { text: stored, msg: null };
}
