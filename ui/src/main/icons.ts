// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tray/app icon rasteriser (pure TypeScript, no image files, no Electron import -> unit-testable).
 * Draws a filled circle in the state colour with a white glyph using signed distance fields (anti-aliased).
 * Output: BGRA bitmap as expected by Electron's nativeImage.createFromBitmap.
 */
import { TRAY_COLORS, type TrayState } from '../common/trayState.ts';

export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

type Sdf = (x: number, y: number) => number;

const capsule =
  (ax: number, ay: number, bx: number, by: number, r: number): Sdf =>
  (x, y) => {
    const pax = x - ax;
    const pay = y - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * h, pay - bay * h) - r;
  };

const disc =
  (cx: number, cy: number, r: number): Sdf =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;

/** ring segment centred at (0.5,0.5): radius r, half stroke w, from angle a0 spanning `span` radians */
const arc =
  (r: number, w: number, a0: number, span: number): Sdf =>
  (x, y) => {
    const dx = x - 0.5;
    const dy = y - 0.5;
    let a = Math.atan2(dy, dx) - a0;
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (a <= span) return Math.abs(Math.hypot(dx, dy) - r) - w;
    const e0x = 0.5 + r * Math.cos(a0);
    const e0y = 0.5 + r * Math.sin(a0);
    const e1x = 0.5 + r * Math.cos(a0 + span);
    const e1y = 0.5 + r * Math.sin(a0 + span);
    return Math.min(Math.hypot(x - e0x, y - e0y), Math.hypot(x - e1x, y - e1y)) - w;
  };

const union =
  (...f: Sdf[]): Sdf =>
  (x, y) =>
    Math.min(...f.map((g) => g(x, y)));

export function glyph(state: TrayState, frame = 0): Sdf {
  const w = 0.055;
  switch (state) {
    case 'idle':
      // the nucleus of the app icon: four nucleons
      return union(
        disc(0.415, 0.415, 0.105),
        disc(0.585, 0.425, 0.105),
        disc(0.41, 0.585, 0.105),
        disc(0.58, 0.58, 0.105),
      );
    case 'syncing': {
      const rot = (frame / 8) * Math.PI;
      const span = (130 / 180) * Math.PI;
      return union(arc(0.24, w, rot, span), arc(0.24, w, rot + Math.PI, span));
    }
    case 'paused':
      return union(capsule(0.41, 0.34, 0.41, 0.66, w + 0.01), capsule(0.59, 0.34, 0.59, 0.66, w + 0.01));
    case 'attention':
      return union(capsule(0.5, 0.29, 0.5, 0.55, w + 0.01), disc(0.5, 0.7, 0.065));
    case 'error':
      return union(capsule(0.36, 0.36, 0.64, 0.64, w), capsule(0.64, 0.36, 0.36, 0.64, w));
  }
}

export function renderIcon(state: TrayState, size: number, frame = 0): Bitmap {
  const [r, g, b] = TRAY_COLORS[state];
  const data = Buffer.alloc(size * size * 4);
  const bg = disc(0.5, 0.5, 0.47);
  const fg = glyph(state, frame);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const cb = Math.max(0, Math.min(1, 0.5 - bg(x, y) * size));
      const cg = Math.max(0, Math.min(1, 0.5 - fg(x, y) * size));
      const i = (py * size + px) * 4;
      data[i] = Math.round(b + (255 - b) * cg);
      data[i + 1] = Math.round(g + (255 - g) * cg);
      data[i + 2] = Math.round(r + (255 - r) * cg);
      data[i + 3] = Math.round(255 * cb);
    }
  return { width: size, height: size, data };
}

export const SYNC_FRAMES = 8;
