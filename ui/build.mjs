// SPDX-License-Identifier: GPL-3.0-or-later
// Bundles Electron main (CJS), preload (CJS, sandbox-compatible) and renderer (ESM, browser) with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('out', { recursive: true });
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2024' };

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'out/main.cjs',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/main/preload.ts'],
    outfile: 'out/preload.cjs',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/app.tsx'],
    outfile: 'out/renderer.js',
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
]);
cpSync('src/renderer/index.html', 'out/index.html');
cpSync('src/renderer/styles.css', 'out/styles.css');
if (watch) console.log('watch mode not implemented in skeleton; rerun build');
