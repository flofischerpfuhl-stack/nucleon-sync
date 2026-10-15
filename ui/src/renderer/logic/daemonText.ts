// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Texts produced by the sync service in the UI language. The service sends English text plus a message key + params
 * (shared/src/messages.ts); the UI translates the key with `t.daemon` and falls back to the English text for keys it
 * does not know (newer service), rows written before keys existed and plain CLI error texts.
 */
import type { MsgRef } from '@nucleon-sync/shared';

import { t } from '../i18n/index.ts';
import { renderWith } from '../shared.ts';

type Table = Parameters<typeof renderWith>[0];

/** `text` translated via `ref` when the active language knows the key, else `text` itself ('' for null). */
export function daemonText(text: string | null | undefined, ref?: MsgRef | null): string {
  if (ref && typeof ref.key === 'string') {
    const s = renderWith(t.daemon as unknown as Table, ref);
    // missing or wrongly typed params (e.g. an older service) must not show "undefined"/"NaN": English text instead
    if (s && !/\bundefined\b|\bNaN\b/.test(s)) return s;
  }
  return text ?? '';
}
