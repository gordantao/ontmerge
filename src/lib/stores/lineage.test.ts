import { describe, it, expect, beforeEach } from 'vitest';

// Simple test for LineageStore - since Svelte 5 runes don't work outside of Svelte context,
// we test the core logic patterns

describe('LineageStore Logic', () => {
	// Simulate the store's add logic
	function addLineage(
		entries: Map<string, { sources: Array<{ panel: string; originalPath: string; action: string }> }>,
		mergedPath: string,
		panel: string,
		originalPath: string,
		action: string = 'added'
	) {
		const newEntries = new Map(entries);
		const existing = newEntries.get(mergedPath);

		if (existing) {
			const alreadyHasSource = existing.sources.some(
				(s) => s.panel === panel && s.originalPath === originalPath
			);
			if (!alreadyHasSource) {
				newEntries.set(mergedPath, {
					sources: [...existing.sources, { panel, originalPath, action }],
				});
			}
		} else {
			newEntries.set(mergedPath, {
				sources: [{ panel, originalPath, action }],
			});
		}

		return newEntries;
	}

	// Simulate updatePath logic
	function updatePath(
		entries: Map<string, { sources: { panel: string; originalPath: string; action: string }[] }>,
		oldPath: string,
		newPath: string
	) {
		const newEntries = new Map(entries);

		for (const [path, entry] of entries) {
			if (path === oldPath) {
				newEntries.set(newPath, { sources: [...entry.sources] });
			} else if (path.startsWith(oldPath + '/')) {
				const suffix = path.slice(oldPath.length);
				newEntries.set(newPath + suffix, { sources: [...entry.sources] });
			}
		}

		return newEntries;
	}

	// Simulate remove logic
	function removeLineage(
		entries: Map<string, { sources: { panel: string; originalPath: string; action: string }[] }>,
		path: string
	) {
		const newEntries = new Map(entries);

		for (const key of newEntries.keys()) {
			if (key === path || key.startsWith(path + '/')) {
				newEntries.delete(key);
			}
		}

		return newEntries;
	}

	let entries: Map<string, { sources: { panel: string; originalPath: string; action: string }[] }>;

	beforeEach(() => {
		entries = new Map();
	});

	describe('addLineage', () => {
		it('should add a new lineage entry', () => {
			const result = addLineage(entries, 'path/to/item', 'left', 'original/path');

			expect(result.get('path/to/item')?.sources.length).toBe(1);
			expect(result.get('path/to/item')?.sources[0].panel).toBe('left');
			expect(result.get('path/to/item')?.sources[0].originalPath).toBe('original/path');
		});

		it('should not add duplicate sources', () => {
			entries = addLineage(entries, 'item1', 'left', 'path1');
			const result = addLineage(entries, 'item1', 'left', 'path1');

			expect(result.get('item1')?.sources.length).toBe(1);
		});

		it('should add multiple sources for same path', () => {
			entries = addLineage(entries, 'merged/item', 'left', 'left/path');
			const result = addLineage(entries, 'merged/item', 'right', 'right/path');

			expect(result.get('merged/item')?.sources.length).toBe(2);
		});
	});

	describe('updatePath', () => {
		it('should add new path with entry', () => {
			entries = addLineage(entries, 'old/path', 'left', 'original');
			const result = updatePath(entries, 'old/path', 'new/path');

			expect(result.get('new/path')).toBeDefined();
		});

		it('should update child paths with new prefix', () => {
			entries = addLineage(entries, 'parent/child1', 'left', 'orig1');
			entries = addLineage(entries, 'parent/child2', 'left', 'orig2');
			const result = updatePath(entries, 'parent', 'newparent');

			expect(result.get('newparent/child1')).toBeDefined();
			expect(result.get('newparent/child2')).toBeDefined();
		});
	});

	describe('removeLineage', () => {
		it('should remove exact path match', () => {
			entries = addLineage(entries, 'path/to/item', 'left', 'original');
			const result = removeLineage(entries, 'path/to/item');

			expect(result.get('path/to/item')).toBeUndefined();
		});

		it('should remove path and all children', () => {
			entries = addLineage(entries, 'parent', 'left', 'orig');
			entries = addLineage(entries, 'parent/child1', 'left', 'orig1');
			entries = addLineage(entries, 'parent/child2', 'left', 'orig2');
			const result = removeLineage(entries, 'parent');

			expect(result.get('parent')).toBeUndefined();
			expect(result.get('parent/child1')).toBeUndefined();
			expect(result.get('parent/child2')).toBeUndefined();
		});

		it('should keep unrelated paths', () => {
			entries = addLineage(entries, 'keep/this', 'left', 'orig1');
			entries = addLineage(entries, 'remove/this', 'left', 'orig2');
			const result = removeLineage(entries, 'remove');

			expect(result.get('keep/this')).toBeDefined();
			expect(result.get('remove/this')).toBeUndefined();
		});
	});

	describe('hasBothSources', () => {
		it('should return true when both left and right sources exist', () => {
			entries = addLineage(entries, 'merged/item', 'left', 'left/path');
			entries = addLineage(entries, 'merged/item', 'right', 'right/path');

			const entry = entries.get('merged/item');
			const panels = new Set(entry?.sources.map((s) => s.panel));

			expect(panels.has('left')).toBe(true);
			expect(panels.has('right')).toBe(true);
		});

		it('should return false when only one source exists', () => {
			entries = addLineage(entries, 'item', 'left', 'path');

			const entry = entries.get('item');
			const panels = new Set(entry?.sources.map((s) => s.panel));

			expect(panels.has('left')).toBe(true);
			expect(panels.has('right')).toBe(false);
		});
	});

	// Simulate reindexAfterDelete logic - the fixed version
	function reindexAfterDelete(
		entries: Map<string, { sources: { panel: string; originalPath: string; action: string }[] }>,
		parentPath: string,
		deletedIndex: number
	) {
		const parentPrefix = parentPath ? parentPath + "/" : "";
		const newEntries = new Map(entries);

		for (const [path, entry] of entries) {
			if (path.startsWith(parentPrefix)) {
				const rest = path.slice(parentPrefix.length);
				const slashIndex = rest.indexOf("/");
				const indexPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
				const itemIndex = parseInt(indexPart, 10);

				if (!isNaN(itemIndex) && itemIndex > deletedIndex) {
					// FIXED: Delete old key before shifting
					newEntries.delete(path);
					const newIndex = itemIndex - 1;
					const newKey =
						parentPrefix +
						newIndex +
						(slashIndex === -1 ? "" : rest.slice(slashIndex));
					newEntries.set(newKey, { sources: [...entry.sources] });
				}
			}
		}

		return newEntries;
	}

	// OLD broken version (for comparison)
	function reindexAfterDeleteBroken(
		entries: Map<string, { sources: { panel: string; originalPath: string; action: string }[] }>,
		parentPath: string,
		deletedIndex: number
	) {
		const parentPrefix = parentPath ? parentPath + "/" : "";
		const newEntries = new Map(entries);

		for (const [path, entry] of entries) {
			if (path.startsWith(parentPrefix)) {
				const rest = path.slice(parentPrefix.length);
				const slashIndex = rest.indexOf("/");
				const indexPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
				const itemIndex = parseInt(indexPart, 10);

				if (!isNaN(itemIndex) && itemIndex > deletedIndex) {
					// BUG: Does NOT delete old key - creates stale entries
					const newIndex = itemIndex - 1;
					const newKey =
						parentPrefix +
						newIndex +
						(slashIndex === -1 ? "" : rest.slice(slashIndex));
					newEntries.set(newKey, { sources: [...entry.sources] });
				}
			}
		}

		return newEntries;
	}

	describe('reindexAfterDelete', () => {
		it('should shift down indices after deleted index', () => {
			// Setup: Section with items at indices 0, 1, 2
			entries = addLineage(entries, 'Section/0', 'left', 'path0');
			entries = addLineage(entries, 'Section/1', 'right', 'path1');
			entries = addLineage(entries, 'Section/2', 'left', 'path2');

			// Delete index 1 (middle item)
			const result = reindexAfterDelete(entries, 'Section', 1);

			// Item at 0 should stay at 0
			expect(result.get('Section/0')?.sources[0].panel).toBe('left');
			// Item at 2 should shift to 1
			expect(result.get('Section/1')?.sources[0].originalPath).toBe('path2');
			// Old index 2 should NOT exist (fixed version deletes old keys)
			expect(result.get('Section/2')).toBeUndefined();
		});

		it('should not leave stale keys after reindex (FIXED version)', () => {
			entries = addLineage(entries, 'Section/0', 'left', 'path0');
			entries = addLineage(entries, 'Section/1', 'right', 'path1');
			entries = addLineage(entries, 'Section/2', 'left', 'path2');

			const result = reindexAfterDelete(entries, 'Section', 1);

			// After fixing: should only have 2 entries (0 and 1)
			const allPaths = Array.from(result.keys()).filter(p => p.startsWith('Section/'));
			expect(allPaths).toEqual(['Section/0', 'Section/1']);
		});

		it('OLD BUG: would leave stale keys (broken version)', () => {
			entries = addLineage(entries, 'Section/0', 'left', 'path0');
			entries = addLineage(entries, 'Section/1', 'right', 'path1');
			entries = addLineage(entries, 'Section/2', 'left', 'path2');

			const result = reindexAfterDeleteBroken(entries, 'Section', 1);

			// BUG: would have 3 entries (0, 1, AND stale 2)
			const allPaths = Array.from(result.keys()).filter(p => p.startsWith('Section/'));
			expect(allPaths).toEqual(['Section/0', 'Section/1', 'Section/2']);
		});

		it('should handle simple 2-item case correctly', () => {
			// This is the exact scenario from the bug report:
			// - A at Section/0 (from left)
			// - B at Section/1 (from right)
			// When merging B onto A:
			// 1. First removeLineage("Section/1") removes B's lineage
			// 2. Then reindexAfterDelete("Section", 1) reindexes items > 1 (none)
			entries = addLineage(entries, 'Section/0', 'left', 'pathToA');
			entries = addLineage(entries, 'Section/1', 'right', 'pathToB');

			// First, removeLineage is called on the dragged item's path
			let result = removeLineage(entries, 'Section/1');

			// Then reindex is called (but no items have index > 1)
			result = reindexAfterDelete(result, 'Section', 1);

			// Only Section/0 should remain (with A's lineage)
			expect(result.get('Section/0')?.sources[0].panel).toBe('left');
			// Section/1 should be gone (removed by removeLineage)
			expect(result.get('Section/1')).toBeUndefined();
		});

		it('should handle root-level items (no parent path)', () => {
			entries = addLineage(entries, '0', 'left', 'path0');
			entries = addLineage(entries, '1', 'right', 'path1');

			const result = reindexAfterDelete(entries, '', 0);

			// Item at index 1 should shift to 0
			expect(result.get('0')?.sources[0].panel).toBe('right');
			expect(result.get('1')).toBeUndefined();
		});
	});
});
