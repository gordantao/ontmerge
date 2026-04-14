/**
 * Lineage Store - Manages tracking of merged concept provenance.
 * Uses Svelte 5 runes for proper reactive state management.
 */

import type { LineageEntry, LineageSource, LineagePanel, LineageAction } from '$lib/types';

class LineageStore {
  /** Internal Map storing lineage entries by path */
  entries = $state<Map<string, LineageEntry>>(new Map());

  /**
   * Get a lineage entry by path
   */
  get(path: string): LineageEntry | undefined {
    return this.entries.get(path);
  }

  /**
   * Get all entries as a plain object for serialization
   */
  get all(): Map<string, LineageEntry> {
    return this.entries;
  }

  /**
   * Count total sources across all entries
   */
  get sourceCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      count += entry.sources.length;
    }
    return count;
  }

  /**
   * Get number of tracked paths
   */
  get pathCount(): number {
    return this.entries.size;
  }

  /**
   * Add or update a lineage record for a merged item.
   * Tracks where each concept in the merged panel originated from.
   */
  add(
    mergedPath: string,
    panel: LineagePanel,
    originalPath: string,
    action: LineageAction = "added"
  ): void {
    // Clone to break proxy reference
    const newEntries = new Map(this.entries);
    const existing = newEntries.get(mergedPath);

    if (existing) {
      // Check if this source is already recorded (no duplicates)
      const alreadyHasSource = existing.sources.some(
        (s) => s.panel === panel && s.originalPath === originalPath
      );

      if (!alreadyHasSource) {
        // Create new sources array with new entry
        newEntries.set(mergedPath, {
          sources: [...existing.sources, { panel, originalPath, action }]
        });
      }
    } else {
      newEntries.set(mergedPath, {
        sources: [{ panel, originalPath, action }]
      });
    }

    // Assignment triggers reactivity
    this.entries = newEntries;
  }

  /**
   * Update lineage entries when an item is renamed or moved.
   * Updates all entries that match or are children of the old path.
   */
  updatePath(oldPath: string, newPath: string): void {
    const newEntries = new Map(this.entries);

    for (const [path, entry] of this.entries) {
      if (path === oldPath) {
        // Exact match - just rename
        newEntries.set(newPath, { sources: [...entry.sources] });
      } else if (path.startsWith(oldPath + "/")) {
        // Child path - update with new prefix
        const suffix = path.slice(oldPath.length);
        newEntries.set(newPath + suffix, { sources: [...entry.sources] });
      }
      // Paths that don't start with oldPath stay unchanged
    }

    this.entries = newEntries;
  }

  /**
   * Remove lineage entries for a deleted item and all its children.
   */
  remove(path: string): void {
    const newEntries = new Map(this.entries);

    for (const key of newEntries.keys()) {
      if (key === path || key.startsWith(path + "/")) {
        newEntries.delete(key);
      }
    }

    this.entries = newEntries;
  }

  /**
   * Reindex lineage paths after an array item is deleted.
   * Shifts down indices for all items after the deleted index.
   */
  reindexAfterDelete(parentPath: string, deletedIndex: number): void {
    const parentPrefix = parentPath ? parentPath + "/" : "";
    const newEntries = new Map(this.entries);

    for (const [path, entry] of this.entries) {
      if (path.startsWith(parentPrefix)) {
        const rest = path.slice(parentPrefix.length);
        const slashIndex = rest.indexOf("/");
        const indexPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
        const itemIndex = parseInt(indexPart, 10);

        if (!isNaN(itemIndex) && itemIndex > deletedIndex) {
          // Reindex this entry (shift down by 1)
          // First delete the old key to avoid stale entries
          newEntries.delete(path);
          const newIndex = itemIndex - 1;
          const newKey =
            parentPrefix +
            newIndex +
            (slashIndex === -1 ? "" : rest.slice(slashIndex));
          newEntries.set(newKey, { sources: [...entry.sources] });
        }
        // Items at or before deleted index stay unchanged
      }
    }

    this.entries = newEntries;
  }

  /**
   * Mark all existing lineage sources for a path as "merged".
   * Called when an item is combined with another from a different source.
   */
  markAsMerged(mergedPath: string): void {
    const entry = this.entries.get(mergedPath);
    if (entry) {
      // Update all sources to "merged" action
      const newSources = entry.sources.map((s) => ({
        ...s,
        action: "merged" as LineageAction
      }));

      // Create new entry with updated sources
      const newEntries = new Map(this.entries);
      newEntries.set(mergedPath, { sources: newSources });

      this.entries = newEntries;
    }
  }

  /**
   * Check if a path has sources from both left and right panels
   */
  hasBothSources(path: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;

    const panels = new Set(entry.sources.map((s) => s.panel));
    return panels.has("left") && panels.has("right");
  }

  /**
   * Get the primary source panel for a path (left, right, or null if mixed/both)
   */
  getPrimarySource(path: string): LineagePanel | "both" | null {
    const entry = this.entries.get(path);
    if (!entry || entry.sources.length === 0) return null;

    const panels = new Set(entry.sources.map((s) => s.panel));

    if (panels.size === 1) {
      return [...panels][0] as LineagePanel;
    }
    if (panels.size === 2 && panels.has("left") && panels.has("right")) {
      return "both";
    }
    return null;
  }

  /**
   * Export lineage as plain object for JSON serialization
   */
  toObject(): Record<string, LineageEntry> {
    const result: Record<string, LineageEntry> = {};
    for (const [path, entry] of this.entries) {
      result[path] = { sources: [...entry.sources] };
    }
    return result;
  }

  /**
   * Import lineage from plain object
   */
  fromObject(data: Record<string, LineageEntry> | Map<string, LineageEntry>): void {
    if (data instanceof Map) {
      this.entries = new Map(data);
    } else {
      this.entries = new Map(Object.entries(data));
    }
  }

  /**
   * Clear all lineage data
   */
  clear(): void {
    this.entries = new Map();
  }

  /**
   * Get entries as array for iteration
   */
  entriesAsArray(): Array<[string, LineageEntry]> {
    return Array.from(this.entries.entries());
  }
}

/**
 * Singleton instance of the lineage store
 */
export const lineageStore = new LineageStore();