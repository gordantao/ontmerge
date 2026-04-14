/**
 * Subscription management utilities for tracking source concepts.
 */

import type { LineageEntry, LineagePanel, LineageAction } from '$lib/types';

/**
 * Subscriber information for tracking source → merged mappings.
 */
export interface SubscriberInfo {
  sourceId: string;
  source: 'left' | 'right';
  isMerged: boolean;
}

/**
 * Subscribe a concept to the merged panel.
 */
export function createSubscription(
  mergedPath: string,
  subscriberId: string,
  sourceId: string,
  source: 'left' | 'right',
  subscriptions: Map<string, Set<string>>,
  subscriberInfo: Map<string, SubscriberInfo[]>,
  mergedPathToId: Map<string, string>,
): void {
  // Track subscription
  let subs = subscriptions.get(mergedPath);
  if (!subs) {
    subs = new Set();
    subscriptions.set(mergedPath, subs);
  }
  subs.add(subscriberId);

  // Track subscriber info
  let infos = subscriberInfo.get(subscriberId);
  if (!infos) {
    infos = [];
    subscriberInfo.set(subscriberId, infos);
  }
  infos.push({ sourceId, source, isMerged: false });

  // Track merged path ID
  if (!mergedPathToId.has(mergedPath)) {
    mergedPathToId.set(mergedPath, subscriberId);
  }
}

/**
 * Unsubscribe a concept from the merged panel.
 */
export function removeSubscription(
  subscriberId: string,
  mergedPath: string,
  subscriptions: Map<string, Set<string>>,
  subscriberInfo: Map<string, SubscriberInfo[]>,
  mergedPathToId: Map<string, string>,
): void {
  // Remove from subscriptions
  const subs = subscriptions.get(mergedPath);
  if (subs) {
    subs.delete(subscriberId);
    if (subs.size === 0) {
      subscriptions.delete(mergedPath);
    }
  }

  // Remove from subscriber info
  subscriberInfo.delete(subscriberId);

  // Remove from merged path ID
  const existingId = mergedPathToId.get(mergedPath);
  if (existingId === subscriberId) {
    mergedPathToId.delete(mergedPath);
  }
}

/**
 * Mark a subscriber as merged (combined with another source).
 */
export function markSubscriptionMerged(
  subscriberId: string,
  subscriberInfo: Map<string, SubscriberInfo[]>,
): void {
  const infos = subscriberInfo.get(subscriberId);
  if (infos) {
    for (const info of infos) {
      info.isMerged = true;
    }
  }
}

/**
 * Get the status of a source concept.
 */
export function getSourceStatus(
  sourceId: string,
  subscriptions: Map<string, Set<string>>,
  subscriberInfo: Map<string, SubscriberInfo[]>,
): 'unused' | 'added' | 'merged' {
  const infos = subscriberInfo.get(sourceId);
  if (!infos || infos.length === 0) return 'unused';

  const hasMerged = infos.some((info) => info.isMerged);
  if (hasMerged) return 'merged';

  return 'added';
}

/**
 * Add lineage entry for a concept.
 */
export function addLineageEntry(
  lineage: Map<string, LineageEntry>,
  mergedPath: string,
  panel: LineagePanel,
  originalPath: string,
  action: LineageAction = 'added',
): void {
  const existing = lineage.get(mergedPath);

  if (existing) {
    const alreadyHasSource = existing.sources.some(
      (s) => s.panel === panel && s.originalPath === originalPath,
    );
    if (!alreadyHasSource) {
      existing.sources.push({ panel, originalPath, action });
    }
  } else {
    lineage.set(mergedPath, {
      sources: [{ panel, originalPath, action }],
    });
  }
}

/**
 * Get usage map for source panels.
 * Maps path → status (unused/added/merged)
 */
export function buildUsageMap(
  sourcePathToId: Map<string, string>,
  subscriptions: Map<string, Set<string>>,
  subscriberInfo: Map<string, SubscriberInfo[]>,
): Map<string, 'unused' | 'added' | 'merged'> {
  const usageMap = new Map<string, 'unused' | 'added' | 'merged'>();

  for (const [path, id] of sourcePathToId) {
    const infos = subscriberInfo.get(id);
    if (!infos || infos.length === 0) {
      usageMap.set(path, 'unused');
      continue;
    }

    const hasMerged = infos.some((info) => info.isMerged);
    usageMap.set(path, hasMerged ? 'merged' : 'added');
  }

  return usageMap;
}
