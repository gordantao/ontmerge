import type { PageLoad } from './$types';

export const ssr = false;
export const prerender = true;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConceptMeta {
  name: string;
  synonyms: string[];
  icd_codes: (string | [string, string])[];
  primary_reference: string | null;
  related_concepts: string[];
  source: string;
  createdBy?: string;
  mergedFrom?: string[];
}

interface V4StructureNode {
  children: Record<string, V4StructureNode> | string[];
}

interface V4OntologyFile {
  version: 4;
  format: string;
  concepts: Record<string, ConceptMeta>;
  structure: Record<string, V4StructureNode>;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function v4StructureToNameTree(
  structure: Record<string, V4StructureNode>,
  concepts: Record<string, ConceptMeta>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
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

// ─── Load ─────────────────────────────────────────────────────────────────────

export const load: PageLoad = async ({ fetch }) => {
  const [leftV4, rightV4] = await Promise.all([
    fetch('/data/pathout_v4.json').then((r) => r.json() as Promise<V4OntologyFile>),
    fetch('/data/who_v4.json').then((r) => r.json() as Promise<V4OntologyFile>),
  ]);

  const left = v4StructureToNameTree(leftV4.structure, leftV4.concepts);
  const right = v4StructureToNameTree(rightV4.structure, rightV4.concepts);

  return {
    left,
    right,
    leftRegistry: leftV4.concepts,
    rightRegistry: rightV4.concepts,
  };
};
