// SPDX-License-Identifier: GPL-3.0-or-later
/** One activity line (overview, flyout) and helpers shared with the activity table. */
import type { ActivityAction, ActivityItem, PairDto } from '@nucleon-sync/shared';

import { fmtBytes, fmtClock, shortPath } from '../format.ts';
import { t } from '../i18n/index.ts';
import { ACTION_CATEGORY, activityLabel, activityMessage } from '../logic/activity.ts';
import { Icon, type IconName } from './Icon.tsx';

const CAT_ICON: Record<string, IconName> = {
  up: 'up',
  down: 'down',
  move: 'move',
  trash: 'trash',
  error: 'error',
  warn: 'warn',
  other: 'info',
};

export function actionIcon(a: ActivityAction): IconName {
  if (a === 'adopted') return 'check';
  return CAT_ICON[ACTION_CATEGORY[a] ?? 'other']!;
}

export function ActionBadge({ action, compact, label }: { action: ActivityAction; compact?: boolean; label?: string }) {
  const cat = ACTION_CATEGORY[action] ?? 'other';
  return (
    <span className={`action action-${cat}`}>
      <Icon name={actionIcon(action)} size={16} />
      {compact ? null : <span>{label ?? t.activity.action[action]}</span>}
    </span>
  );
}

export function itemText(i: ActivityItem, pair?: PairDto): string {
  if (i.relPath) return pair ? `${pair.name}/${i.relPath}` : i.relPath;
  return activityMessage(i) ?? '';
}

export function ActivityLine({
  item,
  pair,
  accountName,
  maxPath = 70,
}: {
  item: ActivityItem;
  pair?: PairDto;
  accountName: string;
  maxPath?: number;
}) {
  const text = itemText(item, pair);
  const { label, detail } = activityLabel(item, t.activity.action);
  return (
    <div className="aline">
      <span className="aline-time">{fmtClock(item.ts)}</span>
      <span className="aline-acc">{accountName}</span>
      <ActionBadge action={item.action} label={label} />
      <span className="aline-path" title={text}>
        {item.relPath ? shortPath(text, maxPath) : text}
        {item.relPath && detail ? <span className="muted"> · {detail}</span> : null}
      </span>
      <span className="aline-size">{item.bytes ? fmtBytes(item.bytes) : ''}</span>
    </div>
  );
}
