/**
 * Data manipulation utilities for the ontology merge application.
 */

import type { OntologyTree, ConceptMeta, V4StructureNode, LineageEntry } from '$lib/types';

/**
 * Initialize path-to-ID mappings for a data tree.
 * Recursively walks the tree and assigns unique IDs to each path.
 */
export function initializePathIds(
  obj: OntologyTree,
  basePath: string,
  pathToId: Map<string, string>,
): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      const path = basePath ? `${basePath}/${idx}` : String(idx);
      if (typeof item === 'object' && item !== null) {
        initializePathIds(item as OntologyTree, path, pathToId);
      }
    });
  } else {
    for (const [key, value] of Object.entries(obj)) {
      const path = basePath ? `${basePath}/${key}` : key;
      if (typeof value === 'object' && value !== null) {
        initializePathIds(value as OntologyTree, path, pathToId);
      }
    }
  }
}

/**
 * Remove an item from the data tree at the specified path.
 */
export function removeFromData(obj: OntologyTree, path: string[]): boolean {
  if (path.length === 0) return false;

  if (path.length === 1) {
    const key = path[0];
    if (Array.isArray(obj)) {
      const idx = parseInt(key, 10);
      if (!isNaN(idx) && idx >= 0 && idx < obj.length) {
        obj.splice(idx, 1);
        return true;
      }
    } else if (key in obj) {
      delete obj[key];
      return true;
    }
    return false;
  }

  const [head, ...tail] = path;
  const nextObj = Array.isArray(obj)
    ? obj[parseInt(head, 10)]
    : obj[head];

  if (typeof nextObj === 'object' && nextObj !== null) {
    return removeFromData(nextObj as OntologyTree, tail);
  }

  return false;
}

/**
 * Build a name → source-panel-path map from path-to-ID map.
 */
export function buildNameToSourcePath(
  pathToId: Map<string, string>,
): Map<string, string> {
  const nameToPath = new Map<string, string>();

  for (const [path, id] of pathToId) {
    const segments = path.split('/');
    const name = segments[segments.length - 1];
    if (!nameToPath.has(name)) {
      nameToPath.set(name, path);
    }
  }

  return nameToPath;
}

/**
 * Convert v4 id-keyed structure → name-keyed tree.
 */
export function v4StructureToNameTree(
  structure: Record<string, V4StructureNode>,
  concepts: Record<string, ConceptMeta>,
): OntologyTree {
  const result: OntologyTree = {};

  for (const [id, node] of Object.entries(structure)) {
    const name = concepts[id]?.name ?? id;
    const children = node.children;

    if (Array.isArray(children)) {
      result[name] = children.map((cid) => concepts[cid]?.name ?? cid);
    } else if (children && Object.keys(children).length > 0) {
      result[name] = v4StructureToNameTree(
        children as Record<string, V4StructureNode>,
        concepts,
      );
    } else {
      result[name] = {};
    }
  }

  return result;
}

/**
 * Build ID → name-path map from v4 structure and concepts.
 */
export function buildV4IdToNamePath(
  structure: Record<string, V4StructureNode>,
  concepts: Record<string, ConceptMeta>,
): Map<string, string> {
  const idToNamePath = new Map<string, string>();

  function walk(
    nodes: Record<string, V4StructureNode>,
    basePath: string,
  ): void {
    for (const [id, node] of Object.entries(nodes)) {
      const name = concepts[id]?.name ?? id;
      const path = basePath ? `${basePath}/${name}` : name;
      idToNamePath.set(id, path);

      if (!Array.isArray(node.children) && node.children) {
        walk(node.children as Record<string, V4StructureNode>, path);
      }
    }
  }

  walk(structure, '');
  return idToNamePath;
}

/**
 * Translate v4 ID-keyed lineage to name-keyed LineageEntry map.
 */
export function translateV4Lineage(
  v4lineage: Record<string, any>,
  idToNamePath: Map<string, string>,
  concepts: Record<string, ConceptMeta>,
  leftNameToPath: Map<string, string>,
  rightNameToPath: Map<string, string>,
): Map<string, LineageEntry> {
  const lineage = new Map<string, LineageEntry>();

  for (const [idPath, entry] of Object.entries(v4lineage)) {
    const namePath = idToNamePath.get(idPath);
    if (!namePath || !entry?.sources) continue;

    const translatedSources = entry.sources.map((s: any) => {
      let panel: 'left' | 'right' | 'user' | 'llm' = 'user';
      let originalPath = s.originalPath || '';

      if (s.source === 'pathout') {
        panel = 'left';
        const segments = originalPath.split('/');
        const lastName = segments[segments.length - 1];
        originalPath = leftNameToPath.get(lastName) || originalPath;
      } else if (s.source === 'who') {
        panel = 'right';
        const segments = originalPath.split('/');
        const lastName = segments[segments.length - 1];
        originalPath = rightNameToPath.get(lastName) || originalPath;
      } else if (s.source === 'merged') {
        panel = 'user';
      } else if (s.source === 'llm') {
        panel = 'llm';
      }

      return {
        panel,
        originalPath,
        action: s.action || 'added',
      };
    });

    lineage.set(namePath, { sources: translatedSources });
  }

  return lineage;
}

/**
 * Find matching source ID for a given path using the path-to-ID map.
 */
export function findMatchingPath(
  targetPath: string,
  pathToId: Map<string, string>,
): string | undefined {
  // Try exact match
  if (pathToId.has(targetPath)) {
    return pathToId.get(targetPath);
  }

  // Try parent path
  const segments = targetPath.split('/');
  while (segments.length > 1) {
    segments.pop();
    const parentPath = segments.join('/');
    if (pathToId.has(parentPath)) {
      return pathToId.get(parentPath);
    }
  }

  return undefined;
}
