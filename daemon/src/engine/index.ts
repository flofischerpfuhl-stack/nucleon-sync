// SPDX-License-Identifier: GPL-3.0-or-later
/** Engine factory (owns the implementation behind it; main.ts only calls createEngine). */
import type { EngineApi } from './api.ts';
import { Engine, type EngineOptions } from './engine.ts';

export type { EngineApi } from './api.ts';
export type { EngineOptions } from './engine.ts';

export function createEngine(opts: EngineOptions): EngineApi {
  return new Engine(opts);
}
