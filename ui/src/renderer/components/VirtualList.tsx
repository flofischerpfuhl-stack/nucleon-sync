// SPDX-License-Identifier: GPL-3.0-or-later
/** Fixed-row-height virtual list: renders only visible rows (+ overscan), handles 50k+ rows smoothly. */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { rowKeys } from './a11y.ts';

export function VirtualList<T>({
  rows,
  rowHeight,
  render,
  overscan = 8,
  onNearEnd,
  className,
  rowKey,
}: {
  rows: T[];
  rowHeight: number;
  render: (row: T, index: number) => ReactNode;
  overscan?: number;
  onNearEnd?: () => void;
  className?: string;
  rowKey: (row: T, index: number) => string | number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const total = rows.length * rowHeight;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  useEffect(() => {
    if (onNearEnd && rows.length > 0 && last >= rows.length - overscan) onNearEnd();
  }, [last, rows.length, overscan, onNearEnd]);
  const items: ReactNode[] = [];
  for (let i = first; i < last; i++)
    items.push(
      <div key={rowKey(rows[i]!, i)} className="vrow" style={{ top: i * rowHeight, height: rowHeight }}>
        {render(rows[i]!, i)}
      </div>,
    );
  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      onKeyDown={(e) => rowKeys(e, { row: '.vrow', target: 'button' })}
      data-rows={rows.length}
    >
      <div className="vspacer" style={{ height: total }}>
        {items}
      </div>
    </div>
  );
}
