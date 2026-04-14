// ============================================
// Core Ontology Types
// ============================================

/** Metadata for a single concept from either source ontology or the merged result. */
export interface ConceptMeta {
  name: string;
  synonyms: string[];
  /** ICD codes – PathOut uses plain strings, WHO uses [type, code] tuples. */
  icd_codes: (string | [string, string])[];
  primary_reference: string | null;
  related_concepts: string[];
  /** "pathout" | "who" | "merged" */
  source: string;
  createdBy?: string;
  mergedFrom?: string[];
}

/** A node in the v4 id-keyed structure tree. */
export interface V4StructureNode {
  children: Record<string, V4StructureNode> | string[];
}

/** A v4 ontology file (single-source, produced by convert_to_v4.py). */
export interface V4OntologyFile {
  version: 4;
  format: "id-keyed-with-metadata";
  metadata: {
    source: string;
    name: string;
    conceptCount: number;
    generatedAt: string;
  };
  concepts: Record<string, ConceptMeta>;
  structure: Record<string, V4StructureNode>;
}

// ============================================
// Tree Data Types
// ============================================

/** Tree node that can be a leaf (array of names) or branch (object) */
export type OntologyTree = Record<string, unknown>;

/** A single node in the ontology tree structure - leaf array or nested object */
export type OntologyNode = string[] | Record<string, unknown>;

// ============================================
// Lineage Types
// ============================================

/** Source of a lineage entry */
export type LineagePanel = "left" | "right" | "user" | "llm";

/** Action that created the lineage entry */
export type LineageAction =
  | "added"
  | "merged"
  | "header-merged"
  | "created"
  | "llm-suggested"
  | "llm-auto-merged";

/** Single source reference in a lineage entry */
export interface LineageSource {
  panel: LineagePanel;
  originalPath: string;
  action: LineageAction;
}

/** Complete lineage entry for a merged path */
export interface LineageEntry {
  sources: LineageSource[];
}

// ============================================
// History / Undo-Redo Types
// ============================================

/** Information about a subscriber to a source concept */
export interface SubscriberInfo {
  sourceId: string;
  source: "left" | "right";
  isMerged: boolean;
}

/** Complete snapshot of application state for undo/redo */
export interface HistorySnapshot {
  mergedData: OntologyTree;
  sourceMap: Map<string, string>;
  lineage: Map<string, LineageEntry>;
  subscriptions: Map<string, Set<string>>;
  subscriberInfo: Map<string, SubscriberInfo[]>;
  mergedPathToId: Map<string, string>;
}

// ============================================
// Merge File Types (v1, v2, v4)
// ============================================

/** Metadata for a merge session */
export interface MergeMetadata {
  source: "llm" | "webapp" | "manual";
  llmModel?: string;
  sessionId?: string;
  notes?: string;
  createdAt?: string;
}

/** Reference to source ontology */
export interface OntologyRef {
  name: string;
  path: string;
}

/** LLM suggestion for a merge decision */
export interface MergeDecision {
  mergedTo: string;
  mergedFrom: string[];
  matchType: string;
  similarity?: number;
  accepted?: boolean | null;
}

/** LLM suggestions container */
export interface LLMSuggestions {
  conceptMappings?: Record<string, string>;
  mergeDecisions?: MergeDecision[];
  explanation?: string;
}

/** Item pending human review */
export interface PendingReviewItem {
  path: string;
  reason: string;
  confidence?: number;
  alternatives?: string[];
}

/** Legacy v1 merge file format */
export interface UnifiedMergeFileV1 {
  version: 1;
  data: OntologyTree;
  lineage: Record<string, LineageEntry>;
  sourceMap: Record<string, string>;
}

/** Legacy v2 merge file format */
export interface UnifiedMergeFileV2 {
  version: 2;
  metadata: MergeMetadata;
  ontologies: {
    left: OntologyRef;
    right: OntologyRef;
  };
  mergedData: unknown;
  lineage?: Record<string, unknown>;
  sourceMap?: Record<string, string>;
  llmSuggestions?: LLMSuggestions;
  pendingReview?: PendingReviewItem[];
  editHistory?: unknown[];
}

/** v4 merge file format (id-keyed with metadata) */
export interface UnifiedMergeFileV4 {
  version: 4;
  format: "id-keyed-with-metadata";
  metadata: MergeMetadata;
  sourceOntologies: {
    pathout: { name: string; conceptCount: number; v4Path: string };
    who: { name: string; conceptCount: number; v4Path: string };
  };
  concepts: Record<string, ConceptMeta>;
  structure: Record<string, V4StructureNode>;
  lineage: Record<string, { sources: LineageSource[] }>;
  mergeHistory: unknown[];
  llmSuggestions?: LLMSuggestions;
  pendingReview?: PendingReviewItem[];
}

/** Union type for all merge file versions */
export type UnifiedMergeFile = UnifiedMergeFileV1 | UnifiedMergeFileV2 | UnifiedMergeFileV4;

// ============================================
// Component Props Types
// ============================================

/** Drop handler function signature */
export interface DropHandler {
  (
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
  ): void;
}

/** Rename handler function signature */
export interface RenameHandler {
  (path: string[], oldName: string, newName: string, isArrayItem: boolean): void;
}

/** Delete handler function signature */
export interface DeleteHandler {
  (path: string[], isArrayItem: boolean): void;
}

/** Lineage hover handler function signature */
export interface LineageHoverHandler {
  (path: string[], isHovering: boolean): void;
}
