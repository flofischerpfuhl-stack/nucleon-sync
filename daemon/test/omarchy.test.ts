// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * packaging/omarchy: the installer adds the bar module + menu block idempotently and removes them cleanly (fake
 * HOME with the Omarchy 4 file shapes); nucleon-sync-bar prints the daemon's bar file or "stopped".
 * Needs bash, jq and GNU sed (all present on Omarchy and on the dev PC).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT, tmp } from './helpers.ts';

const DIR = path.join(ROOT, 'packaging/omarchy');
const INSTALL = path.join(DIR, 'nucleon-sync-omarchy');
const BAR = path.join(DIR, 'nucleon-sync-bar');
const hasJq = spawnSync('jq', ['--version']).status === 0;

/** shape of ~/.config/omarchy/shell.json on Omarchy 4.0.4 */
const SHELL_JSON = {
  version: 1,
  idle: { screensaver: 150, lock: 300 },
  bar: {
    position: 'top',
    layout: {
      left: [{ id: 'omarchy.menu' }, { id: 'omarchy.workspaces' }],
      center: [{ id: 'omarchy.clock', format: 'dddd HH:mm' }],
      right: [{ id: 'omarchy.tray' }, { id: 'omarchy.network' }, { id: 'omarchy.power' }],
    },
  },
  plugins: [],
};
/** user extension file as shipped (comments only) plus one entry of the user */
const MENU = `{
  // Extend the Quickshell Omarchy menu with JSONC.
  // "personal": {"icon":"","label":"Personal"},
  "personal": {"icon":"x","label":"Personal"},
  "personal.notes": {"icon":"y","label":"Notes","action":"omarchy-launch-editor ~/notes"}
}
`;

/** what the Omarchy menu parser does (MenuModel.stripJsonc + JSON.parse) */
function parseMenu(text: string): Record<string, { label?: string; action?: string; when?: string }> {
  const stripped = text.replace(/^\s*\/\/[^\n]*(\n|$)/gm, '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as Record<string, { label?: string; action?: string; when?: string }>;
}

function run(home: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', XDG_RUNTIME_DIR: path.join(home, 'run') },
  });
  return { code: r.status ?? 1, out: r.stdout + r.stderr };
}

describe.skipIf(!hasJq)('nucleon-sync-omarchy installer', () => {
  it('install is idempotent and keeps the user config; uninstall removes exactly our parts', () => {
    const home = tmp('omarchy-');
    const cfg = path.join(home, '.config/omarchy');
    mkdirSync(path.join(cfg, 'extensions'), { recursive: true });
    writeFileSync(path.join(cfg, 'shell.json'), JSON.stringify(SHELL_JSON, null, 2));
    writeFileSync(path.join(cfg, 'extensions/omarchy-menu.jsonc'), MENU);

    const a = run(home, 'install');
    expect(a.code, a.out).toBe(0);
    const b = run(home, 'install');
    expect(b.code, b.out).toBe(0);

    const shell = JSON.parse(readFileSync(path.join(cfg, 'shell.json'), 'utf8')) as typeof SHELL_JSON;
    const right = shell.bar.layout.right as { id: string; type?: string; exec?: string; onClick?: string }[];
    expect(right.map((x) => x.id)).toEqual(['nucleon-sync', 'omarchy.tray', 'omarchy.network', 'omarchy.power']);
    expect(right[0]).toMatchObject({ type: 'command', onRightClick: 'nucleon-sync pause --toggle' });
    expect(right[0]!.exec).toMatch(/nucleon-sync-bar omarchy$/);
    expect(shell.idle).toEqual(SHELL_JSON.idle);

    const menuText = readFileSync(path.join(cfg, 'extensions/omarchy-menu.jsonc'), 'utf8');
    expect(menuText.match(/>>> nucleon-sync/g)).toHaveLength(1);
    const menu = parseMenu(menuText);
    expect(menu['personal.notes']?.label).toBe('Notes');
    expect(menu['nucleon-sync']?.label).toBe('Nucleon Sync');
    expect(menu['nucleon-sync.sync']?.action).toBe('nucleon-sync sync >/dev/null');
    expect(menu['nucleon-sync.pause']?.when).toMatch(/^! .*nucleon-sync-bar --is-paused$/);
    expect(Object.keys(menu).filter((k) => k.startsWith('nucleon-sync'))).toHaveLength(6);
    // a backup of the original files
    expect(readFileSync(path.join(cfg, 'extensions/omarchy-menu.jsonc.nucleon-sync.bak'), 'utf8')).toBe(MENU);

    const st = run(home, 'status');
    expect(st.out).toContain('bar entry:   yes');
    expect(st.out).toContain('menu block:  yes');

    const u = run(home, 'uninstall');
    expect(u.code, u.out).toBe(0);
    expect(JSON.parse(readFileSync(path.join(cfg, 'shell.json'), 'utf8'))).toEqual(SHELL_JSON);
    expect(readFileSync(path.join(cfg, 'extensions/omarchy-menu.jsonc'), 'utf8')).toBe(MENU);
  });

  it('creates missing files, refuses to break a menu file it cannot parse, --dry-run writes nothing', () => {
    const home = tmp('omarchy-');
    const dry = run(home, 'install', '--dry-run');
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain('would write');
    expect(spawnSync('test', ['-e', path.join(home, '.config/omarchy/shell.json')]).status).toBe(1);

    const ok = run(home, 'install');
    expect(ok.code, ok.out).toBe(0);
    expect(
      parseMenu(readFileSync(path.join(home, '.config/omarchy/extensions/omarchy-menu.jsonc'), 'utf8')),
    ).toHaveProperty('nucleon-sync.open');

    const broken = tmp('omarchy-');
    mkdirSync(path.join(broken, '.config/omarchy/extensions'), { recursive: true });
    const bad = '{\n  "a": {"label": "x"} "b": {}\n}\n';
    writeFileSync(path.join(broken, '.config/omarchy/extensions/omarchy-menu.jsonc'), bad);
    const r = run(broken, 'install', '--no-bar');
    expect(r.code).toBe(1);
    expect(r.out).toContain('would not parse');
    expect(readFileSync(path.join(broken, '.config/omarchy/extensions/omarchy-menu.jsonc'), 'utf8')).toBe(bad);
  });

  it('German labels with a German locale', () => {
    const home = tmp('omarchy-');
    spawnSync('bash', [INSTALL, 'install', '--no-bar'], {
      env: { PATH: process.env.PATH, HOME: home, LANG: 'de_DE.UTF-8' },
    });
    const menu = parseMenu(readFileSync(path.join(home, '.config/omarchy/extensions/omarchy-menu.jsonc'), 'utf8'));
    expect(menu['nucleon-sync.sync']?.label).toBe('Jetzt synchronisieren');
  });
});

describe('nucleon-sync-bar', () => {
  it('prints the fresh bar file, "stopped" for a missing or stale one; --is-paused', () => {
    const home = tmp('bar-');
    const env = { PATH: process.env.PATH, NUCLEON_SYNC_HOME: home };
    const sh = (...a: string[]) => spawnSync('sh', [BAR, ...a], { env, encoding: 'utf8' });
    expect(JSON.parse(sh().stdout)).toMatchObject({ alt: 'stopped', class: 'stopped' });
    expect(JSON.parse(sh('omarchy').stdout)).toMatchObject({ alt: 'stopped', class: 'active' });
    mkdirSync(path.join(home, 'run'), { recursive: true });
    const f = path.join(home, 'run/bar.json');
    writeFileSync(f, '{"text":"x","alt":"paused","class":"paused","tooltip":"Nucleon Sync: Paused"}\n');
    writeFileSync(
      path.join(home, 'run/bar-omarchy.json'),
      '{"text":"x","alt":"paused","class":"paused","tooltip":"Nucleon Sync: Paused\\nA: OK"}\n',
    );
    expect(JSON.parse(sh().stdout).alt).toBe('paused');
    expect(sh('--is-paused').status).toBe(0);
    expect(sh('--tooltip').stdout).toBe('Nucleon Sync: Paused\nA: OK\n');
    // older than a minute = the daemon is gone
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(f, old, old);
    expect(JSON.parse(sh().stdout).alt).toBe('stopped');
    expect(sh('--is-paused').status).not.toBe(0);
    expect(execFileSync('sh', ['-n', BAR]).toString()).toBe('');
  });
});
