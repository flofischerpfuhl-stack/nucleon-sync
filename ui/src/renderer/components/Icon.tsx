// SPDX-License-Identifier: GPL-3.0-or-later
/** Inline stroke icons (24×24, currentColor). Drawn for this app; no icon font, no network. */
const PATHS = {
  overview: 'M3 13a9 9 0 1 1 18 0M12 13l4-4M7.5 17h9',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  folder:
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  folderCloud:
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM9 16.5h6a2 2 0 0 0 0-4 3 3 0 0 0-5.6-.8A2.4 2.4 0 0 0 9 16.5z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  issues: 'M12 3 2.5 20h19zM12 10v4.5M12 17.3v.2',
  storage: 'M12 3a9 9 0 1 0 9 9h-9zM15 3.5A9 9 0 0 1 20.5 9H15z',
  accounts:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 6',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  maintenance: 'M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5zM14.5 6.5l2-2 3 3-2 2',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  move: 'M4 8h14l-3-3M20 16H6l3 3',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  warn: 'M12 3 2.5 20h19zM12 10v4.5M12 17.3v.2',
  check: 'M5 12.5 10 17l9-10',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.2',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4.5v15l12-7.5z',
  sync: 'M20 11a8 8 0 0 0-14.3-4.3L4 9M4 4v5h5M4 13a8 8 0 0 0 14.3 4.3L20 15M20 20v-5h-5',
  cloud: 'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  plus: 'M12 5v14M5 12h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  close: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  key: 'M7.5 16.5a4.5 4.5 0 1 1 4.2-6H21v3h-2.5v2.5h-3V13.5h-3.8a4.5 4.5 0 0 1-4.2 3zM7 12v.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  backup: 'M12 21V9M8 13l4-4 4 4M5 5h14',
  mirror: 'M12 3v12M8 11l4 4 4-4M5 19h14',
  outbox: 'M4 13v6h16v-6M12 3v11M8 7l4-4 4 4',
  twoWay: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4',
  logo: 'M4.6 9.2a8 8 0 0 1 13.6-3M19.4 14.8a8 8 0 0 1-13.6 3M18.6 3v3.6H15M5.4 21v-3.6H9M10.3 9.5a1.9 1.9 0 1 0 .01 0M13.7 9.7a1.9 1.9 0 1 0 .01 0M10.2 13a1.9 1.9 0 1 0 .01 0M13.6 13.1a1.9 1.9 0 1 0 .01 0',
  dot: 'M12 12h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
