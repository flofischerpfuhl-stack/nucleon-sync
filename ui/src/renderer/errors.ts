// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConfirmRequiredResponse } from '@nucleon-sync/shared';

import { decodeApiError } from '../common/ipc.ts';

/** API failure as seen by the renderer: HTTP status + parsed JSON body (0 = transport/unknown). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
  /** 409 of the confirm round-trip (ARCHITECTURE §6) */
  get confirm(): ConfirmRequiredResponse | null {
    const b = this.body as Partial<ConfirmRequiredResponse> | null;
    return this.status === 409 && b && typeof b.confirmToken === 'string' ? (b as ConfirmRequiredResponse) : null;
  }
  get notImplemented(): boolean {
    return this.status === 501 || this.status === 404;
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const dec = decodeApiError(msg);
  if (!dec) return new ApiError(0, null, msg);
  let body: unknown = dec.body;
  try {
    body = JSON.parse(dec.body);
  } catch {
    /* plain text */
  }
  const text = (body as { error?: string } | null)?.error ?? dec.body;
  return new ApiError(dec.status, body, String(text));
}
