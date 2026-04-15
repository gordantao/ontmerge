/**
 * Search utilities for matching terms in source panel trees.
 * Kept modular so the matching strategy can be swapped later.
 */

export type MatchFn = (query: string, target: string) => boolean;

/** Case-insensitive substring match. */
export const substringMatch: MatchFn = (query, target) =>
  target.toLowerCase().includes(query.toLowerCase());

/** Simple fuzzy match — all query characters appear in order in target. */
export const fuzzyMatch: MatchFn = (query, target) => {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
};

/** Default matcher used throughout the app. */
export const defaultMatch: MatchFn = substringMatch;

export interface SearchResult {
  /** The path key (segments joined by "/") of the matching node. */
  path: string;
}

/**
 * Walk an ontology tree object and return all paths whose key matches `query`.
 * Includes ancestor paths so the tree can be auto-expanded to show matches.
 */
export function searchTree(
  obj: unknown,
  query: string,
  match: MatchFn = defaultMatch,
  basePath: string[] = [],
): { matchPaths: Set<string>; ancestorPaths: Set<string> } {
  const matchPaths = new Set<string>();
  const ancestorPaths = new Set<string>();

  if (!query) return { matchPaths, ancestorPaths };

  function walk(node: unknown, path: string[]) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const currentPath = [...path, key];
        const pathKey = currentPath.join("/");

        if (match(query, key)) {
          matchPaths.add(pathKey);
          // Mark all ancestors for expansion
          for (let i = 1; i < currentPath.length; i++) {
            ancestorPaths.add(currentPath.slice(0, i).join("/"));
          }
        }

        walk(value, currentPath);
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, idx) => {
        const currentPath = [...path, String(idx)];
        const pathKey = currentPath.join("/");

        if (typeof item === "string" && match(query, item)) {
          matchPaths.add(pathKey);
          for (let i = 1; i < currentPath.length; i++) {
            ancestorPaths.add(currentPath.slice(0, i).join("/"));
          }
        }

        walk(item, currentPath);
      });
    }
  }

  walk(obj, basePath);
  return { matchPaths, ancestorPaths };
}