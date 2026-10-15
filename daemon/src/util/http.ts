// SPDX-License-Identifier: GPL-3.0-or-later
/** Errors the API maps to HTTP status codes (everything else is a 500). */
import type { ApiError } from '@nucleon-sync/shared';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiError['code'];
  /** optional extra body fields (e.g. the confirm round-trip payload) */
  readonly body: Record<string, unknown> | null;
  constructor(status: number, code: ApiError['code'], message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const notFound = (msg: string) => new HttpError(404, 'not_found', msg);
export const forbidden = (msg: string) => new HttpError(403, 'forbidden', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
