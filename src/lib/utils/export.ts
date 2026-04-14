/**
 * Export utilities for ontology merge data.
 * Handles file download and basic export formatting.
 */

import type { OntologyTree, LineageEntry, ConceptMeta, UnifiedMergeFileV4 } from '$lib/types';

/**
 * Trigger a file download in the browser.
 */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string = 'application/json'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export data as JSON with pretty formatting
 */
export function exportJson(data: unknown, filename: string): void {
  const jsonStr = JSON.stringify(data, null, 2);
  downloadFile(jsonStr, filename, 'application/json');
}

/**
 * Export data as YAML
 */
export function exportYaml(data: unknown, filename: string): void {
  // Dynamic import to avoid issues with SSR
  import('js-yaml').then((yaml) => {
    const yamlStr = yaml.dump(data, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    downloadFile(yamlStr, filename, 'application/x-yaml');
  });
}

/**
 * Create a basic v4 export structure (without full conversion logic)
 * This is a helper for the more complex exportWithLineage function
 */
export function createV4ExportStructure(params: {
  concepts: Record<string, ConceptMeta>;
  structure: Record<string, unknown>;
  lineage: Record<string, { sources: Array<{ source: string; originalPath: string; action: string }> }>;
  metadata?: {
    source?: 'llm' | 'webapp' | 'manual';
    llmModel?: string;
    sessionId?: string;
    notes?: string;
  };
}): UnifiedMergeFileV4 {
  return {
    version: 4,
    format: 'id-keyed-with-metadata',
    metadata: {
      source: params.metadata?.source ?? 'webapp',
      llmModel: params.metadata?.llmModel,
      sessionId: params.metadata?.sessionId ?? crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      notes: params.metadata?.notes ?? 'Created in webapp',
    },
    sourceOntologies: {
      pathout: { name: 'PathologyOutlines', conceptCount: 0, v4Path: '' },
      who: { name: 'WHO Classification of Tumours', conceptCount: 0, v4Path: '' },
    },
    concepts: params.concepts,
    structure: params.structure as UnifiedMergeFileV4['structure'],
    lineage: params.lineage as unknown as UnifiedMergeFileV4['lineage'],
    mergeHistory: [],
  };
}

/**
 * Convert a Map to a plain object for serialization
 */
export function mapToObject<V>(
  map: Map<string, V>
): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }
  return obj;
}

/**
 * Convert an object to a Map
 */
export function objectToMap<V>(
  obj: Record<string, V>
): Map<string, V> {
  return new Map(Object.entries(obj));
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}