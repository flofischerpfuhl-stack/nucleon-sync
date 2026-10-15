// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { decodeApiError, encodeApiError, isAllowedApiRequest, isAllowedExternalUrl } from '../src/common/ipc.ts';
import { deriveTrayState } from '../src/common/trayState.ts';
import { renderIcon } from '../src/main/icons.ts';
import { chooseTheme, parseKdeTheme } from '../src/main/theme.ts';
import { status } from './helpers.ts';

describe('IPC allowlist', () => {
  it('accepts /v1/ API paths only', () => {
    expect(isAllowedApiRequest('GET', '/v1/status')).toBe(true);
    expect(isAllowedApiRequest('GET', '/v1/activity?limit=50&account=sam&since=2026-10-10T00:00:00.000Z')).toBe(true);
    expect(isAllowedApiRequest('PUT', '/v1/pairs/1/rules')).toBe(true);
    expect(isAllowedApiRequest('GET', '/v1/pairs/1/tree?path=Projects%2Fnucleon-sync')).toBe(true); // query may carry paths
    expect(isAllowedApiRequest('GET', '/v1/pairs%2F..%2Fx')).toBe(false); // encoded separator in the path
    expect(isAllowedApiRequest('GET', '/etc/passwd')).toBe(false);
    expect(isAllowedApiRequest('GET', '/v1/../secret')).toBe(false);
    expect(isAllowedApiRequest('GET', 'http://evil/v1/status')).toBe(false);
    expect(isAllowedApiRequest('TRACE', '/v1/status')).toBe(false);
    expect(isAllowedApiRequest('GET', 42)).toBe(false);
  });
  it('external URLs: https proton.me only', () => {
    expect(isAllowedExternalUrl('https://account.proton.me/authorize?x=1')).toBe(true);
    expect(isAllowedExternalUrl('https://drive.proton.me/')).toBe(true);
    expect(isAllowedExternalUrl('http://account.proton.me/')).toBe(false);
    expect(isAllowedExternalUrl('https://proton.me.evil.com/')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
  });
  it('API errors survive the IPC boundary', () => {
    const msg = `Error invoking remote method 'ps:request': Error: ${encodeApiError(409, '{"confirmToken":"t"}')}`;
    expect(decodeApiError(msg)).toEqual({ status: 409, body: '{"confirmToken":"t"}' });
    expect(decodeApiError('boom')).toBeNull();
  });
});

describe('tray state', () => {
  it('maps daemon state to icon state', () => {
    expect(deriveTrayState(status(), 'connected')).toBe('idle');
    expect(deriveTrayState(status(), 'disconnected')).toBe('error');
    expect(deriveTrayState(null, 'connecting')).toBe('error');
    expect(deriveTrayState(status({ state: 'syncing' }), 'connected')).toBe('syncing');
    expect(deriveTrayState(status({ paused: true, state: 'paused' }), 'connected')).toBe('paused');
    expect(deriveTrayState(status({ openConflicts: 2 }), 'connected')).toBe('attention');
    expect(deriveTrayState(status({ state: 'offline' }), 'connected')).toBe('error');
    const s = status();
    s.accounts[0]!.status = 'needs_login';
    expect(deriveTrayState(s, 'connected')).toBe('attention');
  });
  it('renders anti-aliased icons with a transparent corner and a white glyph', () => {
    for (const st of ['idle', 'syncing', 'paused', 'attention', 'error'] as const) {
      const b = renderIcon(st, 32);
      expect(b.data.length).toBe(32 * 32 * 4);
      expect(b.data[3]).toBe(0); // corner alpha
      const center = (16 * 32 + 16) * 4;
      expect(b.data[center + 3]).toBe(255);
    }
    const p = renderIcon('paused', 64);
    // left pause bar at x≈0.41 is white
    const i = (32 * 64 + Math.round(0.41 * 64)) * 4;
    expect([p.data[i], p.data[i + 1], p.data[i + 2]]).toEqual([255, 255, 255]);
  });
});

describe('theme', () => {
  it('follows the KDE colour scheme', () => {
    expect(
      parseKdeTheme('[Colors:View]\nBackgroundNormal=250,250,250\n[Colors:Window]\nBackgroundNormal=49,45,54\n'),
    ).toBe('dark');
    expect(parseKdeTheme('[Colors:Window]\nBackgroundNormal=239,240,241\n')).toBe('light');
    expect(parseKdeTheme('[General]\nfoo=1')).toBeNull();
    expect(chooseTheme({}, null)).toBe('system');
    expect(chooseTheme({ NUCLEON_SYNC_UI_THEME: 'light' }, '[Colors:Window]\nBackgroundNormal=0,0,0')).toBe('light');
  });
});
