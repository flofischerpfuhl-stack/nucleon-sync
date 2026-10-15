// SPDX-License-Identifier: GPL-3.0-or-later
/** Streaming SHA-1 with bounded concurrency (local scanner, download verification). */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    const s = createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Tiny async limiter: at most n tasks at a time (FIFO with a head index: Array#shift is O(n) on long queues). */
export function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  let queue: (() => void)[] = [];
  let head = 0;
  const next = () => {
    if (active >= n || head >= queue.length) return;
    active++;
    const run = queue[head++]!;
    if (head > 4096 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    run();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
