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

  it("array-array sibling merge: dragged children get correct indices", () => {
    // Simulate: left "Choroid plexus tumors" has 1 child at index 0
    //           right "Choroid plexus tumours" has 3 children at indices 0, 1, 2
    // After merging right onto left, merged array = [left-0, right-0, right-1, right-2]
    // Provenance should: keep left-0 as "left", place right items at indices 1, 2, 3

    const nodeIdMap = new Map<string, string>();
    const prov = new Map<string, ProvenanceEntry>();

    // Set up the left item at index 0
    const parentId = generateNodeId();
    nodeIdMap.set("Parent/Section", parentId);
    addProvenanceSource(prov, parentId, {
      panel: "left",
      originalPath: "LeftParent/Section",
      action: "added",
    });

    const leftChild0Id = generateNodeId();
    nodeIdMap.set("Parent/Section/0", leftChild0Id);
    addProvenanceSource(prov, leftChild0Id, {
      panel: "left",
      originalPath: "LeftParent/Section/0",
      action: "added",
    });

    // Simulate the array-array merge: build index remap
    const targetLenBefore = 1; // left had 1 item
    const draggedItems = ["item-a", "item-b", "item-c"];
    const targetItems = ["left-item-0"]; // no duplicates
    const arrayMergeIndexMap = new Map<number, number>();
    let nextIdx = targetLenBefore;
    for (let i = 0; i < draggedItems.length; i++) {
      const existingIdx = targetItems.findIndex((ex) => ex === draggedItems[i]);
      if (existingIdx !== -1) {
        arrayMergeIndexMap.set(i, existingIdx);
      } else {
        targetItems.push(draggedItems[i]);
        arrayMergeIndexMap.set(i, nextIdx++);
      }
    }

    // Verify the mapping: 0→1, 1→2, 2→3
    expect(arrayMergeIndexMap.get(0)).toBe(1);
    expect(arrayMergeIndexMap.get(1)).toBe(2);
    expect(arrayMergeIndexMap.get(2)).toBe(3);

    // Simulate transferring child provenance with remap
    const draggedChildSuffixes = ["/0", "/1", "/2"];
    const rightOrigPaths = [
      "RightParent/Section/0",
      "RightParent/Section/1",
      "RightParent/Section/2",
    ];

    for (let i = 0; i < draggedChildSuffixes.length; i++) {
      const suffix = draggedChildSuffixes[i];
      const match = suffix.match(/^\/(\d+)(\/.*)?$/);
      expect(match).not.toBeNull();
      const oldIdx = parseInt(match![1], 10);
      const rest = match![2] || "";
      const newIdx = arrayMergeIndexMap.get(oldIdx);
      expect(newIdx).toBeDefined();
      const childTargetPath = `Parent/Section/${newIdx}${rest}`;

      const childId = generateNodeId();
      nodeIdMap.set(childTargetPath, childId);
      addProvenanceSource(prov, childId, {
        panel: "right",
        originalPath: rightOrigPaths[i],
        action: "added",
      });
    }

    // Mark parent as merged
    addProvenanceSource(prov, parentId, {
      panel: "right",
      originalPath: "RightParent/Section",
      action: "merged",
    });

    const sourceMap = buildSourceMap(nodeIdMap, prov);

    // Parent should be "both"
    expect(sourceMap.get("Parent/Section")).toBe("both");
    // Left child at index 0 should still be "left" only (NOT purple)
    expect(sourceMap.get("Parent/Section/0")).toBe("left");
    // Right children at indices 1, 2, 3 should be "right"
    expect(sourceMap.get("Parent/Section/1")).toBe("right");
    expect(sourceMap.get("Parent/Section/2")).toBe("right");
    expect(sourceMap.get("Parent/Section/3")).toBe("right");
  });

  it("array-array sibling merge with duplicates: shared items get both sources", () => {
    const nodeIdMap = new Map<string, string>();
    const prov = new Map<string, ProvenanceEntry>();

    // Left has ["alpha", "beta"] at indices 0, 1
    const parentId = generateNodeId();
    nodeIdMap.set("Section", parentId);
    addProvenanceSource(prov, parentId, {
      panel: "left",
      originalPath: "LeftSection",
      action: "added",
    });

    const left0Id = generateNodeId();
    nodeIdMap.set("Section/0", left0Id);
    addProvenanceSource(prov, left0Id, {
      panel: "left",
      originalPath: "LeftSection/0",
      action: "added",
    });

    const left1Id = generateNodeId();
    nodeIdMap.set("Section/1", left1Id);
    addProvenanceSource(prov, left1Id, {
      panel: "left",
      originalPath: "LeftSection/1",
      action: "added",
    });

    // Right has ["beta", "gamma"] — "beta" is duplicate with left index 1
    const targetItems = ["alpha", "beta"];
    const draggedItems = ["beta", "gamma"];

    const arrayMergeIndexMap = new Map<number, number>();
    let nextIdx = targetItems.length;
    for (let i = 0; i < draggedItems.length; i++) {
      const existingIdx = targetItems.findIndex((ex) => ex === draggedItems[i]);
      if (existingIdx !== -1) {
        arrayMergeIndexMap.set(i, existingIdx);
      } else {
        targetItems.push(draggedItems[i]);
        arrayMergeIndexMap.set(i, nextIdx++);
      }
    }

    // "beta" (dragged 0) → existing index 1, "gamma" (dragged 1) → new index 2
    expect(arrayMergeIndexMap.get(0)).toBe(1);
    expect(arrayMergeIndexMap.get(1)).toBe(2);

    // Apply right provenance using remap
    const rightOrigPaths = ["RightSection/0", "RightSection/1"];
    for (let i = 0; i < draggedItems.length; i++) {
      const newIdx = arrayMergeIndexMap.get(i)!;
      const childPath = `Section/${newIdx}`;
      if (!nodeIdMap.has(childPath)) {
        nodeIdMap.set(childPath, generateNodeId());
      }
      const childId = nodeIdMap.get(childPath)!;
      addProvenanceSource(prov, childId, {
        panel: "right",
        originalPath: rightOrigPaths[i],
        action: "added",
      });
    }

    const sourceMap = buildSourceMap(nodeIdMap, prov);

    // "alpha" (index 0) — left only
    expect(sourceMap.get("Section/0")).toBe("left");
    // "beta" (index 1) — both (left + right duplicate)
    expect(sourceMap.get("Section/1")).toBe("both");
    // "gamma" (index 2) — right only
    expect(sourceMap.get("Section/2")).toBe("right");
  });
});

// ─── Regression: Choroid plexus tumors merge scenario ────────────────────────
// Reproduces the exact bug from the log where:
// 1. Left "Choroid plexus tumors" had 1 child (index 0)
// 2. Right "Choroid plexus tumours" had 3 children (indices 0,1,2)
// 3. After sibling merge, right children got wrong indices/colors

describe("regression: choroid plexus tumors merge flow", () => {
  /**
   * Simulates the full 3-step merge from the bug report:
   *   Step 1: Drop "CNS tumor" (left) → merged
   *   Step 2: Drop "Central Nervous System Tumours" (right) onto "CNS tumor" → section merge
   *   Step 3: Drop "Choroid plexus tumours" (merged sibling) onto "Choroid plexus tumors" → array merge
   *
   * Returns the final provenance state for assertions.
   */
  function simulateChoroidPlexusMerge() {
    const nodeIdMap = new Map<string, string>();
    const prov = new Map<string, ProvenanceEntry>();

    // ── Step 1: Drop "CNS tumor" from left into merged ──
    // Left tree: CNS tumor → { "Choroid plexus tumors": ["choroid plexus tumors papilloma atypical papilloma carcinoma"] }
    const leftTree = {
      "Choroid plexus tumors": [
        "choroid plexus tumors papilloma atypical papilloma carcinoma",
      ],
    };

    // Assign IDs and record provenance for the full subtree
    assignNodeIds({ "CNS tumor": leftTree }, "", nodeIdMap);
    recordProvenanceRecursive(
      prov,
      nodeIdMap,
      "CNS tumor",
      "CNS tumor",
      "left",
      leftTree,
    );

    // Verify step 1
    let sourceMap = buildSourceMap(nodeIdMap, prov);
    expect(sourceMap.get("CNS tumor")).toBe("left");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumors")).toBe("left");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumors/0")).toBe("left");

    // ── Step 2: Section merge "Central Nervous System Tumours" (right) onto "CNS tumor" ──
    // Right tree: { "Choroid plexus tumours": ["Choroid plexus papilloma", "Atypical choroid plexus papilloma", "Choroid plexus carcinoma"], ... }
    // After absorption, merged CNS tumor gets the right's children as new keys
    const rightChildren = {
      "Choroid plexus tumours": [
        "Choroid plexus papilloma",
        "Atypical choroid plexus papilloma",
        "Choroid plexus carcinoma",
      ],
    };

    // The merged tree after absorption has both keys:
    const mergedAfterAbsorb = {
      "Choroid plexus tumors": [
        "choroid plexus tumors papilloma atypical papilloma carcinoma",
      ],
      "Choroid plexus tumours": [
        "Choroid plexus papilloma",
        "Atypical choroid plexus papilloma",
        "Choroid plexus carcinoma",
      ],
    };

    // Assign IDs for new paths (non-destructive)
    assignNodeIds({ "CNS tumor": mergedAfterAbsorb }, "", nodeIdMap);

    // Mark parent "CNS tumor" as merged (it now has both sources)
    const parentId = nodeIdMap.get("CNS tumor")!;
    addProvenanceSource(prov, parentId, {
      panel: "right",
      originalPath: "Central Nervous System Tumours",
      action: "merged",
    });

    // Record provenance for the absorbed right children
    recordProvenanceRecursive(
      prov,
      nodeIdMap,
      "CNS tumor/Choroid plexus tumours",
      "Central Nervous System Tumours/Choroid plexus tumours",
      "right",
      rightChildren["Choroid plexus tumours"],
    );

    // Verify step 2: "Choroid plexus tumours" (with 'u') is right-only
    sourceMap = buildSourceMap(nodeIdMap, prov);
    expect(sourceMap.get("CNS tumor")).toBe("both");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumours")).toBe("right");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumours/0")).toBe("right");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumours/1")).toBe("right");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumours/2")).toBe("right");

    // ── Step 3: Sibling merge "Choroid plexus tumours" onto "Choroid plexus tumors" ──
    // This is a merged-to-merged drag (sourcePanel === "merged")

    // 3a. Capture dragged item's provenance before removal
    const draggedPath = "CNS tumor/Choroid plexus tumours";
    const draggedLineage = getLineageForPath(draggedPath, nodeIdMap, prov);
    const draggedChildLineageMap = new Map<string, ProvenanceEntry>();
    const childPrefix = draggedPath + "/";
    for (const [path, nid] of nodeIdMap) {
      if (path.startsWith(childPrefix)) {
        const entry = prov.get(nid);
        if (entry && entry.sources.length > 0) {
          const suffix = path.slice(draggedPath.length);
          draggedChildLineageMap.set(suffix, {
            sources: entry.sources.map((s) => ({ ...s })),
          });
        }
      }
    }

    // 3b. Remove dragged item and its children from provenance
    removeProvenanceForSubtree(prov, nodeIdMap, draggedPath);
    // Also clean up nodeIdMap entries for the removed key
    for (const [path] of [...nodeIdMap.entries()]) {
      if (path === draggedPath || path.startsWith(childPrefix)) {
        nodeIdMap.delete(path);
      }
    }

    // 3c. Array-array merge: append right items to left's array
    const targetPath = "CNS tumor/Choroid plexus tumors";
    const targetArray = [
      "choroid plexus tumors papilloma atypical papilloma carcinoma",
    ];
    const draggedArray = [
      "Choroid plexus papilloma",
      "Atypical choroid plexus papilloma",
      "Choroid plexus carcinoma",
    ];

    // Build index remap (the fix)
    const arrayMergeIndexMap = new Map<number, number>();
    let nextIdx = targetArray.length;
    for (let i = 0; i < draggedArray.length; i++) {
      const existingIdx = targetArray.findIndex(
        (ex) => typeof ex === typeof draggedArray[i] && String(ex) === String(draggedArray[i]),
      );
      if (existingIdx !== -1) {
        arrayMergeIndexMap.set(i, existingIdx);
      } else {
        targetArray.push(draggedArray[i]);
        arrayMergeIndexMap.set(i, nextIdx++);
      }
    }

    // Assign IDs for newly appended items
    for (let i = 1; i < targetArray.length; i++) {
      const p = `${targetPath}/${i}`;
      if (!nodeIdMap.has(p)) {
        nodeIdMap.set(p, generateNodeId());
      }
    }

    // 3d. Transfer parent provenance: mark target as merged
    const targetId = nodeIdMap.get(targetPath)!;
    markProvenanceAsMerged(prov, targetId);
    if (draggedLineage) {
      for (const s of draggedLineage.sources) {
        addProvenanceSource(prov, targetId, {
          panel: s.panel,
          originalPath: s.originalPath,
          action: "merged",
        });
      }
    }

    // 3e. Transfer children's provenance WITH index remap
    for (const [suffix, entry] of draggedChildLineageMap) {
      let childTargetPath: string;
      const match = suffix.match(/^\/(\d+)(\/.*)?$/);
      if (match && arrayMergeIndexMap) {
        const oldIdx = parseInt(match[1], 10);
        const rest = match[2] || "";
        const newIdx = arrayMergeIndexMap.get(oldIdx);
        if (newIdx === undefined) continue;
        childTargetPath = `${targetPath}/${newIdx}${rest}`;
      } else {
        childTargetPath = targetPath + suffix;
      }
      if (!nodeIdMap.has(childTargetPath)) {
        nodeIdMap.set(childTargetPath, generateNodeId());
      }
      const childId = nodeIdMap.get(childTargetPath)!;
      for (const s of entry.sources) {
        addProvenanceSource(prov, childId, {
          panel: s.panel,
          originalPath: s.originalPath,
          action: s.action,
        });
      }
    }

    return { nodeIdMap, prov, targetArray };
  }

  it("left-only item at index 0 stays blue (not purple)", () => {
    const { nodeIdMap, prov } = simulateChoroidPlexusMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    // "choroid plexus tumors papilloma atypical papilloma carcinoma" (left, index 0)
    // must remain "left" — the old bug made it "both" (purple)
    expect(sourceMap.get("CNS tumor/Choroid plexus tumors/0")).toBe("left");
  });

  it("all right children have provenance at correct indices", () => {
    const { nodeIdMap, prov } = simulateChoroidPlexusMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    // Right items appended at indices 1, 2, 3 — all should be "right"
    expect(sourceMap.get("CNS tumor/Choroid plexus tumors/1")).toBe("right");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumors/2")).toBe("right");
    expect(sourceMap.get("CNS tumor/Choroid plexus tumors/3")).toBe("right");
  });

  it("no item is left without provenance (uncolored)", () => {
    const { nodeIdMap, prov, targetArray } = simulateChoroidPlexusMerge();

    // Every index in the merged array must have a provenance entry
    for (let i = 0; i < targetArray.length; i++) {
      const path = `CNS tumor/Choroid plexus tumors/${i}`;
      const entry = getLineageForPath(path, nodeIdMap, prov);
      expect(entry, `index ${i} ("${targetArray[i]}") should have provenance`).toBeDefined();
      expect(entry!.sources.length).toBeGreaterThan(0);
    }
  });

  it("shift+hover originalPath points to correct source items", () => {
    const { nodeIdMap, prov } = simulateChoroidPlexusMerge();

    // Index 0: left item — originalPath should reference the left source
    const entry0 = getLineageForPath("CNS tumor/Choroid plexus tumors/0", nodeIdMap, prov)!;
    expect(entry0.sources).toHaveLength(1);
    expect(entry0.sources[0].panel).toBe("left");
    expect(entry0.sources[0].originalPath).toBe("CNS tumor/Choroid plexus tumors/0");

    // Index 1: "Choroid plexus papilloma" — was right index 0
    const entry1 = getLineageForPath("CNS tumor/Choroid plexus tumors/1", nodeIdMap, prov)!;
    expect(entry1.sources).toHaveLength(1);
    expect(entry1.sources[0].panel).toBe("right");
    expect(entry1.sources[0].originalPath).toBe(
      "Central Nervous System Tumours/Choroid plexus tumours/0",
    );

    // Index 2: "Atypical choroid plexus papilloma" — was right index 1
    const entry2 = getLineageForPath("CNS tumor/Choroid plexus tumors/2", nodeIdMap, prov)!;
    expect(entry2.sources).toHaveLength(1);
    expect(entry2.sources[0].panel).toBe("right");
    expect(entry2.sources[0].originalPath).toBe(
      "Central Nervous System Tumours/Choroid plexus tumours/1",
    );

    // Index 3: "Choroid plexus carcinoma" — was right index 2
    const entry3 = getLineageForPath("CNS tumor/Choroid plexus tumors/3", nodeIdMap, prov)!;
    expect(entry3.sources).toHaveLength(1);
    expect(entry3.sources[0].panel).toBe("right");
    expect(entry3.sources[0].originalPath).toBe(
      "Central Nervous System Tumours/Choroid plexus tumours/2",
    );
  });

  it("merged parent section is purple (both sources)", () => {
    const { nodeIdMap, prov } = simulateChoroidPlexusMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    expect(sourceMap.get("CNS tumor/Choroid plexus tumors")).toBe("both");
  });

  it("source usage map reflects correct panels after merge", () => {
    const { nodeIdMap, prov } = simulateChoroidPlexusMerge();

    // Build a left-panel usage map
    // The left source paths referenced in provenance should show as used
    const leftPathToId = new Map<string, string>();
    leftPathToId.set("CNS tumor", generateNodeId());
    leftPathToId.set("CNS tumor/Choroid plexus tumors", generateNodeId());
    leftPathToId.set("CNS tumor/Choroid plexus tumors/0", generateNodeId());

    const leftUsage = buildUsageMap("left", leftPathToId, prov);
    // The left parent and child should be marked as used
    expect(leftUsage.get("CNS tumor")).toBe("merged");
    expect(leftUsage.get("CNS tumor/Choroid plexus tumors")).toBe("merged");
    expect(leftUsage.get("CNS tumor/Choroid plexus tumors/0")).toBe("added");

    // Build a right-panel usage map
    const rightPathToId = new Map<string, string>();
    rightPathToId.set("Central Nervous System Tumours", generateNodeId());
    rightPathToId.set(
      "Central Nervous System Tumours/Choroid plexus tumours",
      generateNodeId(),
    );
    rightPathToId.set(
      "Central Nervous System Tumours/Choroid plexus tumours/0",
      generateNodeId(),
    );
    rightPathToId.set(
      "Central Nervous System Tumours/Choroid plexus tumours/1",
      generateNodeId(),
    );
    rightPathToId.set(
      "Central Nervous System Tumours/Choroid plexus tumours/2",
      generateNodeId(),
    );

    const rightUsage = buildUsageMap("right", rightPathToId, prov);
    expect(rightUsage.get("Central Nervous System Tumours")).toBe("merged");
    expect(
      rightUsage.get("Central Nervous System Tumours/Choroid plexus tumours"),
    ).toBe("merged");
    expect(
      rightUsage.get("Central Nervous System Tumours/Choroid plexus tumours/0"),
    ).toBe("added");
    expect(
      rightUsage.get("Central Nervous System Tumours/Choroid plexus tumours/1"),
    ).toBe("added");
    expect(
      rightUsage.get("Central Nervous System Tumours/Choroid plexus tumours/2"),
    ).toBe("added");
  });
});

// ─── Regression: Embryonal tumors / Medulloblastoma merge scenario ───────────
// Reproduces the bug where object-object merge silently dropped children
// when a matching sub-key had mismatched types (left=array, right=object).

describe("regression: object-object merge with mismatched sub-key types", () => {
  /**
   * Simulates the Medulloblastoma merge:
   *   Left "Embryonal tumors" → { Medulloblastoma: ["medulloblastoma", "SHH activated"] }
   *   Right "Embryonal tumours" → { Medulloblastoma: { "histologically defined": [...], "molecularly defined": [...] } }
   *
   * Tests that the object-object merge converts the left array to an object
   * and adds the right's object keys, preserving all children.
   */
  function simulateEmbryonalMerge() {
    const nodeIdMap = new Map<string, string>();
    const prov = new Map<string, ProvenanceEntry>();

    // ── Step 1: Left "Embryonal tumors" in merged ──
    const leftEmbryonal = {
      Medulloblastoma: ["medulloblastoma", "SHH activated"],
      "Other embryonal tumors": ["ATRT", "CNS neuroblastoma"],
    };

    assignNodeIds(
      { "CNS tumor": { "Embryonal tumors": leftEmbryonal } },
      "",
      nodeIdMap,
    );
    recordProvenanceRecursive(
      prov,
      nodeIdMap,
      "CNS tumor",
      "CNS tumor",
      "left",
      { "Embryonal tumors": leftEmbryonal },
    );

    // Verify left setup
    let sourceMap = buildSourceMap(nodeIdMap, prov);
    expect(sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma")).toBe("left");
    expect(sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma/0")).toBe("left");
    expect(sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma/1")).toBe("left");

    // ── Step 2: Right "Embryonal tumours" absorbed into CNS tumor ──
    const rightEmbryonal = {
      Medulloblastoma: {
        "Medulloblastomas, histologically defined": ["Classic medulloblastoma"],
        "Medulloblastomas, molecularly defined": [
          "Medulloblastoma, WNT-activated",
          "Medulloblastoma, SHH-activated",
        ],
      },
      "Other CNS embryonal tumours": ["ATRT", "Cribriform neuroepithelial tumour"],
    };

    // After section merge, "Embryonal tumours" is a new key in CNS tumor
    assignNodeIds(
      { "CNS tumor": { "Embryonal tumours": rightEmbryonal } },
      "",
      nodeIdMap,
    );
    recordProvenanceRecursive(
      prov,
      nodeIdMap,
      "CNS tumor/Embryonal tumours",
      "Central Nervous System Tumours/Embryonal tumours",
      "right",
      rightEmbryonal,
    );

    // ── Step 3: Sibling merge "Embryonal tumours" onto "Embryonal tumors" ──
    // This is a merged-to-merged object-object merge

    // 3a. Capture dragged provenance
    const draggedPath = "CNS tumor/Embryonal tumours";
    const draggedLineage = getLineageForPath(draggedPath, nodeIdMap, prov);
    const draggedChildLineageMap = new Map<string, ProvenanceEntry>();
    const childPrefix = draggedPath + "/";
    for (const [path, nid] of nodeIdMap) {
      if (path.startsWith(childPrefix)) {
        const entry = prov.get(nid);
        if (entry && entry.sources.length > 0) {
          draggedChildLineageMap.set(path.slice(draggedPath.length), {
            sources: entry.sources.map((s) => ({ ...s })),
          });
        }
      }
    }

    // 3b. Remove dragged
    removeProvenanceForSubtree(prov, nodeIdMap, draggedPath);
    for (const [path] of [...nodeIdMap.entries()]) {
      if (path === draggedPath || path.startsWith(childPrefix)) {
        nodeIdMap.delete(path);
      }
    }

    // 3c. Object-object merge with type mismatch handling (the fix)
    const targetPath = "CNS tumor/Embryonal tumors";
    // Simulate what the fixed code does:
    // Left's "Embryonal tumors" is an object, right's "Embryonal tumours" is an object
    // Matching key "Medulloblastoma": left=array, right=object → convert array to object, merge
    const mergedEmbryonal: Record<string, unknown> = {
      // Start with left's structure
      Medulloblastoma: ["medulloblastoma", "SHH activated"],
      "Other embryonal tumors": ["ATRT", "CNS neuroblastoma"],
    };

    for (const [k, v] of Object.entries(rightEmbryonal)) {
      if (!(k in mergedEmbryonal)) {
        mergedEmbryonal[k] = v;
      } else {
        const targetSub = mergedEmbryonal[k];
        if (Array.isArray(targetSub) && typeof v === "object" && v !== null && !Array.isArray(v)) {
          // Array→Object conversion (the fix!)
          const converted: Record<string, unknown> = {};
          for (const item of targetSub) {
            converted[String(item)] = null;
          }
          for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) {
            if (!(dk in converted)) {
              converted[dk] = dv;
            }
          }
          mergedEmbryonal[k] = converted;

          // Remap nodeIdMap for converted array items
          const subPath = `${targetPath}/${k}`;
          for (let i = 0; i < targetSub.length; i++) {
            const oldPrefix = `${subPath}/${i}`;
            const newPrefix = `${subPath}/${String(targetSub[i])}`;
            // Manual remap
            const remapped = new Map<string, string>();
            for (const [p, id] of nodeIdMap) {
              if (p === oldPrefix) {
                remapped.set(newPrefix, id);
              } else if (p.startsWith(oldPrefix + "/")) {
                remapped.set(newPrefix + p.slice(oldPrefix.length), id);
              } else {
                remapped.set(p, id);
              }
            }
            // Replace nodeIdMap contents
            nodeIdMap.clear();
            for (const [p, id] of remapped) {
              nodeIdMap.set(p, id);
            }
          }
        } else if (Array.isArray(targetSub) && Array.isArray(v)) {
          for (const item of v as unknown[]) {
            if (!targetSub.some((ex: unknown) => String(ex) === String(item))) {
              targetSub.push(item);
            }
          }
        }
      }
    }

    // Assign IDs for all new paths
    assignNodeIds({ "CNS tumor": { "Embryonal tumors": mergedEmbryonal } }, "", nodeIdMap);

    // 3d. Transfer parent provenance
    const targetId = nodeIdMap.get(targetPath)!;
    markProvenanceAsMerged(prov, targetId);
    if (draggedLineage) {
      for (const s of draggedLineage.sources) {
        addProvenanceSource(prov, targetId, {
          panel: s.panel,
          originalPath: s.originalPath,
          action: "merged",
        });
      }
    }

    // 3e. Transfer child provenance
    for (const [suffix, entry] of draggedChildLineageMap) {
      const childTargetPath = targetPath + suffix;
      if (!nodeIdMap.has(childTargetPath)) {
        nodeIdMap.set(childTargetPath, generateNodeId());
      }
      const childId = nodeIdMap.get(childTargetPath)!;
      for (const s of entry.sources) {
        addProvenanceSource(prov, childId, {
          panel: s.panel,
          originalPath: s.originalPath,
          action: s.action,
        });
      }
    }

    return { nodeIdMap, prov, mergedEmbryonal };
  }

  it("WHO Medulloblastoma children are preserved after array→object conversion", () => {
    const { mergedEmbryonal } = simulateEmbryonalMerge();

    const medullo = mergedEmbryonal["Medulloblastoma"] as Record<string, unknown>;
    expect(typeof medullo).toBe("object");
    expect(Array.isArray(medullo)).toBe(false);

    // Left's original leaf items should be converted to object keys
    expect("medulloblastoma" in medullo).toBe(true);
    expect("SHH activated" in medullo).toBe(true);

    // Right's sub-sections should be present
    expect("Medulloblastomas, histologically defined" in medullo).toBe(true);
    expect("Medulloblastomas, molecularly defined" in medullo).toBe(true);

    // Right's sub-section children should be intact
    const histDefined = medullo["Medulloblastomas, histologically defined"];
    expect(Array.isArray(histDefined)).toBe(true);
    expect(histDefined).toContain("Classic medulloblastoma");

    const molDefined = medullo["Medulloblastomas, molecularly defined"];
    expect(Array.isArray(molDefined)).toBe(true);
    expect(molDefined).toContain("Medulloblastoma, WNT-activated");
    expect(molDefined).toContain("Medulloblastoma, SHH-activated");
  });

  it("left items retain left provenance after array→object conversion", () => {
    const { nodeIdMap, prov } = simulateEmbryonalMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    // Original left leaf items (now object keys) should still be "left"
    expect(sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma/medulloblastoma")).toBe("left");
    expect(sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma/SHH activated")).toBe("left");
  });

  it("right sub-sections have right provenance", () => {
    const { nodeIdMap, prov } = simulateEmbryonalMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    expect(
      sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma/Medulloblastomas, histologically defined"),
    ).toBe("right");
    expect(
      sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma/Medulloblastomas, molecularly defined"),
    ).toBe("right");
  });

  it("right leaf items under sub-sections have right provenance", () => {
    const { nodeIdMap, prov } = simulateEmbryonalMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    expect(
      sourceMap.get(
        "CNS tumor/Embryonal tumors/Medulloblastoma/Medulloblastomas, histologically defined/0",
      ),
    ).toBe("right");
    expect(
      sourceMap.get(
        "CNS tumor/Embryonal tumors/Medulloblastoma/Medulloblastomas, molecularly defined/0",
      ),
    ).toBe("right");
    expect(
      sourceMap.get(
        "CNS tumor/Embryonal tumors/Medulloblastoma/Medulloblastomas, molecularly defined/1",
      ),
    ).toBe("right");
  });

  it("merged parent section Medulloblastoma is purple (both sources)", () => {
    const { nodeIdMap, prov } = simulateEmbryonalMerge();
    const sourceMap = buildSourceMap(nodeIdMap, prov);

    // Medulloblastoma has provenance from both left (original) and right (transferred)
    expect(sourceMap.get("CNS tumor/Embryonal tumors/Medulloblastoma")).toBe("both");
  });

  it("non-matching keys are added without loss", () => {
    const { mergedEmbryonal } = simulateEmbryonalMerge();

    // Left-only key should still be there
    expect("Other embryonal tumors" in mergedEmbryonal).toBe(true);
    expect(Array.isArray(mergedEmbryonal["Other embryonal tumors"])).toBe(true);

    // Right-only key should be added
    expect("Other CNS embryonal tumours" in mergedEmbryonal).toBe(true);
    expect(Array.isArray(mergedEmbryonal["Other CNS embryonal tumours"])).toBe(true);
  });

  it("no children are left without provenance", () => {
    const { nodeIdMap, prov } = simulateEmbryonalMerge();

    // Every path under Medulloblastoma should have provenance
    const medulloPaths = [...nodeIdMap.keys()].filter((p) =>
      p.startsWith("CNS tumor/Embryonal tumors/Medulloblastoma"),
    );
    expect(medulloPaths.length).toBeGreaterThan(0);

    for (const path of medulloPaths) {
      const entry = getLineageForPath(path, nodeIdMap, prov);
      expect(
        entry,
        `path "${path}" should have provenance`,
      ).toBeDefined();
      expect(entry!.sources.length).toBeGreaterThan(0);
    }
  });
});
