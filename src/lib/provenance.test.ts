import { describe, it, expect, beforeEach } from "vitest";
import {
  type ProvenanceEntry,
  type ProvenanceSource,
  type SourcePanel,
  assignNodeIds,
  generateNodeId,
  deriveSource,
  buildSourceMap,
  buildUsageMap,
  addProvenanceSource,
  setProvenance,
  markProvenanceAsMerged,
  recordProvenanceRecursive,
  recordProvenanceForSectionMerge,
  removeProvenanceForSubtree,
  cloneProvenance,
  getLineageForPath,
  reindexNodeIdsAfterDelete,
  reindexNodeIdsAfterInsert,
  remapNodeIdPaths,
} from "./provenance";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Shorthand for creating a provenance source */
function src(
  panel: "left" | "right" | "user" | "llm",
  originalPath: string,
  action: "added" | "merged" | "created" = "added",
): ProvenanceSource {
  return { panel, originalPath, action };
}

/** Set up a simple merged tree with nodeIdMap + provenance for testing */
function setupMergedTree() {
  const nodeIdMap = new Map<string, string>();
  const provenance = new Map<string, ProvenanceEntry>();

  // Simulate a merged tree:
  //   Tumors/
  //     Brain tumors/
  //       0: "Astrocytoma"     (from left)
  //       1: "Glioblastoma"    (from right)
  //     Bone tumors/
  //       0: "Osteosarcoma"    (from left)
  const paths: Record<string, ProvenanceSource[]> = {
    Tumors: [src("left", "Tumors"), src("right", "Tumors", "merged")],
    "Tumors/Brain tumors": [
      src("left", "Brain tumors"),
      src("right", "Brain tumors", "merged"),
    ],
    "Tumors/Brain tumors/0": [src("left", "Brain tumors/0")],
    "Tumors/Brain tumors/1": [src("right", "Brain tumors/0")],
    "Tumors/Bone tumors": [src("left", "Bone tumors")],
    "Tumors/Bone tumors/0": [src("left", "Bone tumors/0")],
  };

  for (const [path, sources] of Object.entries(paths)) {
    const id = generateNodeId();
    nodeIdMap.set(path, id);
    provenance.set(id, { sources: [...sources] });
  }

  return { nodeIdMap, provenance };
}

// ─── deriveSource ───────────────────────────────────────────────────────────

describe("deriveSource", () => {
  it("returns 'created' for undefined entry", () => {
    expect(deriveSource(undefined)).toBe("created");
  });

  it("returns 'created' for empty sources", () => {
    expect(deriveSource({ sources: [] })).toBe("created");
  });

  it("returns 'left' for left-only sources", () => {
    expect(deriveSource({ sources: [src("left", "p")] })).toBe("left");
  });

  it("returns 'right' for right-only sources", () => {
    expect(deriveSource({ sources: [src("right", "p")] })).toBe("right");
  });

  it("returns 'both' when sources from both panels", () => {
    expect(
      deriveSource({ sources: [src("left", "a"), src("right", "b")] }),
    ).toBe("both");
  });

  it("returns 'created' for user-only sources", () => {
    expect(deriveSource({ sources: [src("user", "p", "created")] })).toBe(
      "created",
    );
  });

  it("returns 'left' when left + user sources", () => {
    expect(
      deriveSource({
        sources: [src("left", "p"), src("user", "p", "created")],
      }),
    ).toBe("left");
  });
});

// ─── buildSourceMap ─────────────────────────────────────────────────────────

describe("buildSourceMap", () => {
  it("maps each path to its derived source", () => {
    const { nodeIdMap, provenance } = setupMergedTree();
    const sourceMap = buildSourceMap(nodeIdMap, provenance);

    expect(sourceMap.get("Tumors")).toBe("both");
    expect(sourceMap.get("Tumors/Brain tumors")).toBe("both");
    expect(sourceMap.get("Tumors/Brain tumors/0")).toBe("left");
    expect(sourceMap.get("Tumors/Brain tumors/1")).toBe("right");
    expect(sourceMap.get("Tumors/Bone tumors")).toBe("left");
    expect(sourceMap.get("Tumors/Bone tumors/0")).toBe("left");
  });

  it("returns empty map for empty inputs", () => {
    const sourceMap = buildSourceMap(new Map(), new Map());
    expect(sourceMap.size).toBe(0);
  });

  it("returns 'created' for nodes without provenance", () => {
    const nodeIdMap = new Map([["orphan", "id-1"]]);
    const provenance = new Map<string, ProvenanceEntry>();
    const sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("orphan")).toBe("created");
  });
});

// ─── buildUsageMap ──────────────────────────────────────────────────────────

describe("buildUsageMap", () => {
  it("marks source items as 'added' when used from one panel", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    // Source panel paths (what the left panel tree looks like)
    const leftPathToId = new Map([
      ["Tumors", "src-1"],
      ["Brain tumors", "src-2"],
      ["Brain tumors/0", "src-3"],
      ["Bone tumors", "src-4"],
      ["Bone tumors/0", "src-5"],
    ]);

    const usage = buildUsageMap("left", leftPathToId, provenance);

    expect(usage.get("Tumors")).toBe("merged"); // Tumors has both panels
    expect(usage.get("Brain tumors")).toBe("merged");
    expect(usage.get("Brain tumors/0")).toBe("added"); // only left source
    expect(usage.get("Bone tumors")).toBe("added"); // only left source
    expect(usage.get("Bone tumors/0")).toBe("added");
  });

  it("marks source items as 'merged' when combined with other panel", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    const id = generateNodeId();
    nodeIdMap.set("Item", id);
    provenance.set(id, {
      sources: [src("left", "LeftItem"), src("right", "RightItem", "merged")],
    });

    const leftPathToId = new Map([["LeftItem", "src-1"]]);
    const usage = buildUsageMap("left", leftPathToId, provenance);
    expect(usage.get("LeftItem")).toBe("merged");
  });

  it("returns empty map when no provenance references the panel", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    const id = generateNodeId();
    nodeIdMap.set("Item", id);
    provenance.set(id, { sources: [src("left", "LeftOnly")] });

    const rightPathToId = new Map([["RightItem", "src-1"]]);
    const usage = buildUsageMap("right", rightPathToId, provenance);
    expect(usage.size).toBe(0);
  });
});

// ─── addProvenanceSource ────────────────────────────────────────────────────

describe("addProvenanceSource", () => {
  let provenance: Map<string, ProvenanceEntry>;

  beforeEach(() => {
    provenance = new Map();
  });

  it("creates new entry if node has no provenance", () => {
    addProvenanceSource(provenance, "node-1", src("left", "path/a"));
    const entry = provenance.get("node-1");
    expect(entry?.sources).toHaveLength(1);
    expect(entry?.sources[0].panel).toBe("left");
  });

  it("appends source to existing entry", () => {
    addProvenanceSource(provenance, "node-1", src("left", "path/a"));
    addProvenanceSource(provenance, "node-1", src("right", "path/b"));
    expect(provenance.get("node-1")?.sources).toHaveLength(2);
  });

  it("deduplicates by (panel, originalPath)", () => {
    addProvenanceSource(provenance, "node-1", src("left", "path/a"));
    addProvenanceSource(provenance, "node-1", src("left", "path/a"));
    expect(provenance.get("node-1")?.sources).toHaveLength(1);
  });

  it("allows same panel with different paths", () => {
    addProvenanceSource(provenance, "node-1", src("left", "path/a"));
    addProvenanceSource(provenance, "node-1", src("left", "path/b"));
    expect(provenance.get("node-1")?.sources).toHaveLength(2);
  });
});

// ─── markProvenanceAsMerged ─────────────────────────────────────────────────

describe("markProvenanceAsMerged", () => {
  it("sets all sources to action 'merged'", () => {
    const provenance = new Map<string, ProvenanceEntry>();
    provenance.set("node-1", {
      sources: [src("left", "a", "added"), src("right", "b", "added")],
    });

    markProvenanceAsMerged(provenance, "node-1");

    const entry = provenance.get("node-1")!;
    expect(entry.sources[0].action).toBe("merged");
    expect(entry.sources[1].action).toBe("merged");
  });

  it("does nothing for nonexistent node", () => {
    const provenance = new Map<string, ProvenanceEntry>();
    markProvenanceAsMerged(provenance, "ghost");
    expect(provenance.size).toBe(0);
  });
});

// ─── Merge scenario: section merge (object onto object) ────────────────────

describe("section merge scenarios", () => {
  it("merging two sections from different panels produces 'both' parent", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    // Step 1: Add left section "Tumors" with child "Astrocytoma"
    const tree = { Tumors: ["Astrocytoma"] };
    assignNodeIds(tree, "", nodeIdMap);
    recordProvenanceRecursive(
      provenance,
      nodeIdMap,
      "Tumors",
      "Tumors",
      "left",
      ["Astrocytoma"],
    );

    const sourceMap1 = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap1.get("Tumors")).toBe("left");
    expect(sourceMap1.get("Tumors/0")).toBe("left");

    // Step 2: Merge right section "Tumors" with child "Glioblastoma"
    // Simulate: right's "Tumors" maps to same merged path
    addProvenanceSource(provenance, nodeIdMap.get("Tumors")!, {
      panel: "right",
      originalPath: "Tumors",
      action: "merged",
    });
    // Add the new child at index 1
    (tree.Tumors as string[]).push("Glioblastoma");
    assignNodeIds(tree, "", nodeIdMap);
    recordProvenanceRecursive(
      provenance,
      nodeIdMap,
      "Tumors/1",
      "Tumors/0",
      "right",
      "Glioblastoma",
    );

    // Mark all as merged
    markProvenanceAsMerged(provenance, nodeIdMap.get("Tumors")!);

    const sourceMap2 = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap2.get("Tumors")).toBe("both");
    expect(sourceMap2.get("Tumors/0")).toBe("left");
    expect(sourceMap2.get("Tumors/1")).toBe("right");
  });

  it("children retain individual source after parent merge", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    // Build a merged section with children from different sources
    const tree = {
      Neuro: {
        "Brain tumors": ["Astrocytoma", "Meningioma"],
      },
    };
    assignNodeIds(tree, "", nodeIdMap);

    // Parent from both panels
    setProvenance(provenance, nodeIdMap.get("Neuro")!, [
      src("left", "Neuro", "merged"),
      src("right", "Neuro", "merged"),
    ]);
    setProvenance(provenance, nodeIdMap.get("Neuro/Brain tumors")!, [
      src("left", "Brain tumors", "merged"),
      src("right", "Brain tumors", "merged"),
    ]);
    // Children from individual panels
    setProvenance(provenance, nodeIdMap.get("Neuro/Brain tumors/0")!, [
      src("left", "Brain tumors/0"),
    ]);
    setProvenance(provenance, nodeIdMap.get("Neuro/Brain tumors/1")!, [
      src("right", "Brain tumors/0"),
    ]);

    const sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Neuro")).toBe("both");
    expect(sourceMap.get("Neuro/Brain tumors")).toBe("both");
    expect(sourceMap.get("Neuro/Brain tumors/0")).toBe("left");
    expect(sourceMap.get("Neuro/Brain tumors/1")).toBe("right");
  });
});

// ─── Merge scenario: leaf merge (two array items combined) ──────────────────

describe("leaf merge scenarios", () => {
  it("merging two leaf items from different panels produces 'both'", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    // Item originally from left
    const targetId = generateNodeId();
    nodeIdMap.set("Section/0", targetId);
    setProvenance(provenance, targetId, [src("left", "Section/0")]);

    // Merge in a right item → add right source, mark as merged
    addProvenanceSource(provenance, targetId, src("right", "Section/0", "merged"));
    markProvenanceAsMerged(provenance, targetId);

    const sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Section/0")).toBe("both");
  });

  it("merging two items from the same panel stays single-source", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    const id = generateNodeId();
    nodeIdMap.set("Section/0", id);
    setProvenance(provenance, id, [src("left", "Left/A")]);
    addProvenanceSource(provenance, id, src("left", "Left/B"));

    const sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Section/0")).toBe("left");
  });
});

// ─── recordProvenanceRecursive ──────────────────────────────────────────────

describe("recordProvenanceRecursive", () => {
  it("records provenance for all levels of a nested tree", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    const tree = {
      Root: {
        Child: ["leaf1", "leaf2"],
      },
    };
    assignNodeIds(tree, "", nodeIdMap);
    recordProvenanceRecursive(
      provenance,
      nodeIdMap,
      "Root",
      "Root",
      "left",
      tree.Root,
    );

    const sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Root")).toBe("left");
    expect(sourceMap.get("Root/Child")).toBe("left");
    expect(sourceMap.get("Root/Child/0")).toBe("left");
    expect(sourceMap.get("Root/Child/1")).toBe("left");
  });
});

// ─── recordProvenanceForSectionMerge ────────────────────────────────────────

describe("recordProvenanceForSectionMerge", () => {
  it("marks parent as merged but new children as added", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    // Existing merged tree: Section has items from left
    const mergedTree = { Section: ["ItemA", "ItemB", "ItemC"] };
    assignNodeIds(mergedTree, "", nodeIdMap);
    recordProvenanceRecursive(
      provenance,
      nodeIdMap,
      "Section",
      "Section",
      "left",
      mergedTree.Section,
    );

    // Now merge right panel's Section: has ItemB (overlap) and ItemC (new index)
    const rightValue = ["ItemB", "ItemC"];
    recordProvenanceForSectionMerge(
      provenance,
      nodeIdMap,
      "Section",
      "RightSection",
      "right",
      rightValue,
      mergedTree.Section,
    );

    // Parent should have right source with "merged" action
    const parentEntry = provenance.get(nodeIdMap.get("Section")!)!;
    const rightSource = parentEntry.sources.find((s) => s.panel === "right");
    expect(rightSource).toBeDefined();
    expect(rightSource!.action).toBe("merged");

    // Existing left children should still be "left"
    const sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Section")).toBe("both");
  });
});

// ─── Move within merged panel: path remapping ───────────────────────────────

describe("remapNodeIdPaths", () => {
  it("remaps exact path and children", () => {
    const nodeIdMap = new Map([
      ["A", "id-1"],
      ["A/child", "id-2"],
      ["B", "id-3"],
    ]);

    const result = remapNodeIdPaths(nodeIdMap, "A", "C");
    expect(result.get("C")).toBe("id-1");
    expect(result.get("C/child")).toBe("id-2");
    expect(result.get("B")).toBe("id-3");
    expect(result.has("A")).toBe(false);
    expect(result.has("A/child")).toBe(false);
  });
});

// ─── Reindex after delete ───────────────────────────────────────────────────

describe("reindexNodeIdsAfterDelete", () => {
  it("shifts down indices above deleted index", () => {
    const nodeIdMap = new Map([
      ["Section/0", "id-0"],
      ["Section/1", "id-1"],
      ["Section/2", "id-2"],
    ]);

    const result = reindexNodeIdsAfterDelete(
      nodeIdMap,
      "Section",
      1,
      "Section/1",
    );

    expect(result.get("Section/0")).toBe("id-0");
    expect(result.get("Section/1")).toBe("id-2"); // was at index 2
    expect(result.has("Section/2")).toBe(false); // gone
    expect(result.has("Section/1")).toBeDefined(); // reassigned
  });

  it("preserves children of shifted items", () => {
    const nodeIdMap = new Map([
      ["Arr/0", "id-0"],
      ["Arr/1", "id-1"],
      ["Arr/1/sub", "id-1-sub"],
      ["Arr/2", "id-2"],
    ]);

    const result = reindexNodeIdsAfterDelete(nodeIdMap, "Arr", 0, "Arr/0");

    expect(result.get("Arr/0")).toBe("id-1");
    expect(result.get("Arr/0/sub")).toBe("id-1-sub");
    expect(result.get("Arr/1")).toBe("id-2");
    expect(result.has("Arr/2")).toBe(false);
  });
});

// ─── Reindex after insert ───────────────────────────────────────────────────

describe("reindexNodeIdsAfterInsert", () => {
  it("shifts up indices at and above inserted index", () => {
    const nodeIdMap = new Map([
      ["Section/0", "id-0"],
      ["Section/1", "id-1"],
    ]);

    const result = reindexNodeIdsAfterInsert(nodeIdMap, "Section", 1);

    expect(result.get("Section/0")).toBe("id-0");
    expect(result.get("Section/2")).toBe("id-1"); // shifted from 1 to 2
    expect(result.has("Section/1")).toBe(false); // slot freed for insertion
  });
});

// ─── removeProvenanceForSubtree ─────────────────────────────────────────────

describe("removeProvenanceForSubtree", () => {
  it("removes provenance for node and all children", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    const sizeBefore = provenance.size;
    removeProvenanceForSubtree(provenance, nodeIdMap, "Tumors/Brain tumors");

    // Should remove: "Tumors/Brain tumors", "Tumors/Brain tumors/0", "Tumors/Brain tumors/1"
    expect(provenance.size).toBe(sizeBefore - 3);

    // "Tumors" and "Tumors/Bone tumors/*" should survive
    const tumorsId = nodeIdMap.get("Tumors")!;
    expect(provenance.has(tumorsId)).toBe(true);
  });

  it("does not remove unrelated paths", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    removeProvenanceForSubtree(provenance, nodeIdMap, "Tumors/Brain tumors");

    const boneId = nodeIdMap.get("Tumors/Bone tumors")!;
    expect(provenance.has(boneId)).toBe(true);
  });
});

// ─── cloneProvenance ────────────────────────────────────────────────────────

describe("cloneProvenance", () => {
  it("produces a deep independent copy", () => {
    const provenance = new Map<string, ProvenanceEntry>();
    provenance.set("a", { sources: [src("left", "path")] });

    const clone = cloneProvenance(provenance);

    // Mutating original should not affect clone
    provenance.get("a")!.sources[0].action = "merged";
    expect(clone.get("a")!.sources[0].action).toBe("added");
  });
});

// ─── getLineageForPath ──────────────────────────────────────────────────────

describe("getLineageForPath", () => {
  it("returns provenance entry for a valid path", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    const entry = getLineageForPath(
      "Tumors/Brain tumors/0",
      nodeIdMap,
      provenance,
    );
    expect(entry).toBeDefined();
    expect(entry!.sources[0].panel).toBe("left");
  });

  it("returns undefined for unknown path", () => {
    const { nodeIdMap, provenance } = setupMergedTree();
    expect(
      getLineageForPath("nonexistent", nodeIdMap, provenance),
    ).toBeUndefined();
  });
});

// ─── End-to-end merge + styling scenario ────────────────────────────────────

describe("end-to-end merge styling", () => {
  it("full merge workflow produces correct colors at all levels", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    // Step 1: Build left panel tree
    const leftTree = {
      Tumors: {
        "Brain tumors": ["Astrocytoma", "Oligodendroglioma"],
        "Bone tumors": ["Osteosarcoma"],
      },
    };

    // Step 2: Add left tree to merged panel
    assignNodeIds(leftTree, "", nodeIdMap);
    recordProvenanceRecursive(
      provenance,
      nodeIdMap,
      "",
      "",
      "left",
      leftTree,
    );

    // Verify all nodes show as "left"
    let sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Tumors")).toBe("left");
    expect(sourceMap.get("Tumors/Brain tumors")).toBe("left");
    expect(sourceMap.get("Tumors/Brain tumors/0")).toBe("left");
    expect(sourceMap.get("Tumors/Brain tumors/1")).toBe("left");
    expect(sourceMap.get("Tumors/Bone tumors")).toBe("left");
    expect(sourceMap.get("Tumors/Bone tumors/0")).toBe("left");

    // Step 3: Merge right panel's "Tumors/Brain tumors" with "Glioblastoma"
    // This is a section merge: the right panel also has "Brain tumors"
    addProvenanceSource(provenance, nodeIdMap.get("Tumors")!, {
      panel: "right",
      originalPath: "Tumors",
      action: "merged",
    });
    addProvenanceSource(
      provenance,
      nodeIdMap.get("Tumors/Brain tumors")!,
      { panel: "right", originalPath: "Brain tumors", action: "merged" },
    );

    // Add the new child
    (leftTree.Tumors["Brain tumors"] as string[]).push("Glioblastoma");
    assignNodeIds(leftTree, "", nodeIdMap);
    recordProvenanceRecursive(
      provenance,
      nodeIdMap,
      "Tumors/Brain tumors/2",
      "Brain tumors/0",
      "right",
      "Glioblastoma",
    );

    // Mark parent nodes as merged
    markProvenanceAsMerged(provenance, nodeIdMap.get("Tumors")!);
    markProvenanceAsMerged(
      provenance,
      nodeIdMap.get("Tumors/Brain tumors")!,
    );

    // Step 4: Verify final colors
    sourceMap = buildSourceMap(nodeIdMap, provenance);

    // Parents that were merged should be "both" (purple)
    expect(sourceMap.get("Tumors")).toBe("both");
    expect(sourceMap.get("Tumors/Brain tumors")).toBe("both");

    // Original left children stay "left" (red)
    expect(sourceMap.get("Tumors/Brain tumors/0")).toBe("left");
    expect(sourceMap.get("Tumors/Brain tumors/1")).toBe("left");

    // New right child is "right" (blue)
    expect(sourceMap.get("Tumors/Brain tumors/2")).toBe("right");

    // Unmerged section stays "left"
    expect(sourceMap.get("Tumors/Bone tumors")).toBe("left");
    expect(sourceMap.get("Tumors/Bone tumors/0")).toBe("left");
  });

  it("usage maps correctly reflect merge status in source panels", () => {
    const nodeIdMap = new Map<string, string>();
    const provenance = new Map<string, ProvenanceEntry>();

    // Set up a merged item that came from both panels
    const id1 = generateNodeId();
    nodeIdMap.set("MergedSection", id1);
    provenance.set(id1, {
      sources: [
        src("left", "LeftSection", "merged"),
        src("right", "RightSection", "merged"),
      ],
    });

    // Set up an item only from left
    const id2 = generateNodeId();
    nodeIdMap.set("LeftOnly", id2);
    provenance.set(id2, { sources: [src("left", "LeftOnly")] });

    // Left source panel paths
    const leftPathToId = new Map([
      ["LeftSection", "lsrc-1"],
      ["LeftOnly", "lsrc-2"],
      ["Unused", "lsrc-3"],
    ]);

    const leftUsage = buildUsageMap("left", leftPathToId, provenance);
    expect(leftUsage.get("LeftSection")).toBe("merged"); // part of merged item
    expect(leftUsage.get("LeftOnly")).toBe("added"); // only added, not merged
    expect(leftUsage.has("Unused")).toBe(false); // not in provenance at all

    // Right source panel paths
    const rightPathToId = new Map([
      ["RightSection", "rsrc-1"],
      ["RightUnused", "rsrc-2"],
    ]);

    const rightUsage = buildUsageMap("right", rightPathToId, provenance);
    expect(rightUsage.get("RightSection")).toBe("merged");
    expect(rightUsage.has("RightUnused")).toBe(false);
  });

  it("removing a subtree clears its source from the sourceMap", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    // Verify "Brain tumors" subtree exists
    let sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.has("Tumors/Brain tumors/0")).toBe(true);

    // Remove the subtree
    removeProvenanceForSubtree(provenance, nodeIdMap, "Tumors/Brain tumors");

    // Rebuild sourceMap — removed items should still appear (nodeIdMap has them)
    // but with "created" since provenance is gone
    sourceMap = buildSourceMap(nodeIdMap, provenance);
    expect(sourceMap.get("Tumors/Brain tumors")).toBe("created");
    expect(sourceMap.get("Tumors/Brain tumors/0")).toBe("created");
  });

  it("path remapping preserves colors after rename", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    // Rename "Brain tumors" → "CNS tumors"
    const newNodeIdMap = remapNodeIdPaths(
      nodeIdMap,
      "Tumors/Brain tumors",
      "Tumors/CNS tumors",
    );

    const sourceMap = buildSourceMap(newNodeIdMap, provenance);

    // Old paths should be gone
    expect(sourceMap.has("Tumors/Brain tumors")).toBe(false);
    expect(sourceMap.has("Tumors/Brain tumors/0")).toBe(false);

    // New paths should have same colors
    expect(sourceMap.get("Tumors/CNS tumors")).toBe("both");
    expect(sourceMap.get("Tumors/CNS tumors/0")).toBe("left");
    expect(sourceMap.get("Tumors/CNS tumors/1")).toBe("right");
  });

  it("array reindex after delete preserves correct colors", () => {
    const { nodeIdMap, provenance } = setupMergedTree();

    // Delete index 0 from "Brain tumors" (the "left" item)
    const deletedKey = "Tumors/Brain tumors/0";
    removeProvenanceForSubtree(provenance, nodeIdMap, deletedKey);
    const newNodeIdMap = reindexNodeIdsAfterDelete(
      nodeIdMap,
      "Tumors/Brain tumors",
      0,
      deletedKey,
    );

    const sourceMap = buildSourceMap(newNodeIdMap, provenance);

    // The "right" item (was at index 1) should now be at index 0
    expect(sourceMap.get("Tumors/Brain tumors/0")).toBe("right");
    // Index 1 should not exist
    expect(sourceMap.has("Tumors/Brain tumors/1")).toBe(false);
  });
});
