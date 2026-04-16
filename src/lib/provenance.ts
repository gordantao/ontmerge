/**
 * Provenance system: single source of truth for tracking where merged items came from.
 *
 * Replaces the old system of 5 parallel maps (sourceMap, subscriptions, subscriberInfo,
 * mergedPathToId, lineage) with:
 *   - nodeIdMap: merged-tree path → stable UUID (survives moves/reindexing)
 *   - provenance: stable UUID → ProvenanceEntry (all source info for that node)
 *
 * Everything else (sourceMap-equivalent, usageMap, lineage) is derived.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SourcePanel = "left" | "right";
export type ProvenancePanel = SourcePanel | "user" | "llm";
export type ProvenanceAction =
  | "added"
  | "merged"
  | "header-merged"
  | "created"
  | "llm-suggested"
  | "llm-auto-merged";

export interface ProvenanceSource {
  panel: ProvenancePanel;
  /** Path in the source panel tree (e.g. "Neuropathology/Brain tumors") */
  originalPath: string;
  action: ProvenanceAction;
}

export interface ProvenanceEntry {
  sources: ProvenanceSource[];
}

/** Snapshot for undo/redo — only two things to clone. */
export interface ProvenanceSnapshot {
  mergedData: unknown;
  nodeIdMap: Map<string, string>;
  provenance: Map<string, ProvenanceEntry>;
}

// ─── Derived source ("left" | "right" | "both" | "created") ──────────────────

export function deriveSource(entry: ProvenanceEntry | undefined): string {
  if (!entry || entry.sources.length === 0) return "created";
  const panels = new Set<string>();
  for (const s of entry.sources) {
    if (s.panel === "left" || s.panel === "right") {
      panels.add(s.panel);
    }
  }
  if (panels.size === 0) return "created";
  if (panels.size === 2) return "both";
  return panels.values().next().value!;
}

// ─── Derived usage status for source panel items ─────────────────────────────

export type UsageStatus = "unused" | "added" | "merged";

/**
 * Build a usage map for a source panel by scanning all provenance entries.
 * Returns: sourcePathInPanel → UsageStatus
 */
export function buildUsageMap(
  panel: SourcePanel,
  pathToId: Map<string, string>,
  provenance: Map<string, ProvenanceEntry>,
): Map<string, UsageStatus> {
  // Build reverse: sourceId → Set<sourcePaths> so we can look up usage
  // Actually we want: for each source path, is it referenced in any provenance entry?

  // First build sourceOriginalPath → best status
  const statusByOriginalPath = new Map<string, UsageStatus>();

  for (const [, entry] of provenance) {
    const isMerged = hasBothPanels(entry);
    for (const s of entry.sources) {
      if (s.panel !== panel) continue;
      const current = statusByOriginalPath.get(s.originalPath);
      const status: UsageStatus = isMerged ? "merged" : "added";
      if (!current || betterStatus(status, current)) {
        statusByOriginalPath.set(s.originalPath, status);
      }
    }
  }

  // Now map source panel paths to their status.
  // An originalPath in provenance is the full path in the source panel tree.
  // We need to match it to pathToId keys.
  const usageMap = new Map<string, UsageStatus>();
  for (const [path] of pathToId) {
    const status = statusByOriginalPath.get(path);
    if (status) {
      usageMap.set(path, status);
    }
  }

  return usageMap;
}

function hasBothPanels(entry: ProvenanceEntry): boolean {
  let hasLeft = false;
  let hasRight = false;
  for (const s of entry.sources) {
    if (s.panel === "left") hasLeft = true;
    if (s.panel === "right") hasRight = true;
    if (hasLeft && hasRight) return true;
  }
  return false;
}

function betterStatus(a: UsageStatus, b: UsageStatus): boolean {
  const rank: Record<UsageStatus, number> = { unused: 0, added: 1, merged: 2 };
  return rank[a] > rank[b];
}

// ─── Node ID management ─────────────────────────────────────────────────────

let _idCounter = 0;

export function generateNodeId(): string {
  return `n_${++_idCounter}_${Date.now()}`;
}

/**
 * Assign stable node IDs to every path in a merged tree.
 * Non-destructive: skips paths that already have IDs.
 */
export function assignNodeIds(
  obj: unknown,
  basePath: string,
  nodeIdMap: Map<string, string>,
): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      const path = basePath ? `${basePath}/${idx}` : String(idx);
      if (!nodeIdMap.has(path)) nodeIdMap.set(path, generateNodeId());
      assignNodeIds(item, path, nodeIdMap);
    });
  } else {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = basePath ? `${basePath}/${key}` : key;
      if (!nodeIdMap.has(path)) nodeIdMap.set(path, generateNodeId());
      assignNodeIds(value, path, nodeIdMap);
    }
  }
}

// ─── Path reindexing (for array mutations) ───────────────────────────────────
// With stable IDs the provenance map itself never needs reindexing.
// Only nodeIdMap (path→id) needs updating when array indices shift.

export function reindexNodeIdsAfterDelete(
  nodeIdMap: Map<string, string>,
  parentPath: string,
  deletedIndex: number,
  deletedPathKey: string,
): Map<string, string> {
  const parentPrefix = parentPath ? parentPath + "/" : "";
  const deletedPrefix = deletedPathKey + "/";
  const newMap = new Map<string, string>();

  for (const [key, id] of nodeIdMap) {
    // Skip deleted item and its children
    if (key === deletedPathKey || key.startsWith(deletedPrefix)) continue;

    if (key.startsWith(parentPrefix) || (!parentPrefix && /^\d/.test(key))) {
      const rest = parentPrefix ? key.slice(parentPrefix.length) : key;
      const slashIndex = rest.indexOf("/");
      const indexPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const itemIndex = parseInt(indexPart, 10);
      if (!isNaN(itemIndex) && itemIndex > deletedIndex) {
        const newKey =
          parentPrefix + (itemIndex - 1) + (slashIndex === -1 ? "" : rest.slice(slashIndex));
        newMap.set(newKey, id);
      } else {
        newMap.set(key, id);
      }
    } else {
      newMap.set(key, id);
    }
  }
  return newMap;
}

export function reindexNodeIdsAfterInsert(
  nodeIdMap: Map<string, string>,
  parentPath: string,
  insertedIndex: number,
): Map<string, string> {
  const parentPrefix = parentPath ? parentPath + "/" : "";
  const newMap = new Map<string, string>();

  for (const [key, id] of nodeIdMap) {
    if (key.startsWith(parentPrefix) || (!parentPrefix && /^\d/.test(key))) {
      const rest = parentPrefix ? key.slice(parentPrefix.length) : key;
      const slashIndex = rest.indexOf("/");
      const indexPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const itemIndex = parseInt(indexPart, 10);
      if (!isNaN(itemIndex) && itemIndex >= insertedIndex) {
        const newKey =
          parentPrefix + (itemIndex + 1) + (slashIndex === -1 ? "" : rest.slice(slashIndex));
        newMap.set(newKey, id);
      } else {
        newMap.set(key, id);
      }
    } else {
      newMap.set(key, id);
    }
  }
  return newMap;
}

/**
 * Remap all nodeIdMap entries from oldPrefix to newPrefix (for renames/moves).
 */
export function remapNodeIdPaths(
  nodeIdMap: Map<string, string>,
  oldPath: string,
  newPath: string,
): Map<string, string> {
  const newMap = new Map<string, string>();
  for (const [key, id] of nodeIdMap) {
    if (key === oldPath) {
      newMap.set(newPath, id);
    } else if (key.startsWith(oldPath + "/")) {
      newMap.set(newPath + key.slice(oldPath.length), id);
    } else {
      newMap.set(key, id);
    }
  }
  return newMap;
}

// ─── Provenance operations ──────────────────────────────────────────────────

/**
 * Set provenance for a single node (by its stable ID).
 * Replaces any existing provenance for that node.
 */
export function setProvenance(
  provenance: Map<string, ProvenanceEntry>,
  nodeId: string,
  sources: ProvenanceSource[],
): void {
  provenance.set(nodeId, { sources: [...sources] });
}

/**
 * Add a source to an existing node's provenance (e.g. during merge).
 * Deduplicates by (panel, originalPath).
 */
export function addProvenanceSource(
  provenance: Map<string, ProvenanceEntry>,
  nodeId: string,
  source: ProvenanceSource,
): void {
  const entry = provenance.get(nodeId);
  if (entry) {
    const exists = entry.sources.some(
      (s) => s.panel === source.panel && s.originalPath === source.originalPath,
    );
    if (!exists) {
      entry.sources.push({ ...source });
    }
  } else {
    provenance.set(nodeId, { sources: [{ ...source }] });
  }
}

/**
 * Mark all sources for a node as "merged".
 */
export function markProvenanceAsMerged(
  provenance: Map<string, ProvenanceEntry>,
  nodeId: string,
): void {
  const entry = provenance.get(nodeId);
  if (entry) {
    for (const s of entry.sources) {
      s.action = "merged";
    }
  }
}

/**
 * Remove provenance for a node ID.
 */
export function removeProvenance(
  provenance: Map<string, ProvenanceEntry>,
  nodeId: string,
): void {
  provenance.delete(nodeId);
}

/**
 * Record provenance for a node and all its children recursively.
 * Used when adding a new subtree from a source panel.
 */
export function recordProvenanceRecursive(
  provenance: Map<string, ProvenanceEntry>,
  nodeIdMap: Map<string, string>,
  basePath: string,
  sourcePath: string,
  panel: SourcePanel,
  value: unknown,
  action: ProvenanceAction = "added",
): void {
  const nodeId = nodeIdMap.get(basePath);
  if (nodeId) {
    addProvenanceSource(provenance, nodeId, { panel, originalPath: sourcePath, action });
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        recordProvenanceRecursive(
          provenance,
          nodeIdMap,
          `${basePath}/${idx}`,
          `${sourcePath}/${idx}`,
          panel,
          item,
          action,
        );
      });
    } else {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        recordProvenanceRecursive(
          provenance,
          nodeIdMap,
          basePath ? `${basePath}/${key}` : key,
          sourcePath ? `${sourcePath}/${key}` : key,
          panel,
          val,
          action,
        );
      }
    }
  }
}

/**
 * Record provenance for section merge: parent gets "both", children keep original source.
 * Only adds provenance for children that don't already have a source from this panel.
 */
export function recordProvenanceForSectionMerge(
  provenance: Map<string, ProvenanceEntry>,
  nodeIdMap: Map<string, string>,
  basePath: string,
  sourcePath: string,
  panel: SourcePanel,
  value: unknown,
  mergedTree: unknown,
): void {
  // Mark the parent itself
  const parentId = nodeIdMap.get(basePath);
  if (parentId) {
    addProvenanceSource(provenance, parentId, { panel, originalPath: sourcePath, action: "merged" });
  }

  // Recurse to children
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      if (mergedTree && Array.isArray(mergedTree)) {
        // Merge-aware: map source items to actual merged indices
        value.forEach((item, srcIdx) => {
          const mergedIdx = (mergedTree as unknown[]).findIndex(
            (ex) => typeof ex === typeof item && String(ex) === String(item),
          );
          if (mergedIdx !== -1) {
            const childPath = `${basePath}/${mergedIdx}`;
            const childSourcePath = `${sourcePath}/${srcIdx}`;
            const childId = nodeIdMap.get(childPath);
            if (childId) {
              const existing = provenance.get(childId);
              const alreadyHasThisPanel = existing?.sources.some((s) => s.panel === panel);
              if (!alreadyHasThisPanel) {
                addProvenanceSource(provenance, childId, {
                  panel,
                  originalPath: childSourcePath,
                  action: "added",
                });
              } else {
                // Different source exists → mark as merged
                const hasOtherPanel = existing?.sources.some(
                  (s) => (s.panel === "left" || s.panel === "right") && s.panel !== panel,
                );
                if (hasOtherPanel) {
                  addProvenanceSource(provenance, childId, {
                    panel,
                    originalPath: childSourcePath,
                    action: "merged",
                  });
                }
              }
            }
          }
        });
      } else {
        // 1:1 index mapping fallback
        value.forEach((item, idx) => {
          const childPath = `${basePath}/${idx}`;
          const childSourcePath = `${sourcePath}/${idx}`;
          const childId = nodeIdMap.get(childPath);
          if (childId && !provenance.has(childId)) {
            addProvenanceSource(provenance, childId, {
              panel,
              originalPath: childSourcePath,
              action: "added",
            });
          }
        });
      }
    } else {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const childPath = basePath ? `${basePath}/${key}` : key;
        const childSourcePath = sourcePath ? `${sourcePath}/${key}` : key;
        const childId = nodeIdMap.get(childPath);
        if (childId) {
          const existing = provenance.get(childId);
          if (!existing || existing.sources.length === 0) {
            addProvenanceSource(provenance, childId, {
              panel,
              originalPath: childSourcePath,
              action: "added",
            });
          } else {
            // Already has a source — check if it's a sub-section merge
            const hasOtherPanel = existing.sources.some(
              (s) => (s.panel === "left" || s.panel === "right") && s.panel !== panel,
            );
            if (hasOtherPanel) {
              // Recursively handle nested section merge
              const mergedChild =
                mergedTree && typeof mergedTree === "object" && !Array.isArray(mergedTree)
                  ? (mergedTree as Record<string, unknown>)[key]
                  : undefined;
              recordProvenanceForSectionMerge(
                provenance,
                nodeIdMap,
                childPath,
                childSourcePath,
                panel,
                val,
                mergedChild,
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Remove provenance for a node and all children at paths starting with prefix.
 */
export function removeProvenanceForSubtree(
  provenance: Map<string, ProvenanceEntry>,
  nodeIdMap: Map<string, string>,
  basePath: string,
): void {
  const prefix = basePath + "/";
  for (const [path, id] of nodeIdMap) {
    if (path === basePath || path.startsWith(prefix)) {
      provenance.delete(id);
    }
  }
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

export function cloneProvenance(
  prov: Map<string, ProvenanceEntry>,
): Map<string, ProvenanceEntry> {
  const clone = new Map<string, ProvenanceEntry>();
  for (const [id, entry] of prov) {
    clone.set(id, { sources: entry.sources.map((s) => ({ ...s })) });
  }
  return clone;
}

/**
 * Build a "sourceMap" equivalent: mergedPath → "left" | "right" | "both" | "created"
 * Used for coloring in the merged panel TreeView.
 */
export function buildSourceMap(
  nodeIdMap: Map<string, string>,
  provenance: Map<string, ProvenanceEntry>,
): Map<string, string> {
  const sourceMap = new Map<string, string>();
  for (const [path, nodeId] of nodeIdMap) {
    const entry = provenance.get(nodeId);
    sourceMap.set(path, deriveSource(entry));
  }
  return sourceMap;
}

/**
 * Look up the lineage/provenance entry for a given merged path.
 */
export function getLineageForPath(
  path: string,
  nodeIdMap: Map<string, string>,
  provenance: Map<string, ProvenanceEntry>,
): ProvenanceEntry | undefined {
  const nodeId = nodeIdMap.get(path);
  if (!nodeId) return undefined;
  return provenance.get(nodeId);
}

// ─── V5 file format ─────────────────────────────────────────────────────────

export interface V5MergeFile {
  version: 5;
  format: "name-keyed-with-provenance";
  metadata: {
    source: string;
    llmModel?: string;
    sessionId: string;
    createdAt: string;
    notes?: string;
  };
  ontologies: {
    left: { name: string; path: string };
    right: { name: string; path: string };
  };
  mergedData: unknown;
  nodeIdMap: Record<string, string>;
  provenance: Record<string, ProvenanceEntry>;
  concepts: Record<string, unknown>;
  llmSuggestions?: unknown;
  pendingReview?: unknown[];
}

export function serializeNodeIdMap(
  map: Map<string, string>,
): Record<string, string> {
  return Object.fromEntries(map);
}

export function deserializeNodeIdMap(
  obj: Record<string, string>,
): Map<string, string> {
  return new Map(Object.entries(obj));
}

export function serializeProvenance(
  map: Map<string, ProvenanceEntry>,
): Record<string, ProvenanceEntry> {
  return Object.fromEntries(map);
}

export function deserializeProvenance(
  obj: Record<string, ProvenanceEntry>,
): Map<string, ProvenanceEntry> {
  const map = new Map<string, ProvenanceEntry>();
  for (const [id, entry] of Object.entries(obj)) {
    map.set(id, { sources: entry.sources.map((s) => ({ ...s })) });
  }
  return map;
}
