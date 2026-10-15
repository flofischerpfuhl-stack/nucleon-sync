// SPDX-License-Identifier: GPL-3.0-or-later
/** Number formatting in the active UI locale (set by i18n/index.ts `setLocale`). */
let nf = new Intl.NumberFormat('en-GB');
let tag = 'en-GB';

export function setNumberLocale(intl: string): void {
  tag = intl;
  nf = new Intl.NumberFormat(intl);
}

/** BCP 47 tag of the active UI locale (Intl formatters, localeCompare) */
export const intlTag = (): string => tag;

/** integer/decimal number in the active locale ("1,234" / "1.234") */
export const n = (x: number): string => nf.format(x);
