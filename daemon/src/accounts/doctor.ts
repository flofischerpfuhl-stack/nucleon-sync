// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `doctor` checks (GET /v1/doctor, `nucleon-sync doctor`). Strictly read-only and safe on the real PC while other
 * Proton work runs: it never starts a proton-drive process (the CLI binary is only stat'ed), never reads a secret
 * (keyring presence via the shim's `has` = D-Bus SearchItems), never creates files or directories.
 * Usable without a running daemon (the CLI client calls it in-process when the API is unreachable).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { msg, nested, refOf, type DoctorCheck, type Msg, type NucleonSyncPaths } from '@nucleon-sync/shared';

import { binaryFingerprint } from '../cli/compat.ts';
import type { AccountRow } from '../db/repo.ts';
import { PLAIN_CLI_SECRET } from './context.ts';
import { foreignCliProcesses, sessionState } from './keyring.ts';

export interface DoctorInput {
  env: NodeJS.ProcessEnv;
  paths: NucleonSyncPaths;
  cliPath: string;
  mode: 'production' | 'mock';
  accounts: Pick<AccountRow, 'id' | 'display_name' | 'credential_backend' | 'secret_service' | 'secret_key'>[];
  pairs: { name: string; local_root: string; enabled: number | boolean }[];
  stagingDir: string;
  secretFileDir?: string;
  /** null = not checked (doctor without a running daemon) */
  api: { reachable: boolean; detail: string } | null;
  /** last version check result of the engine, if any */
  cliVersion?: string | null;
  writeGuard?: string | Msg | null;
  /** paths that must be mount points (daemon.json requiredMounts) */
  requiredMounts?: string[];
  /** /proc (tests) */
  procDir?: string;
}

const check = (id: string, ok: boolean, severity: DoctorCheck['severity'], m: Msg): DoctorCheck => ({
  id,
  ok,
  severity: ok ? 'info' : severity,
  message: m.text,
  msg: refOf(m)!,
});

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(':').some((d) => {
    try {
      accessSync(path.join(d, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function isMountPoint(p: string): boolean {
  try {
    const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .map((l) => l.split(' ')[4]?.replace(/\\040/g, ' '));
    return mounts.includes(p);
  } catch {
    return false;
  }
}

export function runDoctor(i: DoctorInput): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const prod = i.mode === 'production';
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  // the packaged app runs the bundled daemon on Electron's Node (24, node:sqlite built in)
  const bundled = !!process.versions.electron;
  const nodeOk = nodeMajor >= 26 || (bundled && nodeMajor >= 24);
  out.push(
    check(
      'node',
      nodeOk,
      'error',
      msg('doctor.node', {
        version: process.versions.node,
        electron: process.versions.electron ?? '',
        ok: nodeOk ? 1 : 0,
      }),
    ),
  );

  // CLI binary: stat only, never executed here
  const fp = binaryFingerprint(i.cliPath);
  let exec = false;
  try {
    accessSync(i.cliPath, constants.X_OK);
    exec = true;
  } catch {
    /* missing or not executable */
  }
  out.push(
    check(
      'cli_version',
      !!fp && exec,
      'error',
      !fp
        ? msg('doctor.cliMissing', { path: i.cliPath })
        : !exec
          ? msg('doctor.cliNotExecutable', { path: i.cliPath })
          : msg('doctor.cliPresent', {
              path: i.cliPath,
              mb: Math.round(statSync(i.cliPath).size / 1e6),
              version: i.cliVersion ?? '',
            }),
    ),
  );

  // keyring: presence only (D-Bus SearchItems / mock file), no secret is read
  const hasSecretTool = onPath('secret-tool', i.env);
  const hasBusctl = onPath('busctl', i.env);
  const usesKeyring = i.accounts.some((a) => a.credential_backend === 'keyring-shim');
  if (prod && usesKeyring)
    out.push(
      check(
        'secret_tools',
        hasSecretTool && hasBusctl,
        'error',
        hasSecretTool && hasBusctl
          ? msg('doctor.secretToolsOk')
          : msg('doctor.secretToolsMissing', {
              missing: [!hasSecretTool && 'secret-tool', !hasBusctl && 'busctl'].filter(Boolean).join(', '),
            }),
      ),
    );
  for (const a of i.accounts) {
    const st = sessionState(a, i.env, i.secretFileDir, i.paths);
    const adopted = a.secret_service === PLAIN_CLI_SECRET.service;
    // nested message: the dashboard shows it in its own language
    const where = nested(
      a.credential_backend === 'mock'
        ? msg('doctor.where.mock')
        : a.credential_backend === 'encfile'
          ? msg('doctor.where.encfile')
          : adopted
            ? msg('doctor.where.adopted')
            : msg('doctor.where.keyring'),
    );
    const name = a.display_name;
    out.push(
      check(
        `keyring:${a.id}`,
        st === 'present',
        st === 'locked' ? 'warn' : 'error',
        st === 'present'
          ? msg('doctor.sessionPresent', { name, where })
          : st === 'locked'
            ? msg('doctor.sessionLocked', { name })
            : st === 'missing'
              ? msg('doctor.sessionMissing', { name, where })
              : msg('doctor.sessionUnavailable', { name }),
      ),
    );
  }
  if (!i.accounts.length) out.push(check('accounts', false, 'warn', msg('doctor.noAccounts')));

  // foreign proton-drive processes that use one of our sessions (manual CLI calls, scripts)
  if (prod) {
    const procs = foreignCliProcesses(i.cliPath, i.procDir);
    out.push(
      check(
        'foreign_cli',
        procs.length === 0,
        'warn',
        procs.length
          ? msg('doctor.foreignCli', {
              count: procs.length,
              pids: procs.map((p) => p.pid).join(', '),
              command: procs[0]!.command,
            })
          : msg('doctor.noForeignCli'),
      ),
    );
  }

  // required mount points (daemon.json), free space, staging dir
  for (const m of i.requiredMounts ?? []) {
    const mounted = isMountPoint(m);
    out.push(
      check(
        `mount:${m}`,
        mounted,
        'error',
        mounted ? msg('doctor.mounted', { path: m }) : msg('doctor.notMounted', { path: m }),
      ),
    );
  }
  const firstRoot = i.pairs.find((p) => p.enabled && existsSync(p.local_root))?.local_root;
  const spaceRoot = firstRoot ?? i.paths.stateDir;
  try {
    const s = statfsSync(existsSync(spaceRoot) ? spaceRoot : path.dirname(spaceRoot));
    const free = s.bavail * s.bsize;
    const pct = (s.bavail / s.blocks) * 100;
    out.push(
      check(
        'disk_space',
        pct >= 10,
        pct < 5 ? 'error' : 'warn',
        msg('doctor.diskSpace', { path: spaceRoot, free, percent: Math.round(pct * 10) / 10 }),
      ),
    );
  } catch (e) {
    out.push(check('disk_space', false, 'warn', msg('doctor.diskSpaceUnknown', { error: (e as Error).message })));
  }
  const stagingParent = existsSync(i.stagingDir) ? i.stagingDir : path.dirname(i.stagingDir);
  let stagingOk = false;
  let stagingMsg: Msg;
  try {
    accessSync(stagingParent, constants.W_OK);
    stagingOk = true;
    const dev = statSync(stagingParent).dev;
    const other = i.pairs.filter((p) => p.enabled && existsSync(p.local_root) && statSync(p.local_root).dev !== dev);
    if (other.length) {
      stagingOk = false;
      stagingMsg = msg('doctor.stagingOtherFs', {
        dir: i.stagingDir,
        roots: other.map((p) => p.local_root).join(', '),
      });
    } else stagingMsg = msg('doctor.stagingOk', { dir: i.stagingDir, exists: existsSync(i.stagingDir) ? 1 : 0 });
  } catch {
    stagingMsg = msg('doctor.stagingNotWritable', { dir: stagingParent });
  }
  out.push(check('staging_dir', stagingOk, 'warn', stagingMsg));

  // pair roots
  for (const p of i.pairs.filter((x) => x.enabled)) {
    const ok = existsSync(p.local_root) && statSync(p.local_root).isDirectory();
    out.push(
      check(
        `pair_root:${p.name}`,
        ok,
        'error',
        ok ? msg('doctor.pairRootOk', { path: p.local_root }) : msg('doctor.pairRootMissing', { path: p.local_root }),
      ),
    );
  }

  // our systemd user unit (information only)
  if (prod) {
    const unit = path.join(
      i.env.XDG_CONFIG_HOME || path.join(i.env.HOME || homedir(), '.config'),
      'systemd/user/nucleon-sync.service',
    );
    const packaged = existsSync('/usr/lib/systemd/user/nucleon-sync.service');
    if (existsSync(unit) || packaged) {
      const en = spawnSync('systemctl', ['--user', 'is-enabled', 'nucleon-sync.service'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      out.push(check('service', true, 'info', msg('doctor.unitInstalled', { state: (en.stdout || '?').trim() })));
    } else out.push(check('service', true, 'info', msg('doctor.unitMissing')));
  }

  // inotify (near-real-time mode later), write mode, API
  try {
    const w = Number(readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim());
    out.push(check('inotify', w >= 524_288, 'info', msg('doctor.inotify', { value: w })));
  } catch {
    /* not Linux */
  }
  if (i.writeGuard !== undefined)
    out.push(
      typeof i.writeGuard === 'string'
        ? { id: 'write_mode', ok: true, severity: 'info', message: i.writeGuard }
        : check('write_mode', true, 'info', i.writeGuard ?? msg('doctor.writesAllowed')),
    );
  for (const [id, f] of [
    ['token_ui', i.paths.tokenFile],
    ['token_agent', i.paths.agentTokenFile],
  ] as const) {
    if (!existsSync(f)) continue;
    const mode = statSync(f).mode & 0o777;
    out.push(
      check(id, mode === 0o600, 'warn', msg('doctor.tokenMode', { file: path.basename(f), mode: mode.toString(8) })),
    );
  }
  if (i.api)
    out.push(
      i.api.reachable
        ? check('api', true, 'info', msg('doctor.apiOk'))
        : check('api', false, 'warn', msg('doctor.apiOffline', { detail: i.api.detail })),
    );
  return out;
}

/** Exit code of `nucleon-sync doctor`: 1 if any error-severity check failed. */
export function doctorFailed(checks: DoctorCheck[]): boolean {
  return checks.some((c) => !c.ok && c.severity === 'error');
}
