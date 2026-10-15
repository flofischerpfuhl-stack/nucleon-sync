// SPDX-License-Identifier: GPL-3.0-or-later
/** service container used by the API routes and main.ts. */

import type { DoctorCheck } from '@nucleon-sync/shared';

import { AccountsService } from '../accounts/accounts.ts';
import { stagingDirOf, type ServiceContext } from '../accounts/context.ts';
import { runDoctor } from '../accounts/doctor.ts';
import { PairsService } from '../accounts/pairs.ts';
import { PauseTimers } from '../accounts/pause.ts';
import { SettingsService } from '../accounts/settings.ts';
import { StorageService } from '../accounts/storage.ts';
import type { AccountRow, PairRow } from '../db/repo.ts';
import { Notifier } from '../notify/notifier.ts';

export interface Services {
  ctx: ServiceContext;
  accounts: AccountsService;
  pairs: PairsService;
  storage: StorageService;
  settings: SettingsService;
  pauses: PauseTimers;
  notifier: Notifier;
  doctor(api: { reachable: boolean; detail: string } | null): DoctorCheck[];
  start(): void;
  stop(): void;
}

export { stagingDirOf } from '../accounts/context.ts';

export function createServices(ctx: ServiceContext): Services {
  const accounts = new AccountsService(ctx);
  const pairs = new PairsService(ctx, accounts);
  const storage = new StorageService(ctx, accounts);
  const settings = new SettingsService(ctx);
  const pauses = new PauseTimers(ctx);
  const notifier = new Notifier(ctx);
  return {
    ctx,
    accounts,
    pairs,
    storage,
    settings,
    pauses,
    notifier,
    doctor: (api) =>
      runDoctor({
        env: ctx.env,
        paths: ctx.paths,
        cliPath: ctx.cliPath,
        mode: ctx.mode,
        accounts: ctx.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as unknown as AccountRow[],
        pairs: ctx.db.prepare('SELECT * FROM pairs ORDER BY id').all() as unknown as PairRow[],
        stagingDir: stagingDirOf(ctx),
        secretFileDir: ctx.secretFileDir,
        api,
        writeGuard: ctx.engine.writeGuardMsg(),
        requiredMounts: ctx.config.requiredMounts,
      }),
    start: () => {
      accounts.checkKeyrings();
      pauses.start();
      storage.start();
      notifier.start();
    },
    stop: () => {
      accounts.close();
      pauses.stop();
      storage.stop();
      notifier.stop();
    },
  };
}
