<script lang="ts">
  import TreeView from "$lib/components/TreeView.svelte";
  import Navbar from "$lib/components/Navbar.svelte";
  import * as Card from "$lib/components/ui/card";
  import { File, GitMerge } from "lucide-svelte";
  import {
    type ProvenanceEntry,
    type ProvenanceSource,
    type ProvenanceAction,
    type ProvenancePanel,
    assignNodeIds,
    generateNodeId,
    deriveSource,
    buildUsageMap,
    buildSourceMap,
    getLineageForPath,
    reindexNodeIdsAfterDelete,
    reindexNodeIdsAfterInsert,
    remapNodeIdPaths,
    addProvenanceSource,
    setProvenance,
    markProvenanceAsMerged,
    removeProvenanceForSubtree,
    cloneProvenance,
    type V5MergeFile,
    serializeNodeIdMap,
    deserializeNodeIdMap,
    serializeProvenance,
    deserializeProvenance,
  } from "$lib/provenance";

  // Concept metadata from v4 ontology format
  type ConceptMeta = {
    name: string;
    synonyms?: string[];
    icd_codes?: string[];
    primary_reference?: string;
    related_concepts?: string[];
    source?: string;
  };

  // Type for the unified merge format from server (v1/v2)
  type SuggestedMerge = {
    version: number;
    metadata: {
      source: "llm" | "webapp" | "manual";
      llmModel?: string;
      sessionId?: string;
      notes?: string;
    };
    ontologies: {
      left: { name: string; path: string };
      right: { name: string; path: string };
    };
    mergedData: unknown;
    lineage?: Record<string, any>;
    sourceMap?: Record<string, string>;
    llmSuggestions?: {
      conceptMappings?: Record<string, string>;
      mergeDecisions?: Array<{
        mergedTo: string;
        mergedFrom: string[];
        matchType: string;
        similarity?: number;
        accepted?: boolean | null;
      }>;
      explanation?: string;
    };
    pendingReview?: Array<{
      path: string;
      reason: string;
      confidence?: number;
      alternatives?: string[];
    }>;
  };

  // Type for v4 merge format (id-keyed with metadata)
  type SuggestedMergeV4 = {
    version: 4;
    format: string;
    metadata: {
      source: "llm" | "webapp" | "manual";
      llmModel?: string;
      sessionId?: string;
      notes?: string;
    };
    sourceOntologies?: {
      pathout?: { name: string; conceptCount: number; v4Path: string };
      who?: { name: string; conceptCount: number; v4Path: string };
    };
    ontologies?: {
      left: { name: string; path: string };
      right: { name: string; path: string };
    };
    concepts: Record<string, ConceptMeta>;
    structure: Record<string, any>;
    lineage?: Record<string, any>;
    pendingReview?: Array<{
      path: string;
      reason: string;
      confidence?: number;
      alternatives?: string[];
    }>;
    llmSuggestions?: {
      conceptMappings?: Record<string, string>;
      mergeDecisions?: Array<{
        mergedTo: string;
        mergedFrom: string[];
        matchType: string;
        similarity?: number;
        accepted?: boolean | null;
      }>;
      explanation?: string;
    };
  };

  let {
    data,
  }: {
    data: {
      left: unknown;
      right: unknown;
      leftRegistry?: Record<string, ConceptMeta>;
      rightRegistry?: Record<string, ConceptMeta>;
    };
  } = $props();

  let initialized = false;
  let leftData = $state<any>({});
  let rightData = $state<any>({});
  let mergedData = $state<any>({});

  // Concept metadata registry (populated from v4 ontology files and v4 merge files)
  // Maps stable concept IDs -> ConceptMeta for metadata lookup/display
  let conceptRegistry = $state<Map<string, ConceptMeta>>(new Map());

  // Sort mode for source panels: "alphabetical" (default) or "status"
  let sourceSortMode = $state<"alphabetical" | "status">("alphabetical");

  // Track if we loaded from a suggested merge
  let loadedFromSuggestion = $state(false);
  let suggestionMetadata = $state<SuggestedMerge["metadata"] | null>(null);
  let pendingReviews = $state<SuggestedMerge["pendingReview"]>([]);
  let llmSuggestions = $state<SuggestedMerge["llmSuggestions"] | null>(null);

  // ============================================
  // PROVENANCE SYSTEM (replaces sourceMap, subscriptions, subscriberInfo, lineage, nodeIdMap)
  // ============================================

  // Stable node IDs: merged-tree path → UUID (survives moves, never changes for a node)
  let nodeIdMap = $state<Map<string, string>>(new Map());

  // Single source of truth: nodeId → ProvenanceEntry (all source/lineage info)
  let provenance = $state<Map<string, ProvenanceEntry>>(new Map());

  // Derived: merged path → "left" | "right" | "both" | "created" (for TreeView coloring)
  let sourceMap = $derived.by(() => buildSourceMap(nodeIdMap, provenance));

  // Legacy type aliases for backward compat within this file
  type LineageSource = ProvenanceSource;
  type LineageEntry = ProvenanceEntry;

  // ─── Provenance-based lineage helpers (adapter layer) ─────────────────────
  // These wrap the provenance system to maintain the same call signatures used
  // throughout handleDrop and other code, minimizing churn.

  /**
   * Force Svelte to see nodeIdMap and provenance as changed,
   * so $derived sourceMap / usageMaps recompute.
   */
  function invalidateProvenance() {
    nodeIdMap = new Map(nodeIdMap);
    provenance = new Map(provenance);
  }

  function addLineage(
    mergedPath: string,
    panel: ProvenancePanel,
    originalPath: string,
    action: ProvenanceAction = "added",
  ) {
    const nodeId = nodeIdMap.get(mergedPath);
    if (!nodeId) {
      // Auto-assign if missing
      const newId = generateNodeId();
      nodeIdMap.set(mergedPath, newId);
      addProvenanceSource(provenance, newId, { panel, originalPath, action });
    } else {
      addProvenanceSource(provenance, nodeId, { panel, originalPath, action });
    }
  }

  function removeLineage(path: string) {
    removeProvenanceForSubtree(provenance, nodeIdMap, path);
  }

  function markLineageAsMerged(mergedPath: string) {
    const nodeId = nodeIdMap.get(mergedPath);
    if (nodeId) {
      markProvenanceAsMerged(provenance, nodeId);
    }
  }

  /**
   * Reindex all tracking maps after an array item deletion.
   * With provenance, only nodeIdMap needs reindexing (provenance is keyed by stable IDs).
   */
  function reindexMergedArrayAfterDelete(
    parentPath: string,
    deletedIndex: number,
    deletedPathKey: string,
  ) {
    // Remove provenance for deleted node and children
    removeProvenanceForSubtree(provenance, nodeIdMap, deletedPathKey);
    // Reindex the path→id mapping
    nodeIdMap = reindexNodeIdsAfterDelete(nodeIdMap, parentPath, deletedIndex, deletedPathKey);
  }

  function reindexMergedArrayAfterInsert(
    parentPath: string,
    insertedIndex: number,
  ) {
    nodeIdMap = reindexNodeIdsAfterInsert(nodeIdMap, parentPath, insertedIndex);
  }

  /**
   * Recalculate a parent node's provenance to reflect the panels present
   * among its children. Called after moving leaves between subconcepts.
   *
   * - If children now span both panels → ensure parent has sources from both (shows "both"/purple)
   * - If children are all from one panel → remove the other panel's source (shows "left"/"right")
   * - Walks up the tree to update ancestors too.
   */
  function updateParentProvenance(parentPath: string) {
    if (!parentPath) return;
    const parentNodeId = nodeIdMap.get(parentPath);
    if (!parentNodeId) return;
    const parentEntry = provenance.get(parentNodeId);
    if (!parentEntry) return;

    // Collect which panels are present in children
    const childPrefix = parentPath + "/";
    const childPanels = new Set<string>();
    for (const [path, nodeId] of nodeIdMap) {
      if (path.startsWith(childPrefix)) {
        const entry = provenance.get(nodeId);
        if (entry) {
          for (const s of entry.sources) {
            if (s.panel === "left" || s.panel === "right") {
              childPanels.add(s.panel);
            }
          }
        }
      }
    }

    // Rebuild the parent's left/right sources to match children
    // Keep non-left/right sources (user, llm) untouched
    const nonPanelSources = parentEntry.sources.filter(
      (s) => s.panel !== "left" && s.panel !== "right",
    );
    const panelSources = parentEntry.sources.filter(
      (s) => s.panel === "left" || s.panel === "right",
    );

    // For each panel present in children, ensure a source exists
    const newPanelSources: typeof panelSources = [];
    for (const panel of childPanels) {
      // Reuse existing source entry for this panel if available
      const existing = panelSources.find((s) => s.panel === panel);
      if (existing) {
        existing.action = childPanels.size >= 2 ? "merged" : "added";
        newPanelSources.push(existing);
      } else {
        // Create a new source entry — use parent path as originalPath
        newPanelSources.push({
          panel: panel as "left" | "right",
          originalPath: parentPath,
          action: childPanels.size >= 2 ? "merged" : "added",
        });
      }
    }

    parentEntry.sources = [...nonPanelSources, ...newPanelSources];

    // Walk up to update ancestors
    const lastSlash = parentPath.lastIndexOf("/");
    if (lastSlash > 0) {
      updateParentProvenance(parentPath.slice(0, lastSlash));
    }
  }

  // ============================================
  // EXPORT FUNCTIONS
  // ============================================

  /**
   * Export in unified v4 format (id-keyed with metadata).
   * Converts the name-keyed merge state back to stable ID keys, preserves full
   * concept metadata, and re-encodes lineage in v4 source shape.
   * Downloads as "suggested_merge.json" (re-importable by the webapp and notebook).
   */
  function exportWithLineage() {
    const snapshotMerged = $state.snapshot(mergedData) as any;

    // ── 1. Build name → id reverse lookups from conceptRegistry ─────────────
    // Keep separate maps per source so we can resolve ambiguous names using lineage.
    const leftNameToId = new Map<string, string>(); // pathout concepts
    const rightNameToId = new Map<string, string>(); // who concepts
    const mergedNameToId = new Map<string, string>(); // merged/llm concepts
    for (const [id, meta] of conceptRegistry) {
      if (meta.source === "pathout") {
        if (!leftNameToId.has(meta.name)) leftNameToId.set(meta.name, id);
      } else if (meta.source === "who") {
        if (!rightNameToId.has(meta.name)) rightNameToId.set(meta.name, id);
      } else {
        if (!mergedNameToId.has(meta.name)) mergedNameToId.set(meta.name, id);
      }
    }

    // ── 2. Helper: resolve a display name to a stable concept ID ─────────────
    // If linagePanel is given we prefer that source's registry.
    // Falls back to any registry, then to a freshly minted <MERGED-*> id.
    const mintedIds = new Map<string, string>(); // name → freshly minted id (stable within this export)
    function resolveId(
      name: string,
      preferSource?: "left" | "right" | "both" | null,
    ): string {
      if (preferSource === "left") {
        const id = leftNameToId.get(name);
        if (id) return id;
      } else if (preferSource === "right") {
        const id = rightNameToId.get(name);
        if (id) return id;
      }
      // Check merged registry first (already has a stable <MERGED-*> id)
      const mergedId = mergedNameToId.get(name);
      if (mergedId) return mergedId;
      // Fall back to either source
      const leftId = leftNameToId.get(name);
      if (leftId) return leftId;
      const rightId = rightNameToId.get(name);
      if (rightId) return rightId;
      // Mint a new <MERGED-*> id (stable for the duration of this call)
      if (!mintedIds.has(name)) {
        mintedIds.set(
          name,
          `<MERGED-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}>`,
        );
      }
      return mintedIds.get(name)!;
    }

    // ── 3. Build id-keyed v4 structure + collect exported concepts ───────────
    const exportedConcepts = new Map<string, ConceptMeta>();

    // Walk the name-keyed merged tree for a given path prefix to get the
    // preferred source panel for a node (from lineage).
    function getPreferredSource(
      namePath: string,
    ): "left" | "right" | "both" | null {
      const entry = getLineageForPath(namePath, nodeIdMap, provenance);
      if (!entry) return null;
      const panels = new Set(
        entry.sources
          .filter((s) => s.panel === "left" || s.panel === "right")
          .map((s) => s.panel as "left" | "right"),
      );
      if (panels.size === 2) return "both";
      if (panels.has("left")) return "left";
      if (panels.has("right")) return "right";
      return null;
    }

    /**
     * Build the concept metadata to store for a given merged-tree node.
     * When lineage shows sources from BOTH panels the metadata from all contributing
     * source concepts is unioned: synonyms/icd_codes/related_concepts are
     * deduplicated across sources; primary_reference keeps the first non-null value.
     */
    function buildConceptMeta(
      displayName: string,
      namePath: string,
      resolvedId: string,
    ): ConceptMeta {
      const entry = getLineageForPath(namePath, nodeIdMap, provenance);
      const leftRightSources =
        entry?.sources.filter(
          (s) => s.panel === "left" || s.panel === "right",
        ) ?? [];

      // Only union when there are contributions from multiple source panels
      const panels = new Set(leftRightSources.map((s) => s.panel));
      if (panels.size < 2) {
        // Single-source or no lineage: just return registry entry as-is
        return (
          conceptRegistry.get(resolvedId) ?? {
            name: displayName,
            source: "merged",
          }
        );
      }

      // Collect metadata for every contributing source concept
      const sourceMetas: ConceptMeta[] = [];
      for (const src of leftRightSources) {
        const nameMap = src.panel === "left" ? leftNameToId : rightNameToId;
        const segments = src.originalPath.split("/");
        const lastName = segments[segments.length - 1];
        const srcId = nameMap.get(lastName);
        if (srcId) {
          const meta = conceptRegistry.get(srcId);
          if (meta) sourceMetas.push(meta);
        }
      }

      // Also include the resolved concept's own registry entry if present
      const ownMeta = conceptRegistry.get(resolvedId);
      if (ownMeta) sourceMetas.unshift(ownMeta);

      if (sourceMetas.length === 0) {
        return { name: displayName, source: "merged" };
      }

      // Union all metadata fields
      const allSynonyms = sourceMetas.flatMap((m) => m.synonyms ?? []);
      const allIcdCodes = sourceMetas.flatMap((m) => m.icd_codes ?? []);
      const allRelated = sourceMetas.flatMap((m) => m.related_concepts ?? []);
      const primaryRef = sourceMetas.find(
        (m) => m.primary_reference,
      )?.primary_reference;

      return {
        name: displayName,
        source: "merged",
        synonyms: [...new Set(allSynonyms)],
        icd_codes: [...new Set(allIcdCodes)],
        related_concepts: [...new Set(allRelated)],
        ...(primaryRef ? { primary_reference: primaryRef } : {}),
      };
    }

    function buildStructure(node: any, namePath: string): any {
      if (Array.isArray(node)) {
        // Leaf array – each element is a concept name string
        return node.map((item: string, idx: number) => {
          const itemPath = namePath ? `${namePath}/${idx}` : String(idx);
          const pref = getPreferredSource(itemPath);
          const id = resolveId(item, pref);
          if (!exportedConcepts.has(id)) {
            exportedConcepts.set(id, buildConceptMeta(item, itemPath, id));
          }
          return id;
        });
      } else if (typeof node === "object" && node !== null) {
        // Branch node – dict keys are concept names
        const children: Record<string, any> = {};
        for (const [name, value] of Object.entries(node)) {
          const childNamePath = namePath ? `${namePath}/${name}` : name;
          const pref = getPreferredSource(childNamePath);
          const id = resolveId(name, pref);
          if (!exportedConcepts.has(id)) {
            exportedConcepts.set(id, buildConceptMeta(name, childNamePath, id));
          }
          children[id] = { children: buildStructure(value, childNamePath) };
        }
        return children;
      }
      return node;
    }

    const structure = buildStructure(snapshotMerged, "");

    // Register any freshly minted concepts
    for (const [name, id] of mintedIds) {
      if (!exportedConcepts.has(id)) {
        exportedConcepts.set(id, { name, source: "merged" });
      }
    }

    // ── 4. Build name-path → id-path map (for lineage key translation) ───────
    const namePathToIdPath = new Map<string, string>();

    function buildPathMap(
      nameNode: any,
      idChildren: any, // the "children" value of the parent id-node
      namePath: string,
      idPath: string,
    ) {
      if (Array.isArray(nameNode) && Array.isArray(idChildren)) {
        nameNode.forEach((_: string, i: number) => {
          const np = namePath ? `${namePath}/${i}` : String(i);
          const ip = idPath ? `${idPath}/${i}` : String(i);
          namePathToIdPath.set(np, ip);
        });
      } else if (typeof nameNode === "object" && nameNode !== null) {
        for (const [name, val] of Object.entries(nameNode)) {
          const np = namePath ? `${namePath}/${name}` : name;
          const pref = getPreferredSource(np);
          const id = resolveId(name, pref);
          const ip = idPath ? `${idPath}/${id}` : id;
          namePathToIdPath.set(np, ip);
          // Recurse: next level's idChildren is idChildren[id].children
          const nextIdChildren =
            (idChildren as Record<string, any>)?.[id]?.children ?? {};
          buildPathMap(val, nextIdChildren, np, ip);
        }
      }
    }

    buildPathMap(snapshotMerged, structure, "", "");

    // ── 5. Convert lineage to v4 format ──────────────────────────────────────
    // v4 lineage keys are id-paths; source shape is {source, originalId?, originalPath, action}
    const v4Lineage: Record<
      string,
      {
        sources: {
          source: string;
          originalId?: string;
          originalPath: string;
          action: string;
        }[];
      }
    > = {};

    // Build a name-path → ProvenanceEntry map from nodeIdMap+provenance
    const lineageExportMap = new Map<string, LineageEntry>();
    for (const [path, nodeId] of nodeIdMap) {
      const pEntry = provenance.get(nodeId);
      if (pEntry && pEntry.sources.length > 0) {
        lineageExportMap.set(path, pEntry);
      }
    }

    for (const [namePath, entry] of lineageExportMap.entries()) {
      const idPath = namePathToIdPath.get(namePath);
      if (!idPath) continue;

      const v4Sources = entry.sources.map((src) => {
        const sourceType =
          src.panel === "left"
            ? "pathout"
            : src.panel === "right"
              ? "who"
              : src.panel === "user"
                ? "merged"
                : "llm";

        // Resolve originalId: find the concept with this name in the right source registry
        let originalId: string | undefined;
        if (src.panel === "left" || src.panel === "right") {
          const nameMap = src.panel === "left" ? leftNameToId : rightNameToId;
          // Try to match by last path segment (concept display name)
          const segments = src.originalPath.split("/");
          const lastName = segments[segments.length - 1];
          originalId = nameMap.get(lastName);
          // Fallback: try exact path match from pathToId (gives internal id, not <TAG>)
          // We prefer the registry name-based lookup above.
        }

        return {
          source: sourceType,
          ...(originalId ? { originalId } : {}),
          originalPath: src.originalPath,
          action: src.action,
        };
      });

      v4Lineage[idPath] = { sources: v4Sources };
    }

    // ── 6. Assemble v4 export ─────────────────────────────────────────────────
    const exportData = {
      version: 4,
      format: "id-keyed-with-metadata",
      metadata: {
        source: loadedFromSuggestion
          ? (suggestionMetadata?.source ?? "webapp")
          : "webapp",
        llmModel: suggestionMetadata?.llmModel,
        sessionId: suggestionMetadata?.sessionId ?? crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        notes: loadedFromSuggestion
          ? `Edited in webapp. Original source: ${suggestionMetadata?.source}`
          : "Created in webapp",
      },
      ontologies: {
        left: { name: "PathologyOutlines", path: "data/pathout_v4.json" },
        right: {
          name: "WHO Classification of Tumours",
          path: "data/who_v4.json",
        },
      },
      concepts: Object.fromEntries(exportedConcepts),
      structure,
      lineage: v4Lineage,
      llmSuggestions: llmSuggestions ?? undefined,
      pendingReview: pendingReviews ?? [],
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    downloadFile(jsonStr, "suggested_merge.json", "application/json");
  }

  /**
   * Export in v5 format — mirrors internal state directly.
   * Name-keyed tree, stable UUIDs, provenance stored as-is.
   */
  function exportV5() {
    const exportData: V5MergeFile = {
      version: 5,
      format: "name-keyed-with-provenance",
      metadata: {
        source: loadedFromSuggestion
          ? (suggestionMetadata?.source ?? "webapp")
          : "webapp",
        llmModel: suggestionMetadata?.llmModel,
        sessionId: suggestionMetadata?.sessionId ?? crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        notes: loadedFromSuggestion
          ? `Edited in webapp. Original source: ${suggestionMetadata?.source}`
          : "Created in webapp",
      },
      ontologies: {
        left: { name: "PathologyOutlines", path: "data/pathout_v4.json" },
        right: {
          name: "WHO Classification of Tumours",
          path: "data/who_v4.json",
        },
      },
      mergedData: $state.snapshot(mergedData),
      nodeIdMap: serializeNodeIdMap(nodeIdMap),
      provenance: serializeProvenance(provenance),
      concepts: Object.fromEntries(conceptRegistry),
      llmSuggestions: llmSuggestions ?? undefined,
      pendingReview: pendingReviews ?? [],
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    downloadFile(jsonStr, "merge_v5.json", "application/json");
  }

  /**
   * Recursively force lowercase for all term fields (name, synonyms).
   * Applied to imported data to ensure consistent casing.
   */
  function forceLowercaseTerms(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") return obj.toLowerCase();
    if (Array.isArray(obj)) {
      return obj.map((item) => forceLowercaseTerms(item));
    }
    if (typeof obj === "object") {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === "name" || key === "synonyms") {
          // Force lowercase for term fields
          if (typeof value === "string") {
            result[key] = value.toLowerCase();
          } else if (Array.isArray(value)) {
            result[key] = value.map((v) =>
              typeof v === "string" ? v.toLowerCase() : v,
            );
          } else {
            result[key] = forceLowercaseTerms(value);
          }
        } else {
          result[key] = forceLowercaseTerms(value);
        }
      }
      return result;
    }
    return obj;
  }

  /**
   * Handle importing a unified merge file (v1 or v2 format).
   * Loads mergedData, lineage, sourceMap, and metadata from the uploaded JSON.
   *
   * @param event - The file input change event
   */
  function handleImportFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const imported = JSON.parse(content);

        // Helper to import a path-keyed lineage map into provenance
        function importLineageToProvenance(
          importedLineage: Record<string, any>,
          data: unknown,
        ) {
          const newNodeIdMap = new Map<string, string>();
          const newProvenance = new Map<string, ProvenanceEntry>();
          assignNodeIds(data, "", newNodeIdMap);
          for (const [path, entry] of Object.entries(importedLineage)) {
            const typedEntry = entry as any;
            const nodeId = newNodeIdMap.get(path);
            if (nodeId) {
              newProvenance.set(nodeId, {
                sources: (typedEntry.sources || []).map((s: any) => ({
                  panel: s.panel as ProvenancePanel,
                  originalPath: s.originalPath as string,
                  action: (s.action || "added") as ProvenanceAction,
                })),
              });
            }
          }
          nodeIdMap = newNodeIdMap;
          provenance = newProvenance;
        }

        // Handle v1, v2, and v4 formats
        if (imported.version === 1) {
          mergedData = forceLowercaseTerms(structuredClone(imported.data));
          if (imported.lineage) {
            importLineageToProvenance(imported.lineage, mergedData);
          } else {
            nodeIdMap = new Map();
            provenance = new Map();
            assignNodeIds(mergedData, "", nodeIdMap);
          }
        } else if (imported.version === 2) {
          mergedData = forceLowercaseTerms(structuredClone(imported.mergedData));
          suggestionMetadata = imported.metadata;
          pendingReviews = imported.pendingReview || [];
          llmSuggestions = imported.llmSuggestions || null;
          loadedFromSuggestion = imported.metadata?.source === "llm";
          if (imported.lineage) {
            importLineageToProvenance(imported.lineage, mergedData);
          } else {
            nodeIdMap = new Map();
            provenance = new Map();
            assignNodeIds(mergedData, "", nodeIdMap);
          }
        } else if (imported.version === 4) {
          const v4sm = imported as SuggestedMergeV4;
          suggestionMetadata = v4sm.metadata;
          pendingReviews = v4sm.pendingReview || [];
          llmSuggestions = v4sm.llmSuggestions || null;
          loadedFromSuggestion = v4sm.metadata?.source === "llm";

          // Merge v4 concept metadata into the registry
          for (const [id, meta] of Object.entries(v4sm.concepts)) {
            conceptRegistry.set(id, meta);
          }
          conceptRegistry = new Map(conceptRegistry);

          // Convert v4 id-keyed structure to name-keyed tree
          mergedData = forceLowercaseTerms(
            v4StructureToNameTree(v4sm.structure, v4sm.concepts),
          );

          // Assign node IDs for the merged tree
          const newNodeIdMap = new Map<string, string>();
          assignNodeIds(mergedData, "", newNodeIdMap);

          // Translate v4 lineage (ID-keyed) → provenance
          const idToNamePath = buildV4IdToNamePath(v4sm.structure, v4sm.concepts);
          const leftNameToPath = buildNameToSourcePath(leftPathToId);
          const rightNameToPath = buildNameToSourcePath(rightPathToId);
          const newLineage = translateV4Lineage(
            v4sm.lineage ?? {},
            idToNamePath,
            v4sm.concepts,
            leftNameToPath,
            rightNameToPath,
          );

          // Fill missing lineage for leaf array items
          function fillLineageV4(obj: unknown, basePath: string) {
            if (obj && typeof obj === "object") {
              if (Array.isArray(obj)) {
                obj.forEach((item, idx) => {
                  const childPath = `${basePath}/${idx}`;
                  if (!newLineage.has(childPath)) {
                    const parentLineage = newLineage.get(basePath);
                    if (parentLineage) {
                      newLineage.set(childPath, {
                        sources: parentLineage.sources.map((s) => ({
                          ...s,
                          originalPath: `${s.originalPath}/${idx}`,
                        })),
                      });
                    }
                  }
                  fillLineageV4(item, childPath);
                });
              } else {
                Object.entries(obj as Record<string, unknown>).forEach(
                  ([key, val]) => {
                    const childPath = basePath ? `${basePath}/${key}` : key;
                    if (!newLineage.has(childPath)) {
                      const parentLineage = newLineage.get(basePath);
                      if (parentLineage) {
                        newLineage.set(childPath, {
                          sources: parentLineage.sources.map((s) => ({
                            ...s,
                            originalPath: `${s.originalPath}/${key}`,
                          })),
                        });
                      }
                    }
                    fillLineageV4(val, childPath);
                  },
                );
              }
            }
          }
          fillLineageV4(mergedData, "");

          // Convert lineage map to provenance
          const newProvenance = new Map<string, ProvenanceEntry>();
          for (const [path, entry] of newLineage) {
            const nodeId = newNodeIdMap.get(path);
            if (nodeId) {
              newProvenance.set(nodeId, { sources: entry.sources.map((s) => ({ ...s })) });
            }
          }

          nodeIdMap = newNodeIdMap;
          provenance = newProvenance;
        } else if (imported.version === 5) {
          const v5 = imported as V5MergeFile;
          suggestionMetadata = v5.metadata as SuggestedMerge["metadata"];
          pendingReviews = (v5.pendingReview || []) as SuggestedMerge["pendingReview"];
          llmSuggestions = v5.llmSuggestions as SuggestedMerge["llmSuggestions"] || null;
          loadedFromSuggestion = v5.metadata?.source === "llm";

          // Merge v5 concept metadata into the registry
          for (const [id, meta] of Object.entries(v5.concepts)) {
            conceptRegistry.set(id, meta as ConceptMeta);
          }
          conceptRegistry = new Map(conceptRegistry);

          // Direct restore — no conversion needed
          mergedData = v5.mergedData;
          nodeIdMap = deserializeNodeIdMap(v5.nodeIdMap);
          provenance = deserializeProvenance(v5.provenance);
        }

        console.log("Imported merge file successfully");
      } catch (err) {
        console.error("Failed to import file:", err);
        alert("Failed to import file. Please ensure it's a valid merge file.");
      }
    };
    reader.readAsText(file);

    // Reset input so same file can be selected again
    input.value = "";
  }

  /**
   * Trigger a file download in the browser.
   *
   * @param content - The file content as a string
   * @param filename - The name for the downloaded file
   * @param mimeType - The MIME type (e.g., "application/json")
   */
  function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ============================================
  // UNDO/REDO FUNCTIONALITY
  // ============================================

  type HistorySnapshot = {
    mergedData: any;
    nodeIdMap: Map<string, string>;
    provenance: Map<string, ProvenanceEntry>;
  };

  const MAX_HISTORY_SIZE = 50;
  let historyStack = $state<HistorySnapshot[]>([]);
  let redoStack = $state<HistorySnapshot[]>([]);

  function takeSnapshot(): HistorySnapshot {
    return {
      mergedData: structuredClone($state.snapshot(mergedData)),
      nodeIdMap: new Map($state.snapshot(nodeIdMap) as Map<string, string>),
      provenance: cloneProvenance($state.snapshot(provenance) as Map<string, ProvenanceEntry>),
    };
  }

  function restoreSnapshot(snapshot: HistorySnapshot) {
    mergedData = snapshot.mergedData;
    nodeIdMap = snapshot.nodeIdMap;
    provenance = snapshot.provenance;
  }

  function saveToHistory() {
    historyStack.push(takeSnapshot());
    if (historyStack.length > MAX_HISTORY_SIZE) {
      historyStack.shift();
    }
    redoStack = [];
    historyStack = [...historyStack];
  }

  function undo() {
    if (historyStack.length === 0) return;
    redoStack.push(takeSnapshot());
    redoStack = [...redoStack];
    const snapshot = historyStack.pop()!;
    historyStack = [...historyStack];
    restoreSnapshot(snapshot);
  }

  function redo() {
    if (redoStack.length === 0) return;
    historyStack.push(takeSnapshot());
    historyStack = [...historyStack];
    const snapshot = redoStack.pop()!;
    redoStack = [...redoStack];
    restoreSnapshot(snapshot);
  }

  // Derived state for UI
  let canUndo = $derived(historyStack.length > 0);
  let canRedo = $derived(redoStack.length > 0);

  // Subscription system removed — provenance is the single source of truth.
  // Usage status is derived via buildUsageMap from provenance.ts.

  // ============================================
  // PATH NORMALIZATION HELPERS
  // ============================================

  /**
   * Find a matching path in the pathToId map, handling normalization.
   * Tries exact match, then trimmed, then with "(5th ed.)" suffix stripped.
   *
   * @param originalPath - The path to look up
   * @param pathToId - Map of paths to IDs to search in
   * @returns The matching path key, or null if not found
   */
  function findMatchingPath(
    originalPath: string,
    pathToId: Map<string, string>,
  ): string | null {
    // Exact match
    if (pathToId.has(originalPath)) return originalPath;

    // Try with stripped whitespace
    const trimmed = originalPath.trim();
    if (pathToId.has(trimmed)) return trimmed;

    // Normalize common naming variants and edition suffixes for matching
    const normalizeForPathMatch = (s: string) =>
      s
        .replace(/\(5th ed\.\)/g, "")
        .replace(/tumours/g, "tumors")
        .replace(/tumour/g, "tumor")
        .trim();

    const normalizedPath = normalizeForPathMatch(originalPath);
    const normalizedTrimmed = normalizeForPathMatch(trimmed);
    for (const key of pathToId.keys()) {
      const keyNormalized = normalizeForPathMatch(key);
      if (
        keyNormalized === normalizedPath ||
        keyNormalized === normalizedTrimmed
      ) {
        return key;
      }
    }

    return null;
  }

  function getOriginalPathFromLineage(
    mergedPath: string,
    panel: "left" | "right",
  ): string | null {
    const entry = getLineageForPath(mergedPath, nodeIdMap, provenance);
    if (!entry) return null;
    const match = entry.sources.find((s) => s.panel === panel);
    return match?.originalPath ?? null;
  }

  function getOriginalPathForMergedDrag(
    mergedPath: string,
    panel: "left" | "right",
  ): string {
    return (
      getOriginalPathFromLineage(mergedPath, panel) ||
      findMatchingPath(
        mergedPath,
        panel === "left" ? leftPathToId : rightPathToId,
      ) ||
      mergedPath
    );
  }

  // ============================================
  // DERIVED USAGE MAPS FOR TREE VIEW
  // ============================================

  // Build path -> sourceId mapping for source panels (used for hover/highlight lookups)
  let leftPathToId = $state<Map<string, string>>(new Map());
  let rightPathToId = $state<Map<string, string>>(new Map());

  /**
   * Initialize path-to-ID mappings for a source data tree.
   */
  function initializePathIds(
    obj: any,
    basePath: string,
    pathToId: Map<string, string>,
  ) {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        const path = basePath ? `${basePath}/${idx}` : String(idx);
        if (!pathToId.has(path)) {
          pathToId.set(path, generateNodeId());
        }
        initializePathIds(item, path, pathToId);
      });
    } else {
      Object.entries(obj).forEach(([key, value]) => {
        const path = basePath ? `${basePath}/${key}` : key;
        if (!pathToId.has(path)) {
          pathToId.set(path, generateNodeId());
        }
        initializePathIds(value, path, pathToId);
      });
    }
  }

  // Derive usage maps from provenance
  let leftUsageMap = $derived.by(() => buildUsageMap("left", leftPathToId, provenance));
  let rightUsageMap = $derived.by(() => buildUsageMap("right", rightPathToId, provenance));

  /**
   * Build a name → first matching path reverse map from a pathToId map.
   * Used to resolve a concept name back to its full source-panel path for
   * subscription tracking (highlighting used items in the source panels).
   *
   * e.g. "Astrocytic tumors" → "Neuropathology/Brain tumors/Astrocytic tumors"
   */
  function buildNameToSourcePath(
    pathToId: Map<string, string>,
  ): Map<string, string> {
    const nameToPath = new Map<string, string>();
    for (const path of pathToId.keys()) {
      const segments = path.split("/");
      const lastName = segments[segments.length - 1];
      // Skip numeric array indices
      if (/^\d+$/.test(lastName)) continue;
      if (!nameToPath.has(lastName)) {
        nameToPath.set(lastName, path);
      }
    }
    return nameToPath;
  }

  /**
   * Walk a v4 id-keyed structure and produce a map from ID-path to name-path.
   * e.g. "<MERGED-abc>/<PATHOUT-123>" → "Central Nervous System Pathology/Brain tumors"
   */
  function buildV4IdToNamePath(
    structure: Record<string, any>,
    concepts: Record<string, ConceptMeta>,
    idPrefix: string = "",
    namePrefix: string = "",
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const [id, node] of Object.entries(structure)) {
      const name = concepts[id]?.name ?? id;
      const idPath = idPrefix ? `${idPrefix}/${id}` : id;
      const namePath = namePrefix ? `${namePrefix}/${name}` : name;
      map.set(idPath, namePath);

      const children = node?.children;
      if (
        children &&
        typeof children === "object" &&
        !Array.isArray(children)
      ) {
        const childMap = buildV4IdToNamePath(
          children,
          concepts,
          idPath,
          namePath,
        );
        for (const [k, v] of childMap) map.set(k, v);
      } else if (Array.isArray(children)) {
        // Leaf array items get numeric indices as path segments
        children.forEach((_childId: string, idx: number) => {
          map.set(`${idPath}/${idx}`, `${namePath}/${idx}`);
        });
      }
    }
    return map;
  }

  /**
   * Translate a v4 id-keyed lineage into a name-keyed LineageEntry map
   * compatible with the frontend's subscription and lineage systems.
   *
   * - Keys:           "<MERGED-abc>/<PATHOUT-123>" → "CNS Pathology/Brain tumors"
   * - Source fields:  {source, originalId, action} → {panel, originalPath, action}
   * - originalPath:   resolved from the source panel name→path reverse map
   */
  function translateV4Lineage(
    v4lineage: Record<string, any>,
    idToNamePath: Map<string, string>,
    v4concepts: Record<string, ConceptMeta>,
    leftNameToPath: Map<string, string>,
    rightNameToPath: Map<string, string>,
  ): Map<string, LineageEntry> {
    const newLineage = new Map<string, LineageEntry>();

    for (const [idPath, entry] of Object.entries(v4lineage)) {
      const namePath = idToNamePath.get(idPath);
      if (!namePath) continue;

      const sources = (entry as any).sources || [];
      const translatedSources: LineageSource[] = sources.map((s: any) => {
        const conceptSource: string = s.source ?? "merged";
        const panel: LineageSource["panel"] =
          conceptSource === "pathout"
            ? "left"
            : conceptSource === "who"
              ? "right"
              : conceptSource === "merged"
                ? "llm"
                : "user";

        // Resolve originalPath: find the concept's path in the source panel tree
        let originalPath = namePath; // fallback
        if ((panel === "left" || panel === "right") && s.originalId) {
          const conceptName = v4concepts[s.originalId]?.name;
          if (conceptName) {
            const sourcePathMap =
              panel === "left" ? leftNameToPath : rightNameToPath;
            originalPath = sourcePathMap.get(conceptName) ?? conceptName;
          }
        }

        const rawAction: string = s.action ?? "added";
        const action: LineageSource["action"] =
          rawAction === "llm-suggested"
            ? "llm-suggested"
            : rawAction === "llm-auto-merged"
              ? "llm-auto-merged"
              : rawAction === "created"
                ? "created"
                : "added";

        return { panel, originalPath, action };
      });

      newLineage.set(namePath, { sources: translatedSources });
    }

    return newLineage;
  }

  /**
   * Convert a v4 id-keyed structure back to a name-keyed tree.
   * Used when loading a v4 suggestedMerge file into the merge panel.
   *
   * @param structure - The id-keyed structure from a v4 file
   * @param concepts - The concept metadata map (id -> ConceptMeta)
   * @returns Name-keyed tree compatible with the merge panel
   */
  function v4StructureToNameTree(
    structure: Record<string, any>,
    concepts: Record<string, ConceptMeta>,
  ): any {
    function processNode(node: any): any {
      const children = node?.children;
      if (!children) return [];
      if (Array.isArray(children)) {
        // Leaf array: IDs → names
        return children.map(
          (childId: string) => concepts[childId]?.name ?? childId,
        );
      }
      // Object: child-id keys → process recursively
      const result: Record<string, any> = {};
      for (const [childId, childNode] of Object.entries(
        children as Record<string, any>,
      )) {
        const name = concepts[childId]?.name ?? childId;
        result[name] = processNode(childNode);
      }
      return result;
    }

    const result: Record<string, any> = {};
    for (const [nodeId, node] of Object.entries(structure)) {
      const name = concepts[nodeId]?.name ?? nodeId;
      result[name] = processNode(node);
    }
    return result;
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  $effect(() => {
    if (!initialized && data.left && data.right) {
      leftData = structuredClone(data.left);
      rightData = structuredClone(data.right);

      // Initialize path-to-ID mappings for source panels
      initializePathIds(leftData, "", leftPathToId);
      initializePathIds(rightData, "", rightPathToId);
      leftPathToId = new Map(leftPathToId);
      rightPathToId = new Map(rightPathToId);

      // Populate concept registry from v4 source ontology metadata
      const newRegistry = new Map<string, ConceptMeta>();
      if (data.leftRegistry) {
        for (const [id, meta] of Object.entries(data.leftRegistry)) {
          newRegistry.set(id, meta);
        }
      }
      if (data.rightRegistry) {
        for (const [id, meta] of Object.entries(data.rightRegistry)) {
          newRegistry.set(id, meta);
        }
      }
      conceptRegistry = newRegistry;
      console.log(`Loaded concept registry: ${newRegistry.size} concepts`);

      initialized = true;
    }
  });

  // ============================================
  // SUBSCRIPTION MANAGEMENT FOR DROPS
  // ============================================

  /**
   * Record provenance for a merged item and all its children.
   * Ensures nodeIdMap entries exist for all paths.
   *
   * @param mergedPath - Path in the merged panel
   * @param sourcePath - Corresponding path in the source panel
   * @param source - Which source panel ("left" or "right")
   * @param value - The value/subtree being tracked
   * @param isMerged - Whether this is part of a merge operation
   * @param trackLineage - Whether to record provenance (default: true)
   * @param mergedTree - When provided, use actual merged state for correct array index mapping
   */
  function subscribeItemAndChildren(
    mergedPath: string,
    sourcePath: string,
    source: "left" | "right",
    value: unknown,
    isMerged: boolean = false,
    trackLineage: boolean = true,
    mergedTree?: unknown,
  ) {
    // Ensure nodeIdMap entry exists
    if (!nodeIdMap.has(mergedPath)) {
      nodeIdMap.set(mergedPath, generateNodeId());
    }

    if (trackLineage) {
      const action: ProvenanceAction = isMerged ? "merged" : "added";
      addLineage(mergedPath, source, sourcePath, action);
    }

    // Recursively process children
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        if (mergedTree && Array.isArray(mergedTree)) {
          value.forEach((item, srcIdx) => {
            const mergedIdx = (mergedTree as unknown[]).findIndex(
              (ex) => typeof ex === typeof item && String(ex) === String(item),
            );
            if (mergedIdx !== -1) {
              const childMergedPath = `${mergedPath}/${mergedIdx}`;
              const existingEntry = getLineageForPath(childMergedPath, nodeIdMap, provenance);
              const itemIsMerged = existingEntry
                ? existingEntry.sources.some((s) => (s.panel === "left" || s.panel === "right") && s.panel !== source)
                : false;
              subscribeItemAndChildren(
                childMergedPath,
                `${sourcePath}/${srcIdx}`,
                source,
                item,
                itemIsMerged,
                trackLineage,
                (mergedTree as unknown[])[mergedIdx],
              );
            }
          });
        } else if (mergedTree && typeof mergedTree === "object" && !Array.isArray(mergedTree)) {
          value.forEach((item, srcIdx) => {
            const itemKey = String(item);
            if (itemKey in (mergedTree as Record<string, unknown>)) {
              const childMergedPath = `${mergedPath}/${itemKey}`;
              const existingEntry = getLineageForPath(childMergedPath, nodeIdMap, provenance);
              const itemIsMerged = existingEntry
                ? existingEntry.sources.some((s) => (s.panel === "left" || s.panel === "right") && s.panel !== source)
                : false;
              subscribeItemAndChildren(
                childMergedPath,
                `${sourcePath}/${srcIdx}`,
                source,
                item,
                itemIsMerged,
                trackLineage,
                (mergedTree as Record<string, unknown>)[itemKey],
              );
            }
          });
        } else {
          value.forEach((item, idx) => {
            subscribeItemAndChildren(
              `${mergedPath}/${idx}`,
              `${sourcePath}/${idx}`,
              source,
              item,
              false,
              trackLineage,
            );
          });
        }
      } else {
        Object.entries(value as Record<string, unknown>).forEach(([key, val]) => {
          const childMergedPath = `${mergedPath}/${key}`;
          const mergedChild =
            mergedTree && typeof mergedTree === "object" && !Array.isArray(mergedTree)
              ? (mergedTree as Record<string, unknown>)[key]
              : undefined;
          // Check if child already has provenance from the other panel → merge
          const existingEntry = getLineageForPath(childMergedPath, nodeIdMap, provenance);
          const childIsMerged = existingEntry
            ? existingEntry.sources.some((s) => (s.panel === "left" || s.panel === "right") && s.panel !== source)
            : false;
          subscribeItemAndChildren(
            childMergedPath,
            `${sourcePath}/${key}`,
            source,
            val,
            childIsMerged,
            trackLineage,
            mergedChild,
          );
        });
      }
    }
  }

  /**
   * Remove provenance for a merged item and all its children.
   */
  function unsubscribeItemAndChildren(mergedPath: string) {
    removeLineage(mergedPath);
    // Also remove nodeIdMap entries
    const prefix = mergedPath + "/";
    const nodeId = nodeIdMap.get(mergedPath);
    if (nodeId) provenance.delete(nodeId);
    nodeIdMap.delete(mergedPath);
    for (const [path] of [...nodeIdMap.entries()]) {
      if (path.startsWith(prefix)) {
        const id = nodeIdMap.get(path);
        if (id) provenance.delete(id);
        nodeIdMap.delete(path);
      }
    }
  }

  /**
   * Mark a merged item and all its children's provenance as "merged".
   */
  function markItemAsMerged(mergedPath: string) {
    markLineageAsMerged(mergedPath);
    // Also mark all children
    const prefix = mergedPath + "/";
    for (const [path] of nodeIdMap) {
      if (path.startsWith(prefix)) {
        markLineageAsMerged(path);
      }
    }
  }

  /**
   * Handle a drag-and-drop operation between panels.
   * Manages moving/copying items, merging, provenance, and nodeIdMap updates.
   *
   * @param targetPanel - Panel being dropped onto ("left", "right", "merged")
   * @param targetPath - Path in target panel where item is dropped
   * @param key - Key/name of the dragged item
   * @param value - Value/subtree of the dragged item
   * @param sourcePath - Full path including panel of the dragged item
   * @param insertBefore - If set, insert before this sibling key
   * @param isArrayItem - Whether the dragged item is an array element
   * @param dropOnExpandedSection - Whether dropping into an expanded section
   * @param mergeWithLeafItem - If set, merge with this specific leaf item
   */
  function handleDrop(
    targetPanel: string,
    targetPath: string[],
    key: string,
    value: unknown,
    sourcePath: string[],
    insertBefore?: string,
    isArrayItem?: boolean,
    dropOnExpandedSection?: boolean,
    mergeWithLeafItem?: {
      path: string[];
      key: string;
      isArrayItem: boolean;
    } | null,
  ) {
    const sourcePanel = sourcePath[0];
    // Don't allow dropping onto itself
    // For leaf merges, compare source path to mergeWithLeafItem.path (the actual target)
    const sourcePathStr = sourcePath.slice(1).join("/");
    const targetPathStr = mergeWithLeafItem
      ? mergeWithLeafItem.path.slice(1).join("/") // slice(1) to remove panel prefix
      : [...targetPath, key].join("/");

    if (sourcePanel === targetPanel && sourcePathStr === targetPathStr) {
      console.log("Dropping onto itself, aborting");
      return;
    }

    // Save state for undo before any modifications
    saveToHistory();

    // Get the appropriate data objects
    const dataSources: Record<string, any> = {
      left: leftData,
      right: rightData,
      merged: mergedData,
    };

    console.log(
      "handleDrop called with mergeWithLeafItem:",
      mergeWithLeafItem,
      "targetPanel:",
      targetPanel,
    );

    // For leaf merges from merged panel, capture provenance for the ENTIRE subtree BEFORE removing
    let draggedSourceForLeafMerge: string | undefined;
    let draggedLineageForLeafMerge: LineageEntry | undefined;
    let draggedChildLineageMap: Map<string, LineageEntry> | undefined;
    if (mergeWithLeafItem && sourcePanel === "merged") {
      const draggedSourcePath = sourcePath.slice(1).join("/");
      draggedSourceForLeafMerge = sourceMap.get(draggedSourcePath);
      // CRITICAL: Capture provenance BEFORE it gets removed during reindexing
      const draggedLineageEntry = getLineageForPath(draggedSourcePath, nodeIdMap, provenance);
      if (draggedLineageEntry) {
        draggedLineageForLeafMerge = {
          sources: draggedLineageEntry.sources.map((s) => ({ ...s })),
        };
      }
      // Capture children's provenance too (suffix relative to dragged root)
      const childPrefix = draggedSourcePath + "/";
      draggedChildLineageMap = new Map();
      for (const [path, nodeId] of nodeIdMap) {
        if (path.startsWith(childPrefix)) {
          const entry = provenance.get(nodeId);
          if (entry && entry.sources.length > 0) {
            const relativeSuffix = path.slice(draggedSourcePath.length); // e.g. "/childKey"
            draggedChildLineageMap.set(relativeSuffix, {
              sources: entry.sources.map((s) => ({ ...s })),
            });
          }
        }
      }
    }

    // Remove from source - but only if dragging within the merged panel
    // When dragging from left/right to merged, keep the original (duplicate it)
    // For merged panel moves (non-leaf-merge): capture provenance, remove, clean up, and reindex
    // Leaf merges handle their own provenance capture/cleanup above.
    let capturedProvenanceForMove: LineageEntry | undefined;
    let capturedChildProvenanceForMove: Map<string, LineageEntry> | undefined;
    if (sourcePanel === "merged") {
      if (!mergeWithLeafItem) {
        const dragSrcPath = sourcePath.slice(1).join("/");

        // Capture provenance for the moved item and its children BEFORE removal
        const topEntry = getLineageForPath(dragSrcPath, nodeIdMap, provenance);
        if (topEntry) {
          capturedProvenanceForMove = { sources: topEntry.sources.map((s) => ({ ...s })) };
        }
        const childPrefix = dragSrcPath + "/";
        capturedChildProvenanceForMove = new Map();
        for (const [path, nodeId] of nodeIdMap) {
          if (path.startsWith(childPrefix)) {
            const entry = provenance.get(nodeId);
            if (entry && entry.sources.length > 0) {
              capturedChildProvenanceForMove.set(path.slice(dragSrcPath.length), {
                sources: entry.sources.map((s) => ({ ...s })),
              });
            }
          }
        }

        // Clean up provenance at old path
        unsubscribeItemAndChildren(dragSrcPath);

        // Reindex source array siblings if this was an array item
        if (isArrayItem) {
          const draggedIndex = parseInt(sourcePath[sourcePath.length - 1], 10);
          if (!isNaN(draggedIndex)) {
            const parentPath = sourcePath.slice(1, -1).join("/");
            reindexMergedArrayAfterDelete(parentPath, draggedIndex, dragSrcPath);
          }
        }
      }

      const sourceData = dataSources[sourcePanel];
      if (sourceData) {
        removeFromData(sourceData, sourcePath.slice(1));
      }
    }

    // Handle leaf item merging (dropping one concept onto another)
    if (mergeWithLeafItem && targetPanel === "merged") {
      console.log("Leaf item merge:", key, "onto", mergeWithLeafItem.key);
      console.log(
        "mergeWithLeafItem.path:",
        JSON.stringify(mergeWithLeafItem.path),
      );

      const draggedSourcePath = sourcePath.slice(1).join("/");
      let draggedSource: string = sourcePanel;
      if (sourcePanel === "merged" && draggedSourceForLeafMerge) {
        draggedSource = draggedSourceForLeafMerge;
      }

      // mergeWithLeafItem.path does NOT include the panel prefix, so use it directly
      const originalTargetPath = mergeWithLeafItem.path.join("/");
      let targetItemPath = originalTargetPath;

      // If dragged item was from merged panel and same array, we need to:
      // 1. Reindex sourceMap entries
      // 2. Adjust target path if needed
      const draggedPath = sourcePath.slice(1);
      const targetPath = mergeWithLeafItem.path; // No slice needed

      if (
        sourcePanel === "merged" &&
        isArrayItem &&
        draggedPath.length === targetPath.length &&
        draggedPath.slice(0, -1).join("/") === targetPath.slice(0, -1).join("/")
      ) {
        // Same array: reindex siblings and adjust target path
        const draggedIndex = parseInt(draggedPath[draggedPath.length - 1]);
        const targetIndex = parseInt(targetPath[targetPath.length - 1]);
        const parentPath = draggedPath.slice(0, -1).join("/");
        const parentPrefix = parentPath ? parentPath + "/" : "";

        reindexMergedArrayAfterDelete(
          parentPath,
          draggedIndex,
          draggedSourcePath,
        );

        // Adjust target path if needed (target shifted down because dragged was before it)
        if (
          !isNaN(draggedIndex) &&
          !isNaN(targetIndex) &&
          draggedIndex < targetIndex
        ) {
          const adjustedIndex = targetIndex - 1;
          targetItemPath = parentPrefix + adjustedIndex;
          console.log(
            "Adjusted target path from",
            originalTargetPath,
            "to",
            targetItemPath,
          );
        }
      } else if (sourcePanel === "merged") {
        // Cross-array or non-array item: clean up dragged item's provenance
        unsubscribeItemAndChildren(draggedSourcePath);

        // NOTE: Children's stale entries are cleaned up AFTER the section merge
        // and provenance logic below, so that new entries at target paths are
        // created before old entries at dragged paths are removed.

        // If the dragged item was an array item, reindex its former siblings
        if (isArrayItem) {
          const draggedIndex = parseInt(
            draggedPath[draggedPath.length - 1],
            10,
          );
          if (!isNaN(draggedIndex)) {
            const parentPath = draggedPath.slice(0, -1).join("/");
            reindexMergedArrayAfterDelete(
              parentPath,
              draggedIndex,
              draggedSourcePath,
            );
          }
        }
      }

      // Section merge: if the dragged item has children (object/array value),
      // merge its children into the target section before updating metadata.
      // This handles sibling section merges (e.g., merging "Myeloma" into "Leukemia").
      let sectionMergeTargetValue: unknown = undefined;
      // For array-array merges: maps old dragged index → new merged index
      let arrayMergeIndexMap: Map<number, number> | undefined;
      if (value && typeof value === "object") {
        // Navigate to the target item in merged data
        let targetParent: any = mergedData;
        const targetSegments = mergeWithLeafItem.path;
        for (let i = 0; i < targetSegments.length - 1; i++) {
          if (
            targetParent &&
            targetParent[targetSegments[i]] !== undefined
          ) {
            targetParent = targetParent[targetSegments[i]];
          }
        }
        const targetKey = targetSegments[targetSegments.length - 1];
        const targetValue = targetParent[targetKey];

        if (Array.isArray(targetValue) && Array.isArray(value)) {
          // Array-array merge: add non-duplicate items from dragged into target
          // Track where each dragged item ends up in the merged array
          arrayMergeIndexMap = new Map();
          let nextIdx = targetValue.length;
          for (let i = 0; i < (value as unknown[]).length; i++) {
            const item = (value as unknown[])[i];
            const existingIdx = targetValue.findIndex(
              (ex: unknown) =>
                typeof ex === typeof item && String(ex) === String(item),
            );
            if (existingIdx !== -1) {
              // Duplicate — maps to existing index
              arrayMergeIndexMap.set(i, existingIdx);
            } else {
              targetValue.push(item);
              arrayMergeIndexMap.set(i, nextIdx++);
            }
          }
          sectionMergeTargetValue = targetValue;
        } else if (
          typeof targetValue === "object" &&
          targetValue !== null &&
          !Array.isArray(targetValue) &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          // Object-object merge: add keys from dragged, merge matching sub-keys
          for (const [k, v] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (!(k in (targetValue as Record<string, unknown>))) {
              (targetValue as Record<string, unknown>)[k] = v;
            } else {
              const targetSub = (targetValue as Record<string, unknown>)[k];
              if (Array.isArray(targetSub) && Array.isArray(v)) {
                // Array+Array: merge items
                for (const item of v as unknown[]) {
                  const isDuplicate = targetSub.some(
                    (ex: unknown) =>
                      typeof ex === typeof item &&
                      String(ex) === String(item),
                  );
                  if (!isDuplicate) {
                    targetSub.push(item);
                  }
                }
              } else if (
                Array.isArray(targetSub) &&
                typeof v === "object" &&
                v !== null &&
                !Array.isArray(v)
              ) {
                // Array target + Object dragged: convert array to object, merge
                const converted: Record<string, unknown> = {};
                for (const item of targetSub) {
                  converted[String(item)] = null;
                }
                for (const [dk, dv] of Object.entries(
                  v as Record<string, unknown>,
                )) {
                  if (!(dk in converted)) {
                    converted[dk] = dv;
                  }
                }
                (targetValue as Record<string, unknown>)[k] = converted;
                // Remap nodeIdMap: old index-based → key-based paths
                const subPath = targetItemPath ? `${targetItemPath}/${k}` : k;
                for (let i = 0; i < targetSub.length; i++) {
                  nodeIdMap = remapNodeIdPaths(
                    nodeIdMap,
                    `${subPath}/${i}`,
                    `${subPath}/${String(targetSub[i])}`,
                  );
                }
              } else if (
                typeof targetSub === "object" &&
                targetSub !== null &&
                !Array.isArray(targetSub) &&
                Array.isArray(v)
              ) {
                // Object target + Array dragged: add array items as leaf keys
                for (const item of v as unknown[]) {
                  const itemKey = String(item);
                  if (
                    !(itemKey in (targetSub as Record<string, unknown>))
                  ) {
                    (targetSub as Record<string, unknown>)[itemKey] = null;
                  }
                }
              } else if (
                typeof targetSub === "object" &&
                targetSub !== null &&
                !Array.isArray(targetSub) &&
                typeof v === "object" &&
                v !== null &&
                !Array.isArray(v)
              ) {
                // Object+Object: add missing keys from dragged
                for (const [dk, dv] of Object.entries(
                  v as Record<string, unknown>,
                )) {
                  if (
                    !(dk in (targetSub as Record<string, unknown>))
                  ) {
                    (targetSub as Record<string, unknown>)[dk] = dv;
                  }
                }
              }
            }
          }
          sectionMergeTargetValue = targetValue;
        } else if (
          Array.isArray(targetValue) &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          // Array target + Object dragged: convert target array to object, then merge dragged keys
          const converted: Record<string, unknown> = {};
          for (const item of targetValue) {
            converted[String(item)] = null;
          }
          for (const [k, v] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (!(k in converted)) {
              converted[k] = v;
            } else if (
              Array.isArray(converted[k]) &&
              Array.isArray(v)
            ) {
              const arr = converted[k] as unknown[];
              for (const item of v as unknown[]) {
                const isDuplicate = arr.some(
                  (ex: unknown) =>
                    typeof ex === typeof item &&
                    String(ex) === String(item),
                );
                if (!isDuplicate) {
                  arr.push(item);
                }
              }
            }
          }
          targetParent[targetKey] = converted;
          sectionMergeTargetValue = converted;

          // Remap old index-based nodeIdMap entries to key-based paths
          // since we converted the target from array to object
          for (let i = 0; i < targetValue.length; i++) {
            const oldPrefix = `${targetItemPath}/${i}`;
            const newPrefix = `${targetItemPath}/${String(targetValue[i])}`;
            nodeIdMap = remapNodeIdPaths(nodeIdMap, oldPrefix, newPrefix);
          }
        } else if (
          typeof targetValue === "object" &&
          targetValue !== null &&
          !Array.isArray(targetValue) &&
          Array.isArray(value)
        ) {
          // Object target + Array dragged: add array items as leaf keys in target object
          for (const item of value as unknown[]) {
            const itemKey = String(item);
            if (!(itemKey in (targetValue as Record<string, unknown>))) {
              (targetValue as Record<string, unknown>)[itemKey] = null;
            }
          }
          sectionMergeTargetValue = targetValue;
        }
      }

      // sourceMap is derived from provenance — use it directly
      const targetSource = sourceMap.get(targetItemPath);
      const inferredTargetSource = targetSource || deriveSource(getLineageForPath(targetItemPath, nodeIdMap, provenance));

      console.log(
        "Dragged source:",
        draggedSource,
        "Target source:",
        targetSource,
        "Inferred target source:",
        inferredTargetSource,
        "Target path:",
        targetItemPath,
      );

      // Determine the merged source - use inferred source for better accuracy
      let mergedSource = "both";
      const effectiveTargetSource = inferredTargetSource || targetSource;
      if (effectiveTargetSource === draggedSource) {
        mergedSource = effectiveTargetSource || draggedSource;
      } else if (
        (effectiveTargetSource === "left" && draggedSource === "right") ||
        (effectiveTargetSource === "right" && draggedSource === "left")
      ) {
        mergedSource = "both";
      } else if (effectiveTargetSource === "both" || draggedSource === "both") {
        mergedSource = "both";
      } else if (!effectiveTargetSource && draggedSource) {
        mergedSource = draggedSource;
      } else if (effectiveTargetSource && !draggedSource) {
        mergedSource = effectiveTargetSource;
      }

      // Record provenance for the leaf merge
      // Ensure nodeIdMap entry exists for target
      if (!nodeIdMap.has(targetItemPath)) {
        nodeIdMap.set(targetItemPath, generateNodeId());
      }

      if (sourcePanel === "left" || sourcePanel === "right") {
        const originalDraggedPath = sourcePath.slice(1).join("/");
        const isMerged = mergedSource === "both";

        // If this is a true merge, mark existing provenance as merged
        if (isMerged) {
          markLineageAsMerged(targetItemPath);
        }

        subscribeItemAndChildren(
          targetItemPath,
          originalDraggedPath,
          sourcePanel as "left" | "right",
          value,
          isMerged,
          true,
          sectionMergeTargetValue,
        );
      } else if (sourcePanel === "merged") {
        // Transfer pre-captured lineage from dragged item to target (parent)
        const draggedLineage = draggedLineageForLeafMerge;
        if (draggedLineage) {
          markLineageAsMerged(targetItemPath);
          for (const source of draggedLineage.sources) {
            addLineage(
              targetItemPath,
              source.panel,
              source.originalPath,
              "merged",
            );
          }
        }
        // Transfer children's captured provenance to new paths under targetItemPath
        if (draggedChildLineageMap && draggedChildLineageMap.size > 0) {
          for (const [suffix, entry] of draggedChildLineageMap) {
            let childTargetPath: string;

            if (arrayMergeIndexMap) {
              // For array-array merges, remap old dragged indices to new merged indices
              const match = suffix.match(/^\/(\d+)(\/.*)?$/);
              if (match) {
                const oldIdx = parseInt(match[1], 10);
                const rest = match[2] || "";
                const newIdx = arrayMergeIndexMap.get(oldIdx);
                if (newIdx === undefined) continue; // item was lost
                childTargetPath = `${targetItemPath}/${newIdx}${rest}`;
              } else {
                childTargetPath = targetItemPath + suffix;
              }
            } else {
              childTargetPath = targetItemPath + suffix;
            }

            // Ensure nodeIdMap entry exists
            if (!nodeIdMap.has(childTargetPath)) {
              nodeIdMap.set(childTargetPath, generateNodeId());
            }
            for (const source of entry.sources) {
              addLineage(
                childTargetPath,
                source.panel,
                source.originalPath,
                source.action,
              );
            }
          }
        }
      }

      // If this is a true merge, mark the target's provenance as merged
      if (
        mergedSource === "both" &&
        effectiveTargetSource &&
        effectiveTargetSource !== "both"
      ) {
        markItemAsMerged(targetItemPath);
      }

      // Deferred cleanup: remove stale entries under the old dragged path
      if (sourcePanel === "merged") {
        const draggedPrefix = draggedSourcePath + "/";
        for (const [path] of [...nodeIdMap.entries()]) {
          if (path.startsWith(draggedPrefix)) {
            const id = nodeIdMap.get(path);
            if (id) provenance.delete(id);
            nodeIdMap.delete(path);
          }
        }
      }

      // Trigger reactivity and return
      if (sourcePanel === "left") leftData = { ...leftData };
      if (sourcePanel === "right") rightData = { ...rightData };
      if (sourcePanel === "merged") mergedData = { ...mergedData };
      invalidateProvenance();

      return;
    }

    // Add to target
    const targetData = dataSources[targetPanel];
    let addedPath = [...targetPath, key]; // Default path for the added item
    let isSectionMerge = false; // Track if we're merging sections

    if (targetData) {
      console.log(
        "handleDrop - value type:",
        typeof value,
        "isArray:",
        Array.isArray(value),
        "isArrayItem:",
        isArrayItem,
        "value:",
        value,
      );
      // For array items, we need to detect duplicates and get the correct path
      if (
        isArrayItem ||
        typeof value === "string" ||
        typeof value === "number"
      ) {
        // Check if dropping into an array or onto a section header
        let targetContainer = targetData;
        for (const segment of targetPath) {
          if (targetContainer[segment] !== undefined) {
            targetContainer = targetContainer[segment];
          }
        }

        // Check if this is dropping onto a section/subsection header
        // This happens when:
        // 1. Target is an object (section) with existing children, OR
        // 2. Target is an array (subsection with children) but section is NOT expanded
        //    (meaning user is dropping onto the header, not into the children)
        // NOTE: Empty sections (no keys) should accept items, not just get color-marked
        const isNonEmptyObject =
          typeof targetContainer === "object" &&
          targetContainer !== null &&
          !Array.isArray(targetContainer) &&
          Object.keys(targetContainer).length > 0;
        const isDroppingOntoHeader =
          targetPanel === "merged" &&
          (sourcePanel === "left" || sourcePanel === "right") &&
          !insertBefore &&
          (isNonEmptyObject ||
            (Array.isArray(targetContainer) && !dropOnExpandedSection));

        if (isDroppingOntoHeader) {
          // Dropping a leaf concept onto a section/subsection header
          // This marks the section header as "merged" (purple) without adding anything
          console.log(
            "Leaf concept dropped onto section header - marking as merged:",
            targetPath.join("/"),
          );

          const targetPathStr = targetPath.join("/");
          const draggedSource = sourcePanel as "left" | "right";

          // Record provenance for the header-merged action
          const originalPath = sourcePath.slice(1).join("/");
          const targetSource = sourceMap.get(targetPathStr);
          const isMerged =
            (targetSource === "left" && (draggedSource as string) === "right") ||
            (targetSource === "right" && (draggedSource as string) === "left") ||
            targetSource === "both";

          // Track provenance with header-merged action
          addLineage(targetPathStr, sourcePanel, originalPath, "header-merged");

          if (isMerged) {
            markItemAsMerged(targetPathStr);
          }

          // Trigger reactivity and return - nothing is actually added
          if (sourcePanel === "left") leftData = { ...leftData };
          if (sourcePanel === "right") rightData = { ...rightData };
          if (targetPanel === "merged") mergedData = { ...mergedData };
          invalidateProvenance();
          return;
        } else if (Array.isArray(targetContainer)) {
          // Dropping into an array (section is expanded, so adding to children)
          // Check for existing duplicate
          const existingIndex = targetContainer.findIndex(
            (item) =>
              typeof item === typeof value && String(item) === String(value),
          );

          if (existingIndex !== -1) {
            // Duplicate found - use existing index for path
            addedPath = [...targetPath, String(existingIndex)];
          } else if (insertBefore !== undefined) {
            // Inserting at a specific position via splice
            addedPath = [...targetPath, insertBefore];
          } else {
            // Will be added to the end
            addedPath = [...targetPath, String(targetContainer.length)];
          }
        }
      } else if (typeof value === "object" && value !== null && !insertBefore) {
        // When dropping a section onto another section (NOT inserting before/after):
        // - Target section ABSORBS the dragged section
        // - If value is an object: merge its children into target
        // - If value is an array: add as a child with its key preserved
        // - Target keeps its name but becomes purple (merged)
        // This applies regardless of whether the target is expanded or collapsed
        // NOTE: If insertBefore is set, this is a sibling insertion, not a merge!
        console.log(
          "Section drop detected, targetPath:",
          targetPath,
          "length:",
          targetPath.length,
          "value isArray:",
          Array.isArray(value),
        );
        if (targetPath.length > 0) {
          // Check if the target is also a section (object, not array)
          let targetObj = targetData;
          console.log(
            "Starting navigation, targetData:",
            Object.keys(targetData || {}),
          );
          for (const segment of targetPath) {
            console.log(
              "Navigating segment:",
              segment,
              "targetObj:",
              targetObj ? Object.keys(targetObj) : null,
            );
            if (targetObj[segment] !== undefined) {
              targetObj = targetObj[segment];
            }
          }
          console.log(
            "Final targetObj type:",
            typeof targetObj,
            "isArray:",
            Array.isArray(targetObj),
            "value:",
            targetObj,
          );

          // If target is an object (section), determine behavior based on whether it's empty
          if (
            typeof targetObj === "object" &&
            targetObj !== null &&
            !Array.isArray(targetObj)
          ) {
            const isEmptySection = Object.keys(targetObj).length === 0;

            if (isEmptySection) {
              // Target is an empty section - add the dragged section as a child
              // e.g., dragging "Cancer": {...} into empty "MySection" creates "MySection": { "Cancer": {...} }
              console.log(
                "Adding section as child of empty section",
                "target:",
                targetPath,
                "adding:",
                key,
              );
              addToData(targetData, targetPath, key, value, undefined, false);
              addedPath = [...targetPath, key];
              // Don't mark as section merge - this is a simple add, not a merge
            } else {
              // Target is a non-empty section - ABSORB the dragged section (merge behavior)
              console.log(
                "Absorbing section - target keeps name, gets dragged content",
                "target:",
                targetPath,
                "absorbing:",
                key,
              );

              // Mark this as a section merge (target becomes purple)
              isSectionMerge = true;

              // Handle differently based on whether dragged value is object or array
              if (Array.isArray(value)) {
                // Dragged item has an array value - add it as a child with its key preserved
                // e.g., "Breast cancer": ["item1", "item2"] becomes a child of target
                addToData(targetData, targetPath, key, value, undefined, false);
                addedPath = [...targetPath, key];
              } else {
                // Dragged item has object children - merge them into target
                // The dragged section's key is discarded, only its children are kept
                const draggedChildren = value as Record<string, unknown>;

                // Add each child of the dragged section to the target section
                for (const [childKey, childValue] of Object.entries(
                  draggedChildren,
                )) {
                  addToData(
                    targetData,
                    targetPath,
                    childKey,
                    childValue,
                    undefined,
                    false,
                  );
                }
                addedPath = [...targetPath];
              }
            }

            // Skip the normal addToData call below since we handled it
            // We need to track sources for the absorbed/added children
            if (
              targetPanel === "merged" &&
              (sourcePanel === "left" ||
                sourcePanel === "right" ||
                sourcePanel === "merged")
            ) {
              const targetPathStr = targetPath.join("/");

              // Get the source of the dragged item
              let draggedSource = sourcePanel;
              let draggedOriginalPathLeft: string | null = null;
              let draggedOriginalPathRight: string | null = null;
              if (sourcePanel === "merged") {
                const originalSourcePath = sourcePath.slice(1).join("/");
                const originalSource = sourceMap.get(originalSourcePath);
                console.log(
                  "Looking up original source for dragged:",
                  originalSourcePath,
                  "found:",
                  originalSource,
                );
                if (originalSource) {
                  draggedSource = originalSource;
                }
                draggedOriginalPathLeft = getOriginalPathForMergedDrag(
                  originalSourcePath,
                  "left",
                );
                draggedOriginalPathRight = getOriginalPathForMergedDrag(
                  originalSourcePath,
                  "right",
                );
              }

              const draggedOriginalPath =
                draggedSource === "left"
                  ? draggedOriginalPathLeft || sourcePath.slice(1).join("/")
                  : draggedSource === "right"
                    ? draggedOriginalPathRight || sourcePath.slice(1).join("/")
                    : sourcePath.slice(1).join("/");

              // If source path couldn't be resolved to a real source panel path, skip incorrect subscriptions
              const draggedPathToId =
                draggedSource === "left"
                  ? leftPathToId
                  : draggedSource === "right"
                    ? rightPathToId
                    : null;
              const canSubscribeDragged =
                draggedSource === "left" || draggedSource === "right"
                  ? !!draggedPathToId?.has(draggedOriginalPath)
                  : false;

              if (
                (draggedSource === "left" || draggedSource === "right") &&
                !canSubscribeDragged
              ) {
                console.log(
                  "Skipping invalid subscription path for dragged merged source:",
                  draggedSource,
                  draggedOriginalPath,
                );
              }

              if (isEmptySection) {
                // For empty section add, just record source for the added section
                // The added path is targetPath/key
                const addedPathStr = [...targetPath, key].join("/");
                console.log(
                  "Recording source for section added to empty target:",
                  addedPathStr,
                  "as:",
                  draggedSource,
                );
                if (
                  draggedSource === "left" ||
                  draggedSource === "right" ||
                  draggedSource === "both"
                ) {
                  // Subscribe the added section to its source
                  if (draggedSource === "left" || draggedSource === "right") {
                    const draggedOriginalPath = sourcePath.slice(1).join("/");
                    subscribeItemAndChildren(
                      addedPathStr,
                      draggedOriginalPath,
                      draggedSource,
                      value,
                      false, // Not a merge, just an add
                    );
                  }
                }
              } else {
                // For section merge (non-empty target)
                console.log("Setting target to 'both':", targetPathStr);

                // Get the source of the target item
                const targetSource = sourceMap.get(targetPathStr);
                console.log(
                  "Target source:",
                  targetSource,
                  "Dragged source:",
                  draggedSource,
                );

                // Determine if this is a true merge (different sources)
                // Provenance for the section merge will be recorded by subscribeItemAndChildren below.
                // sourceMap is derived automatically from provenance.

                // PUB/SUB: Subscribe the merged item to the dragged source
                if (
                  canSubscribeDragged &&
                  (draggedSource === "left" || draggedSource === "right")
                ) {
                  const isMerged =
                    targetSource === "left" ||
                    targetSource === "right" ||
                    targetSource === "both";

                  // Use addedPath for subscription - this is the actual path where content was added
                  // For array value: addedPath = [...targetPath, key] (the array is added as a child)
                  // For object value: addedPath = [...targetPath] (children merged into target)
                  const subscriptionPath = addedPath.join("/");

                  // If dragging from merged panel, cleanup old provenance mappings
                  if (sourcePanel === "merged") {
                    const sourceMergedPath = sourcePath.slice(1).join("/");
                    unsubscribeItemAndChildren(sourceMergedPath);
                  }

                  // Pass merged tree so array indices map correctly after dedup/concat
                  const mergedAtSubscriptionPath = Array.isArray(value)
                    ? targetObj[key]
                    : targetObj;
                  console.log(
                    "Section merge - subscribing dragged:",
                    draggedOriginalPath,
                    "to merged path:",
                    subscriptionPath,
                    "source:",
                    draggedSource,
                    "isMerged:",
                    isMerged,
                  );
                  subscribeItemAndChildren(
                    subscriptionPath,
                    draggedOriginalPath,
                    draggedSource,
                    value,
                    isMerged,
                    true, // trackLineage
                    mergedAtSubscriptionPath,
                  );
                }

                // PUB/SUB: If the target already had a source, mark it as merged
                if (targetSource === "left" || targetSource === "right") {
                  console.log(
                    "Section merge - marking target as merged:",
                    targetPathStr,
                  );
                  markItemAsMerged(targetPathStr);
                }
              }
            }

            // Trigger reactivity and return early
            if (sourcePanel === "left") leftData = { ...leftData };
            if (sourcePanel === "right") rightData = { ...rightData };
            if (sourcePanel === "merged") mergedData = { ...mergedData };
            if (targetPanel === "left") leftData = { ...leftData };
            if (targetPanel === "right") rightData = { ...rightData };
            if (targetPanel === "merged") mergedData = { ...mergedData };
            invalidateProvenance();
            return;
          } else if (Array.isArray(targetObj) && Array.isArray(value)) {
            // Target is an array, and we're dropping an array onto it
            // Merge the arrays: add items from dragged array to target array
            console.log(
              "Merging arrays - target array gets dragged array items",
              "target:",
              targetPath,
              "absorbing items from:",
              key,
            );

            // Mark this as a section merge (target becomes purple)
            isSectionMerge = true;

            // Track starting index and which items are added
            const startingIndex = targetObj.length;
            const addedItems: {
              item: unknown;
              sourceIndex: number;
              targetIndex: number;
            }[] = [];

            // Add each item from the dragged array to the target array (if not duplicate)
            const draggedArray = value as unknown[];
            let nextTargetIndex = startingIndex;
            draggedArray.forEach((item, sourceIndex) => {
              // Check for duplicates
              const isDuplicate = targetObj.some(
                (existing) =>
                  typeof existing === typeof item &&
                  String(existing) === String(item),
              );
              if (!isDuplicate) {
                targetObj.push(item);
                addedItems.push({
                  item,
                  sourceIndex,
                  targetIndex: nextTargetIndex,
                });
                nextTargetIndex++;
              }
            });

            addedPath = [...targetPath];

            // Track sources for the merged array
            if (
              targetPanel === "merged" &&
              (sourcePanel === "left" ||
                sourcePanel === "right" ||
                sourcePanel === "merged")
            ) {
              const targetPathStr = targetPath.join("/");

              // Get the source of the dragged item
              let draggedSource = sourcePanel;
              if (sourcePanel === "merged") {
                const originalSourcePath = sourcePath.slice(1).join("/");
                const originalSource = sourceMap.get(originalSourcePath);
                if (originalSource) {
                  draggedSource = originalSource;
                }
              }

              const draggedOriginalPath =
                sourcePanel === "merged" &&
                (draggedSource === "left" || draggedSource === "right")
                  ? getOriginalPathForMergedDrag(
                      sourcePath.slice(1).join("/"),
                      draggedSource,
                    )
                  : sourcePath.slice(1).join("/");

              const draggedPathToId =
                draggedSource === "left"
                  ? leftPathToId
                  : draggedSource === "right"
                    ? rightPathToId
                    : null;
              const canSubscribeDragged =
                draggedSource === "left" || draggedSource === "right"
                  ? !!draggedPathToId?.has(draggedOriginalPath)
                  : false;

              if (
                sourcePanel === "merged" &&
                (draggedSource === "left" || draggedSource === "right") &&
                !canSubscribeDragged
              ) {
                console.log(
                  "Array merge: skipping invalid dragged original path:",
                  draggedSource,
                  draggedOriginalPath,
                );
              }

              // Cleanup stale provenance for dragged merged subtree before re-subscribing
              if (sourcePanel === "merged") {
                const sourceMergedPath = sourcePath.slice(1).join("/");
                unsubscribeItemAndChildren(sourceMergedPath);
              }

              // Get the source of the target array
              const targetSource = sourceMap.get(targetPathStr);
              console.log(
                "Array merge - Target source:",
                targetSource,
                "Dragged source:",
                draggedSource,
              );

              // Provenance for array items is recorded by subscribeItemAndChildren below.
              // sourceMap is derived automatically from provenance.

      

              // PUB/SUB: Subscribe each added item to its source
              // We need to use the CORRECT indices: targetIndex in merged, sourceIndex in source panel
              // NOTE: Individual items are NOT merged just because they're in an array with items from another source
              // They should only be "merged" (bold) if they are individually combined with another item
              if (
                canSubscribeDragged &&
                (draggedSource === "left" || draggedSource === "right")
              ) {
                // First, subscribe the parent array itself to the dragged source
                // This marks the parent section as "added" (or "merged" if target had a different source)
                const parentIsMerged =
                  (targetSource === "left" && draggedSource === "right") ||
                  (targetSource === "right" && draggedSource === "left") ||
                  targetSource === "both";
                console.log(
                  "Array merge - subscribing parent array:",
                  targetPathStr,
                  "->",
                  draggedOriginalPath,
                  "isMerged:",
                  parentIsMerged,
                );
                subscribeItemAndChildren(
                  targetPathStr,
                  draggedOriginalPath,
                  draggedSource,
                  null, // Don't recurse - we'll handle children separately with correct indices
                  parentIsMerged,
                );

                console.log(
                  "Array merge - subscribing items. Added items:",
                  addedItems.length,
                  "(items are NOT marked as merged, just added)",
                );

                // Subscribe each added item with correct indices - NOT merged, just added
                for (const { item, sourceIndex, targetIndex } of addedItems) {
                  const mergedItemPath = `${targetPathStr}/${targetIndex}`;
                  const sourceItemPath = `${draggedOriginalPath}/${sourceIndex}`;
                  console.log(
                    "Array merge - subscribing item:",
                    mergedItemPath,
                    "->",
                    sourceItemPath,
                  );
                  subscribeItemAndChildren(
                    mergedItemPath,
                    sourceItemPath,
                    draggedSource,
                    item,
                    false, // Items are NOT merged, just added to the array
                  );
                }
              }

              // PUB/SUB: If the target already had a source, mark it as merged
              if (targetSource === "left" || targetSource === "right") {
                console.log(
                  "Array merge - marking target as merged:",
                  targetPathStr,
                );
                markItemAsMerged(targetPathStr);
              }
            }

            // Trigger reactivity and return early
            if (sourcePanel === "left") leftData = { ...leftData };
            if (sourcePanel === "right") rightData = { ...rightData };
            if (sourcePanel === "merged") mergedData = { ...mergedData };
            if (targetPanel === "left") leftData = { ...leftData };
            if (targetPanel === "right") rightData = { ...rightData };
            if (targetPanel === "merged") mergedData = { ...mergedData };
            invalidateProvenance();
            return;
          } else if (
            Array.isArray(targetObj) &&
            !Array.isArray(value) &&
            typeof value === "object"
          ) {
            // Target is an array, but we're dropping an object/section onto it
            // Add the section as a child item in the parent section (not into the array)
            console.log(
              "Dropping object onto array - adding section to parent",
              "target:",
              targetPath,
              "adding:",
              key,
            );

            // We need to add to the PARENT of the target array, not the array itself
            // The targetPath points to the array, we want to add the section as a sibling
            const parentPath = targetPath.slice(0, -1);

            // Add the dropped section as a new key in the parent object
            addToData(targetData, parentPath, key, value, undefined, false);
            addedPath = [...parentPath, key];

            // Track source for the added section
            if (
              targetPanel === "merged" &&
              (sourcePanel === "left" ||
                sourcePanel === "right" ||
                sourcePanel === "merged")
            ) {
              let draggedSource = sourcePanel;
              if (sourcePanel === "merged") {
                const originalSourcePath = sourcePath.slice(1).join("/");
                const originalSource = sourceMap.get(originalSourcePath);
                if (originalSource) {
                  draggedSource = originalSource;
                }
              }

              // PUB/SUB: Subscribe the added section and its children
              if (draggedSource === "left" || draggedSource === "right") {
                const originalPath = sourcePath.slice(1).join("/");
                subscribeItemAndChildren(
                  addedPath.join("/"),
                  originalPath,
                  draggedSource,
                  value,
                  false, // Not a merge, just an add
                );
              }
            }

            // Trigger reactivity and return early
            if (sourcePanel === "left") leftData = { ...leftData };
            if (sourcePanel === "right") rightData = { ...rightData };
            if (sourcePanel === "merged") mergedData = { ...mergedData };
            if (targetPanel === "left") leftData = { ...leftData };
            if (targetPanel === "right") rightData = { ...rightData };
            if (targetPanel === "merged") mergedData = { ...mergedData };
            invalidateProvenance();
            return;
          }
        } else {
          // Already at root level, check if key already exists (section merge)
          if (key in targetData) {
            isSectionMerge = true;
            console.log("Section merge detected at root level:", key);
          }
        }
      }

      console.log("Calling addToData with:", {
        targetPath,
        key,
        isSectionMerge,
      });
      addToData(targetData, targetPath, key, value, insertBefore, isArrayItem);

      // Reindex after array insertion: when insertBefore is used, splice shifts existing items up
      if (
        targetPanel === "merged" &&
        isArrayItem &&
        insertBefore !== undefined
      ) {
        const insertedIndex = parseInt(insertBefore, 10);
        if (!isNaN(insertedIndex)) {
          const parentPath = targetPath.join("/");
          reindexMergedArrayAfterInsert(parentPath, insertedIndex);
        }
      }
    }

    // Track source when dropping into merged panel
    if (
      targetPanel === "merged" &&
      (sourcePanel === "left" ||
        sourcePanel === "right" ||
        sourcePanel === "merged")
    ) {
      const itemPath = addedPath.join("/");
      // PUB/SUB: Subscribe the merged item to its source
      if (sourcePanel === "left" || sourcePanel === "right") {
        const originalPath = sourcePath.slice(1).join("/");
        // Check if this is a merge: does the item already have provenance from the other panel?
        const existingEntry = getLineageForPath(itemPath, nodeIdMap, provenance);
        const isMerged = existingEntry
          ? existingEntry.sources.some(
              (s) => (s.panel === "left" || s.panel === "right") && s.panel !== sourcePanel,
            )
          : false;
        console.log(
          "Regular drop - subscribing:",
          originalPath,
          "source:",
          sourcePanel,
          "isMerged:",
          isMerged,
        );
        subscribeItemAndChildren(
          itemPath,
          originalPath,
          sourcePanel,
          value,
          isMerged,
        );

        // If this resulted in a merge, also mark any existing subscriptions as merged
        if (isMerged) {
          markItemAsMerged(itemPath);
        }

        // Update parent coloring to reflect the new child's source
        updateParentProvenance(addedPath.slice(0, -1).join("/"));
      }
    }

    // If moving within merged panel, apply captured provenance at the new path
    if (sourcePanel === "merged" && targetPanel === "merged") {
      const newPath = addedPath.join("/");

      // Apply captured provenance at the new location
      if (capturedProvenanceForMove) {
        if (!nodeIdMap.has(newPath)) {
          nodeIdMap.set(newPath, generateNodeId());
        }
        for (const source of capturedProvenanceForMove.sources) {
          addLineage(newPath, source.panel, source.originalPath, source.action);
        }
      }
      if (capturedChildProvenanceForMove) {
        for (const [suffix, entry] of capturedChildProvenanceForMove) {
          const childNewPath = newPath + suffix;
          if (!nodeIdMap.has(childNewPath)) {
            nodeIdMap.set(childNewPath, generateNodeId());
          }
          for (const source of entry.sources) {
            addLineage(childNewPath, source.panel, source.originalPath, source.action);
          }
        }
      }

      // Recalculate parent provenance: after moving a leaf between parents,
      // the source parent may no longer have contributions from both panels
      updateParentProvenance(sourcePath.slice(1, -1).join("/"));
      updateParentProvenance(addedPath.slice(0, -1).join("/"));
    }

    // Trigger reactivity
    if (sourcePanel === "left") leftData = { ...leftData };
    if (sourcePanel === "right") rightData = { ...rightData };
    if (sourcePanel === "merged") mergedData = { ...mergedData };
    if (targetPanel === "left") leftData = { ...leftData };
    if (targetPanel === "right") rightData = { ...rightData };
    if (targetPanel === "merged") mergedData = { ...mergedData };
    invalidateProvenance();
  }

  /**
   * Remove an item from a data tree at the specified path.
   * Handles both object properties and array elements.
   *
   * @param obj - The root data object
   * @param path - Path segments to the item to remove
   */
  function removeFromData(obj: any, path: string[]) {
    if (path.length === 0) return;

    if (path.length === 1) {
      const key = path[0];
      if (Array.isArray(obj)) {
        const index = parseInt(key, 10);
        if (!isNaN(index) && index >= 0 && index < obj.length) {
          obj.splice(index, 1);
        }
      } else if (obj && typeof obj === "object") {
        delete obj[key];
      }
      return;
    }

    const next = obj[path[0]];
    if (next) {
      removeFromData(next, path.slice(1));
    }
  }

  /**
   * Add an item to a data tree at the specified path.
   * Handles objects, arrays, insertions, and key ordering.
   *
   * @param obj - The root data object
   * @param path - Path segments to the target location
   * @param key - Key/name for the new item
   * @param value - Value to add
   * @param insertBefore - If set, insert before this sibling key
   * @param isArrayItem - Whether the item is an array element
   */
  function addToData(
    obj: any,
    path: string[],
    key: string,
    value: unknown,
    insertBefore?: string,
    isArrayItem?: boolean,
  ) {
    // Navigate to the target location
    let target = obj;
    let parent = obj;
    let lastSegment = "";

    for (const segment of path) {
      if (target[segment] === undefined || target[segment] === null) {
        target[segment] = {};
      }
      parent = target;
      lastSegment = segment;
      target = target[segment];
    }

    // Handle array targets
    if (Array.isArray(target)) {
      // If we're dropping an array item (simple value), add it to the array
      if (
        isArrayItem ||
        typeof value === "string" ||
        typeof value === "number"
      ) {
        // Check if this value already exists in the array (duplicate detection)
        const existingIndex = target.findIndex(
          (item) =>
            typeof item === typeof value && String(item) === String(value),
        );

        if (existingIndex !== -1) {
          // Value already exists - don't add duplicate
          // The source merging will be handled by recordSource using the existing index
          return;
        }

        if (insertBefore !== undefined) {
          const index = parseInt(insertBefore, 10);
          if (!isNaN(index) && index >= 0) {
            target.splice(index, 0, value);
            return;
          }
        }
        // No insertBefore or invalid index: push to end
        target.push(value);
        return;
      }

      // If we're dropping a named section (object with key) into an array,
      // we should add it to the parent object instead as a sibling
      // This handles the case where someone drops a section "inside"
      // a category that has an array value
      if (path.length > 0) {
        // Add to the parent object (same level as the array's parent key)
        parent[key] = value;
        return;
      }
    }

    // Handle dropping a leaf item into an empty object section
    // Convert the empty object to an array and add the item
    if (
      typeof target === "object" &&
      target !== null &&
      !Array.isArray(target) &&
      Object.keys(target).length === 0 &&
      (isArrayItem || typeof value === "string" || typeof value === "number")
    ) {
      // Convert empty object to array and add the value
      const newArray = [value];
      if (path.length === 0) {
        // Can't convert root, this shouldn't happen
        return;
      }
      // Replace the empty object with the new array
      parent[lastSegment] = newArray;
      return;
    }

    // For array items being dropped into an object:
    // Use the string value as the key if the value is a string
    // Otherwise use a generated key based on the value
    let effectiveKey = key;
    if (isArrayItem && typeof value === "string") {
      // String array items use their value as the key
      effectiveKey = value;
    } else if (isArrayItem && !isNaN(parseInt(key, 10))) {
      // Key is just an array index, try to generate a meaningful key
      if (typeof value === "object" && value !== null) {
        // For objects being dropped from an array, try to find a name-like property
        // or use a stringified representation
        const objValue = value as Record<string, unknown>;
        if (objValue.name && typeof objValue.name === "string") {
          effectiveKey = objValue.name;
        } else if (objValue.title && typeof objValue.title === "string") {
          effectiveKey = objValue.title;
        } else {
          // Fallback: use the first key of the object or generate one
          const firstKey = Object.keys(objValue)[0];
          if (firstKey) {
            effectiveKey = `item_${key}`;
          } else {
            effectiveKey = `item_${key}`;
          }
        }
      } else {
        effectiveKey = String(value);
      }
    }
    // Note: when isArrayItem is false (dragging a named section/object),
    // the key is already the correct property name, so we keep it as-is

    // Check if we're dropping a section onto an existing section with the same key
    // If so, merge the children instead of replacing
    if (
      effectiveKey in target &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof target[effectiveKey] === "object" &&
      target[effectiveKey] !== null &&
      !Array.isArray(target[effectiveKey])
    ) {
      // Merge the objects - add new keys to existing object
      const existingObj = target[effectiveKey] as Record<string, unknown>;
      const newObj = value as Record<string, unknown>;

      for (const [k, v] of Object.entries(newObj)) {
        if (!(k in existingObj)) {
          existingObj[k] = v;
        } else if (Array.isArray(existingObj[k]) && Array.isArray(v)) {
          // Merge arrays - add items that don't already exist
          const existingArr = existingObj[k] as unknown[];
          const newArr = v as unknown[];
          for (const item of newArr) {
            const isDuplicate = existingArr.some(
              (existing) =>
                typeof existing === typeof item &&
                String(existing) === String(item),
            );
            if (!isDuplicate) {
              existingArr.push(item);
            }
          }
        }
        // For other cases (conflicting types), keep the existing value
      }
      return;
    }

    // If insertBefore is specified, we need to reorder the object keys
    if (
      insertBefore !== undefined &&
      typeof target === "object" &&
      !Array.isArray(target)
    ) {
      const entries = Object.entries(target);
      const newObj: Record<string, unknown> = {};

      for (const [k, v] of entries) {
        if (k === insertBefore) {
          newObj[effectiveKey] = value;
        }
        if (k !== effectiveKey) {
          // Don't include the key if it already exists (we're moving it)
          newObj[k] = v;
        }
      }

      // If insertBefore wasn't found, add at the end
      if (!(effectiveKey in newObj)) {
        newObj[effectiveKey] = value;
      }

      // Replace the target object with the reordered one
      if (path.length === 0) {
        // Can't directly replace the root, need to clear and repopulate
        Object.keys(obj).forEach((k) => delete obj[k]);
        Object.assign(obj, newObj);
      } else {
        const parent = path
          .slice(0, -1)
          .reduce((acc, segment) => acc[segment], obj);
        parent[path[path.length - 1]] = newObj;
      }
    } else {
      // Simple case: just add the key
      target[effectiveKey] = value;
    }
  }

  /**
   * Handle renaming an item in any panel.
   * Updates the data tree, sourceMap, nodeIdMap, and lineage as needed.
   *
   * @param path - Full path including panel ID
   * @param oldName - Original name/value
   * @param newName - New name/value
   * @param isArrayItem - Whether the item is an array element
   */
  function handleRename(
    path: string[],
    _oldName: string,
    newName: string,
    isArrayItem: boolean,
  ) {
    // Save state for undo before any modifications
    saveToHistory();

    // Determine which panel this path belongs to
    const panelId = path[0];
    const itemPath = path.slice(1);

    const dataSources: Record<string, any> = {
      left: leftData,
      right: rightData,
      merged: mergedData,
    };

    const dataObj = dataSources[panelId];
    if (!dataObj) return;

    // Navigate to the parent of the item being renamed
    let parent = dataObj;
    for (let i = 0; i < itemPath.length - 1; i++) {
      parent = parent[itemPath[i]];
      if (!parent) return;
    }

    const lastKey = itemPath[itemPath.length - 1];

    if (isArrayItem) {
      // For array items, update the value in the array
      if (Array.isArray(parent)) {
        const index = parseInt(lastKey, 10);
        if (!isNaN(index) && index >= 0 && index < parent.length) {
          parent[index] = newName;
        }
      }
    } else {
      // For object keys, rename the key while preserving order
      if (typeof parent === "object" && !Array.isArray(parent)) {
        const entries = Object.entries(parent);
        const newObj: Record<string, unknown> = {};
        for (const [k, v] of entries) {
          if (k === lastKey) {
            newObj[newName] = v;
          } else {
            newObj[k] = v;
          }
        }
        // Replace parent contents - clear first, then assign in order
        for (const k of Object.keys(parent)) {
          delete parent[k];
        }
        for (const [k, v] of Object.entries(newObj)) {
          parent[k] = v;
        }

        // Update sourceMap and nodeIdMap for the renamed item and its children
        if (panelId === "merged") {
          const oldPathPrefix = itemPath.join("/");
          const newPathPrefix = [...itemPath.slice(0, -1), newName].join("/");

          if (oldPathPrefix !== newPathPrefix) {
            // Update nodeIdMap (sourceMap is derived automatically)
            nodeIdMap = remapNodeIdPaths(nodeIdMap, oldPathPrefix, newPathPrefix);
          }
        }
      }
    }

    // Trigger reactivity
    if (panelId === "left") leftData = { ...leftData };
    if (panelId === "right") rightData = { ...rightData };
    if (panelId === "merged") mergedData = { ...mergedData };
    if (panelId === "merged") invalidateProvenance();
  }

  /**
   * Create a new empty section in the merged panel.
   * Records lineage with "user" panel and "created" action.
   *
   * @param name - Name for the new section
   */
  function handleCreateSection(name: string) {
    // Save state for undo before any modifications
    saveToHistory();

    // Add a new empty section to the merged data
    mergedData[name] = {};

    // Track provenance for user-created section
    const sectionNodeId = generateNodeId();
    nodeIdMap.set(name, sectionNodeId);
    setProvenance(provenance, sectionNodeId, [
      { panel: "user", originalPath: name, action: "created" },
    ]);

    mergedData = { ...mergedData };
    invalidateProvenance();
  }

  /**
   * Delete an item from any panel.
   * Handles unsubscribing, reindexing arrays, and cleaning up maps.
   *
   * @param path - Full path including panel ID
   * @param isArrayItem - Whether the item is an array element
   */
  function handleDeleteItem(path: string[], isArrayItem: boolean) {
    // Save state for undo before any modifications
    saveToHistory();

    // path includes panelId as first element
    const panelId = path[0];
    const itemPath = path.slice(1);

    const dataSources: Record<string, any> = {
      left: leftData,
      right: rightData,
      merged: mergedData,
    };

    const dataObj = dataSources[panelId];
    if (!dataObj) return;

    // Use removeFromData to delete the item
    removeFromData(dataObj, itemPath);

    // Clean up provenance and reindex if it's the merged panel
    if (panelId === "merged") {
      const pathKey = itemPath.join("/");

      // Remove provenance for this item and its children
      console.log("Deleting item - unsubscribing:", pathKey);
      unsubscribeItemAndChildren(pathKey);

      // If this was an array item, reindex all subsequent items
      if (isArrayItem && itemPath.length > 0) {
        const deletedIndex = parseInt(itemPath[itemPath.length - 1], 10);
        const parentPath = itemPath.slice(0, -1).join("/");
        reindexMergedArrayAfterDelete(parentPath, deletedIndex, pathKey);
      }
    }

    // Trigger reactivity
    if (panelId === "left") leftData = { ...leftData };
    if (panelId === "right") rightData = { ...rightData };
    if (panelId === "merged") mergedData = { ...mergedData };
    if (panelId === "merged") invalidateProvenance();
  }

  const panels = [
    {
      id: "left",
      title: "PATHOUT",
      getData: () => leftData,
      type: "tree",
      icon: File,
      getUsageMap: () => leftUsageMap,
      getHighlightedPath: () => highlightedLeftPath,
      accentColor: "border-red-500",
      textColor: "text-red-600 dark:text-red-400",
    },
    {
      id: "merged",
      title: "MERGE",
      getData: () => mergedData,
      type: "tree",
      icon: GitMerge,
      getUsageMap: () => null,
      getHighlightedPath: () => highlightedMergedPath,
      accentColor: "border-purple-500",
      textColor: "text-purple-600 dark:text-purple-400",
    },
    {
      id: "right",
      title: "WHO",
      getData: () => rightData,
      type: "tree",
      icon: File,
      getUsageMap: () => rightUsageMap,
      getHighlightedPath: () => highlightedRightPath,
      accentColor: "border-blue-500",
      textColor: "text-blue-600 dark:text-blue-400",
    },
  ];

  // Track hovered panel for keyboard shortcuts
  let hoveredPanel: string | null = $state(null);

  // References to TreeView components for expand/collapse
  let treeViewRefs: Record<string, any> = $state({});

  // ============================================
  // LINEAGE HOVER UI
  // ============================================

  // Track which paths should be highlighted in left/right panels
  let highlightedLeftPath: string | null = $state(null);
  let highlightedRightPath: string | null = $state(null);
  // Track which path should be highlighted in merged panel (reverse lookup)
  let highlightedMergedPath: string | null = $state(null);

  /**
   * Handle shift+hover on a merged panel item to highlight its sources.
   * Looks up lineage and highlights/scrolls to corresponding items in source panels.
   *
   * @param path - Path segments of the hovered merged item
   * @param isHovering - Whether mouse is entering (true) or leaving (false)
   */
  function handleLineageHover(path: string[], isHovering: boolean) {
    const pathStr = path.join("/");
    console.log("handleLineageHover:", pathStr, "isHovering:", isHovering);

    if (!isHovering) {
      highlightedLeftPath = null;
      highlightedRightPath = null;
      return;
    }

    // Read from provenance via nodeIdMap
    const entry = getLineageForPath(pathStr, nodeIdMap, provenance);
    console.log(
      "handleLineageHover: entry found:",
      !!entry,
      "sources:",
      entry?.sources?.length || 0,
    );
    if (entry) {
      console.log(
        "handleLineageHover: sources:",
        JSON.stringify(entry.sources),
      );
    }

    if (!entry) {
      highlightedLeftPath = null;
      highlightedRightPath = null;
      return;
    }

    // Find sources and scroll to them
    for (const source of entry.sources) {
      console.log(
        "handleLineageHover: processing source:",
        source.panel,
        source.originalPath,
      );
      if (source.panel === "left") {
        // Find the actual path in leftPathToId (may have different format)
        const actualPath = findMatchingPath(source.originalPath, leftPathToId);
        highlightedLeftPath = actualPath || source.originalPath;
        // Scroll to the item in left panel
        const leftTreeView = treeViewRefs["left"];
        if (leftTreeView && actualPath) {
          leftTreeView.scrollToPath(actualPath);
        }
      } else if (source.panel === "right") {
        // Find the actual path in rightPathToId (may have "(5th ed.)" suffix)
        const actualPath = findMatchingPath(source.originalPath, rightPathToId);
        highlightedRightPath = actualPath || source.originalPath;
        // Scroll to the item in right panel
        const rightTreeView = treeViewRefs["right"];
        if (rightTreeView && actualPath) {
          rightTreeView.scrollToPath(actualPath);
        }
      }
    }
    console.log(
      "handleLineageHover: final - leftPath:",
      highlightedLeftPath,
      "rightPath:",
      highlightedRightPath,
    );
  }

  /**
   * Handle shift+hover on a source panel item to highlight its destination.
   * Uses provenance to find merged items that reference this source.
   *
   * @param panel - Which source panel ("left" or "right")
   * @param path - Path segments of the hovered source item
   * @param isHovering - Whether mouse is entering (true) or leaving (false)
   */
  function handleSourceHover(
    panel: "left" | "right",
    path: string[],
    isHovering: boolean,
  ) {
    const pathStr = path.join("/");
    console.log(
      "handleSourceHover:",
      panel,
      pathStr,
      "isHovering:",
      isHovering,
    );

    if (!isHovering) {
      highlightedMergedPath = null;
      return;
    }

    // Look up the source ID for this path
    const pathToId = panel === "left" ? leftPathToId : rightPathToId;
    const sourceId = pathToId.get(pathStr);

    if (!sourceId) {
      console.log("handleSourceHover: no sourceId found for path", pathStr);
      highlightedMergedPath = null;
      return;
    }

    // Reverse-lookup: find merged paths whose provenance references this source path
    for (const [mergedPath, nodeId] of nodeIdMap.entries()) {
      const entry = provenance.get(nodeId);
      if (!entry) continue;
      const match = entry.sources.some(
        (s) => s.panel === panel && s.originalPath === pathStr,
      );
      if (match) {
        highlightedMergedPath = mergedPath;
        console.log(
          "handleSourceHover: highlighting merged path:",
          mergedPath,
        );

        // Scroll to the item in merged panel
        const mergedTreeView = treeViewRefs["merged"];
        if (mergedTreeView) {
          mergedTreeView.scrollToPath(mergedPath);
        }
        return;
      }
    }

    highlightedMergedPath = null;
  }

  // Wrapper handlers for left/right panels
  function handleLeftSourceHover(path: string[], isHovering: boolean) {
    handleSourceHover("left", path, isHovering);
  }

  function handleRightSourceHover(path: string[], isHovering: boolean) {
    handleSourceHover("right", path, isHovering);
  }

  // Handle keyboard shortcuts for expand/collapse all and undo/redo
  function handleKeydown(e: KeyboardEvent) {
    // Don't trigger if user is in an input field
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) {
      return;
    }

    // Undo: Cmd+Z (Mac) or Ctrl+Z (Windows/Linux)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      undo();
      return;
    }

    // Redo: Cmd+Shift+Z (Mac) or Ctrl+Shift+Z / Ctrl+Y (Windows/Linux)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z") {
      e.preventDefault();
      redo();
      return;
    }
    if (e.ctrlKey && e.key === "y") {
      e.preventDefault();
      redo();
      return;
    }

    if (!hoveredPanel) return;

    const treeView = treeViewRefs[hoveredPanel];
    if (!treeView) return;

    if (e.key === "x" || e.key === "X") {
      e.preventDefault();
      treeView.expandAll();
    } else if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      treeView.collapseAll();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="flex flex-col h-full">
  <Navbar
    onUndo={undo}
    onRedo={redo}
    {canUndo}
    {canRedo}
    onImportFile={handleImportFile}
    onExportV4={exportV5}
    {sourceSortMode}
    onToggleSort={() => (sourceSortMode = sourceSortMode === "alphabetical" ? "status" : "alphabetical")}
  />

  <div class="grid grid-cols-3 gap-4 flex-1 min-h-0 p-4 bg-background">
    {#each panels as panel}
      <Card.Root
        class="min-h-0 overflow-hidden flex flex-col p-0"
        onmouseenter={() => (hoveredPanel = panel.id)}
        onmouseleave={() => (hoveredPanel = null)}
      >
        <Card.Header
          class="bg-muted border-b-2 flex items-center justify-center !p-4 relative {panel.accentColor}"
        >
          {@const Icon = panel.icon}
          <Icon class="absolute left-4 h-4 w-4 {panel.textColor}" />
          <Card.Title class="text-sm font-semibold {panel.textColor}"
            >{panel.title}</Card.Title
          >
        </Card.Header>
        <Card.Content class="flex-1 overflow-auto">
          <TreeView
            bind:this={treeViewRefs[panel.id]}
            data={panel.getData()}
            panelId={panel.id}
            onDrop={handleDrop}
            onRename={(path, oldName, newName, isArrayItem) =>
              handleRename([panel.id, ...path], oldName, newName, isArrayItem)}
            onDelete={panel.id === "merged"
              ? (path, isArrayItem) =>
                  handleDeleteItem([panel.id, ...path], isArrayItem)
              : null}
            onCreateSection={panel.id === "merged" ? handleCreateSection : null}
            sourceMap={panel.id === "merged" ? sourceMap : null}
            usageMap={panel.getUsageMap()}
            highlightedPath={panel.getHighlightedPath()}
            onLineageHover={panel.id === "merged"
              ? handleLineageHover
              : panel.id === "left"
                ? handleLeftSourceHover
                : panel.id === "right"
                  ? handleRightSourceHover
                  : null}
            sortMode={panel.id !== "merged" ? sourceSortMode : "alphabetical"}
          />
        </Card.Content>
      </Card.Root>
    {/each}
  </div>
</div>
