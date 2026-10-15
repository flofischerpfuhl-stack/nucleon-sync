// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Transfer histogram matching the activity time filter (today: 24 hourly bars, 7 or 30 daily bars): stacked bars
 * (up = series 1, down = series 2), legend, per-bar hover tooltip.
 */
import { useState } from 'react';

import { fmtBytes, fmtDate } from '../format.ts';
import { t } from '../i18n/index.ts';
import type { DayBar, TimeRange } from '../logic/activity.ts';

export function Histogram({ bars, range = '30d' }: { bars: DayBar[]; range?: TimeRange }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.up + b.down));
  const W = 100 / bars.length;
  const h = hover !== null ? bars[hover] : null;
  return (
    <div className="hist" onMouseLeave={() => setHover(null)} data-range={range} data-bars={bars.length}>
      <div className="hist-head">
        <span className="hist-title" data-testid="hist-title">
          {t.activity.histogramTitle[range]}
        </span>
        <span className="legend">
          <i className="sw sw-1" /> {t.activity.histUp}
          <i className="sw sw-2" /> {t.activity.histDown}
        </span>
        <span className="hist-max muted">{t.activity.histMax(fmtBytes(max))}</span>
      </div>
      <div className="hist-plot">
        {bars.map((b, i) => {
          const upH = (b.up / max) * 100;
          const downH = (b.down / max) * 100;
          return (
            <div
              key={b.day}
              className={`hist-col${hover === i ? ' on' : ''}`}
              style={{ left: `${i * W}%`, width: `${W}%` }}
              onMouseEnter={() => setHover(i)}
            >
              <div className="hist-bar">
                {downH > 0 ? <div className="seg seg-2" style={{ height: `${downH}%` }} /> : null}
                {upH > 0 ? <div className="seg seg-1" style={{ height: `${upH}%` }} /> : null}
              </div>
            </div>
          );
        })}
        {h ? (
          <div className="tooltip" style={{ left: `min(calc(${(hover! + 0.5) * W}% - 90px), calc(100% - 190px))` }}>
            <b>{h.label ?? fmtDate(`${h.day}T12:00:00`)}</b>
            <div>
              <i className="sw sw-1" /> {fmtBytes(h.up)} {t.activity.histUp}
            </div>
            <div>
              <i className="sw sw-2" /> {fmtBytes(h.down)} {t.activity.histDown}
            </div>
          </div>
        ) : null}
      </div>
      <div className="hist-axis muted">
        <span>{range === 'today' ? t.activity.histStart.today : fmtDate(`${bars[0]?.day}T12:00:00`).slice(0, 6)}</span>
        <span>{range === 'today' ? '23:00' : t.activity.today}</span>
      </div>
    </div>
  );
}
