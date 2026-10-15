// SPDX-License-Identifier: GPL-3.0-or-later
/** Parser contract: CLI 0.9.0 output shapes (fixtures) and the mock's output go through the same strict parser. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyCliError } from '../../src/cli/classify.ts';
import {
  parseDevices,
  parseNode,
  parseNodeList,
  parseTransferSummary,
  RemoteParseError,
} from '../../src/engine/remote.ts';
import { MOCK_BIN, mockAccount, tmp } from '../helpers.ts';

const fx = (n: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', n), 'utf8');

describe('contract: CLI 0.9.0 fixtures', () => {
  it('list -j of a folder: folder, file with digest, digest-less file, undecryptable name, Proton Doc', () => {
    const nodes = parseNodeList(JSON.parse(fx('list-folder.json')));
    expect(nodes).toHaveLength(5);
    const [folder, file, digestless, broken, doc] = nodes;
    expect(folder).toMatchObject({ type: 'folder', name: '01_Rechnungen', rev: null, trashed: false });
    expect(file!.name).toBe('Kündigung Müller.docx'); // NFC
    expect(file!.rev).toMatchObject({
      size: 13960,
      sha1: 'da59e0dc4f3b956885c455c619314dad046b6049', // lower-cased
      mtimeMs: Date.parse('2022-06-07T07:03:30.116Z'),
      storageSize: 14010,
    });
    expect(file!.totalStorageSize).toBe(28019);
    expect(digestless!.rev!.sha1).toBeNull();
    expect(broken!.name).toBeNull();
    expect(broken!.rev!.mtimeMs).toBeNull();
    expect(doc!.isProtonDoc).toBe(true);
  });
  it('/devices, size, upload summary, error texts', () => {
    const devs = parseDevices(JSON.parse(fx('list-devices.json')));
    expect(devs.map((d) => d.name)).toEqual(['Workstation', 'Laptop']);
    expect(devs[0]!.rootFolderUid).toMatch(/~/);
    expect(JSON.parse(fx('size.json'))).toEqual({ size: 61234567890, numberOfDescendants: 31415 });
    const sum = parseTransferSummary(`some progress output\n${fx('upload-summary.json')}`)!;
    expect(sum).toMatchObject({ transferredItems: 2, skippedItems: 1, failedItems: 1 });
    expect(sum.failures[0]!.error).toMatch(/Name conflict/);
    for (const line of fx('errors.tsv').trim().split('\n')) {
      const [text, cls] = line.split('\t');
      expect(classifyCliError(text!), text).toBe(cls);
    }
  });
  it('strictness: malformed nodes are rejected instead of guessed', () => {
    expect(() => parseNode({ name: { ok: true, value: 'x' } })).toThrow(RemoteParseError);
    expect(() => parseNode({ uid: 'u', type: 'file', name: { ok: true, value: 'x' } })).toThrow(/activeRevision/);
    expect(() => parseNodeList({})).toThrow(RemoteParseError);
  });
});

describe('contract: the mock produces the same shapes', () => {
  it('mock list/info/devices output parses and uses only fields the real CLI has', () => {
    const { env } = mockAccount(tmp());
    const run = (...a: string[]) => JSON.parse(execFileSync(MOCK_BIN, [...a, '-j'], { env, encoding: 'utf8' }));
    const list = run('filesystem', 'list', '/devices/Workstation/Documents') as Record<string, unknown>[];
    const nodes = parseNodeList(list);
    expect(nodes.some((n) => n.type === 'file' && n.rev?.sha1)).toBe(true);
    const realKeys = new Set(
      (JSON.parse(fx('list-folder.json')) as Record<string, unknown>[]).flatMap((o) => Object.keys(o)),
    );
    for (const o of list) for (const k of Object.keys(o)) expect(realKeys.has(k), `mock-only field ${k}`).toBe(true);
    const realRev = new Set(
      Object.keys((JSON.parse(fx('list-folder.json'))[1] as { activeRevision: object }).activeRevision),
    );
    for (const o of list.filter((x) => x.activeRevision))
      for (const k of Object.keys(o.activeRevision as object))
        expect(realRev.has(k), `mock-only revision field ${k}`).toBe(true);
    parseNode(run('filesystem', 'info', '/devices/Workstation/Documents/a.txt'));
    expect(parseDevices(run('filesystem', 'list', '/devices'))[0]!.name).toBe('Workstation');
    expect(run('filesystem', 'size', '/devices/Workstation/Documents')).toMatchObject({
      size: expect.any(Number),
      numberOfDescendants: 3,
    });
  });
});
