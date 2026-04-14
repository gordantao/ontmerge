/**
 * History Store - Memory-efficient undo/redo using operation deltas.
 * Uses Svelte 5 runes for proper reactive state management.
 */

import type { OntologyTree, LineageEntry } from '$lib/types';

type OperationType = 'add' | 'remove' | 'update' | 'move' | 'replace';

interface Operation {
  type: OperationType;
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
  fromPath?: string;
}

interface HistoryState {
  /** The full state at this point in history */
  mergedData: OntologyTree;
  sourceMap: Map<string, string>;
  lineage: Map<string, LineageEntry>;
  subscriptions: Map<string, Set<string>>;
  subscriberInfo: Map<string, Array<{ sourceId: string; source: "left" | "right"; isMerged: boolean }>>;
  mergedPathToId: Map<string, string>;
}

class HistoryStore {
  /** Stack of full state snapshots */
  private snapshots = $state<HistoryState[]>([]);

  /** Current position in history */
  private currentIndex = $state(-1);

  /** Maximum history size */
  private maxHistory = 50;

  /** Whether undo is available */
  get canUndo(): boolean {
    return this.currentIndex >= 0;
  }

  /** Whether redo is available */
  get canRedo(): boolean {
    return this.currentIndex < this.snapshots.length - 1;
  }

  /** Current history position */
  get position(): number {
    return this.currentIndex;
  }

  /** Total number of states in history */
  get length(): number {
    return this.snapshots.length;
  }

  /**
   * Save current state to history stack.
   * Call before any mutation to enable undo.
   */
  save(state: {
    mergedData: OntologyTree;
    sourceMap: Map<string, string>;
    lineage: Map<string, LineageEntry>;
    subscriptions: Map<string, Set<string>>;
    subscriberInfo: Map<string, Array<{ sourceId: string; source: "left" | "right"; isMerged: boolean }>>;
    mergedPathToId: Map<string, string>;
  }): void {
    // Create deep clone of state
    const snapshot: HistoryState = {
      mergedData: structuredClone(state.mergedData),
      sourceMap: new Map(state.sourceMap),
      lineage: new Map(
        Array.from(state.lineage.entries()).map(([k, v]) => [
          k,
          { sources: [...v.sources] }
        ])
      ),
      subscriptions: new Map(
        Array.from(state.subscriptions.entries()).map(([k, v]) => [
          k,
          new Set(v)
        ])
      ),
      subscriberInfo: new Map(
        Array.from(state.subscriberInfo.entries()).map(([k, v]) => [
          k,
          v.map((info) => ({ ...info }))
        ])
      ),
      mergedPathToId: new Map(state.mergedPathToId)
    };

    // Truncate any redo history
    if (this.currentIndex < this.snapshots.length - 1) {
      this.snapshots = this.snapshots.slice(0, this.currentIndex + 1);
    }

    // Add new snapshot
    this.snapshots.push(snapshot);
    this.currentIndex = this.snapshots.length - 1;

    // Limit history size
    if (this.snapshots.length > this.maxHistory) {
      this.snapshots = this.snapshots.slice(1);
      this.currentIndex--;
    }
  }

  /**
   * Undo the last action by restoring previous state
   */
  undo(): HistoryState | null {
    if (!this.canUndo) return null;

    this.currentIndex--;
    return this.snapshots[this.currentIndex + 1];
  }

  /**
   * Redo a previously undone action
   */
  redo(): HistoryState | null {
    if (!this.canRedo) return null;

    this.currentIndex++;
    return this.snapshots[this.currentIndex];
  }

  /**
   * Get current state without modifying history
   */
  getCurrent(): HistoryState | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.snapshots.length) {
      return null;
    }
    return this.snapshots[this.currentIndex];
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.snapshots = [];
    this.currentIndex = -1;
  }

  /**
   * Get history as array (for debugging)
   */
  toArray(): HistoryState[] {
    return [...this.snapshots];
  }
}

/**
 * Singleton instance of the history store
 */
export const historyStore = new HistoryStore();