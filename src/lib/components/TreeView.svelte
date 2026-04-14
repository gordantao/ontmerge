<script lang="ts">
  /**
   * Escape HTML special characters to prevent XSS attacks
   */
  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  type FlatItem = {
    id: string;
    key: string;
    value: unknown;
    depth: number;
    path: string[];
    isExpandable: boolean;
    isExpanded: boolean;
    hasChildren: boolean;
    childCount: number;
    isArrayItem: boolean;
  };

  let {
    data,
    name = null,
    panelId = "",
    onDrop = () => {},
    onRename = () => {},
    onDelete = null,
    onCreateSection = null,
    sourceMap = null,
    usageMap = null,
    onLineageHover = null,
    highlightedPath = null,
    sortByStatus = false,
  }: {
    data: unknown;
    name?: string | null;
    panelId?: string;
    onDrop?: (
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
    ) => void;
    onRename?: (
      path: string[],
      oldName: string,
      newName: string,
      isArrayItem: boolean,
    ) => void;
    onDelete?: ((path: string[], isArrayItem: boolean) => void) | null;
    onCreateSection?: ((name: string) => void) | null;
    sourceMap?: Map<string, string> | null;
    usageMap?: Map<string, string> | null;
    onLineageHover?: ((path: string[], isHovering: boolean) => void) | null;
    highlightedPath?: string | null;
    sortByStatus?: boolean;
  } = $props();

  let hoveredId: string | null = $state(null);

  function handleDelete(item: FlatItem) {
    if (onDelete) {
      onDelete(item.path, item.isArrayItem);
    }
  }

  function getSourceColor(itemPath: string[]): string {
    if (!sourceMap) return "";
    const pathKey = itemPath.join("/");
    const source = sourceMap.get(pathKey);
    if (source === "left") return "text-red-600 dark:text-red-400";
    if (source === "right") return "text-blue-600 dark:text-blue-400";
    if (source === "both") return "text-purple-600 dark:text-purple-400";
    if (source === "created") return "text-black dark:text-white";
    return "";
  }

  // Get usage-based styling for source panels (left/right)
  // "unused" = italic (not in merged panel)
  // "added" = normal (in merged but not combined)
  // "merged" = bold (combined with other source, purple in merged)
  function getUsageStyle(itemPath: string[]): string {
    if (!usageMap) return "";
    const pathKey = itemPath.join("/");
    const status = usageMap.get(pathKey);
    if (status === "merged") return "font-bold";
    if (status === "added") return "";
    // Default: unused = italic
    return "italic text-muted-foreground";
  }

  // Get sort priority for an item path: 0=merged, 1=added, 2=unused
  function getStatusPriority(pathKey: string): number {
    if (!usageMap) return 2;
    const status = usageMap.get(pathKey);
    if (status === "merged") return 0;
    if (status === "added") return 1;
    return 2;
  }

  // Compute best (lowest) status priority among an item and all its descendants
  function computeBestStatus(obj: unknown, basePath: string[]): number {
    const pathKey = basePath.join("/");
    let best = getStatusPriority(pathKey);
    if (best === 0) return 0;

    if (obj && typeof obj === "object") {
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          best = Math.min(best, computeBestStatus(obj[i], [...basePath, String(i)]));
          if (best === 0) return 0;
        }
      } else {
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          best = Math.min(best, computeBestStatus(value, [...basePath, key]));
          if (best === 0) return 0;
        }
      }
    }
    return best;
  }

  // Check if this item should be highlighted (lineage hover)
  function isHighlighted(itemPath: string[]): boolean {
    if (!highlightedPath) return false;
    const pathKey = itemPath.join("/");
    return (
      pathKey === highlightedPath || pathKey.startsWith(highlightedPath + "/")
    );
  }

  // Track if shift key is held
  let isShiftHeld = $state(false);

  function handleMouseEnterWithShift(e: MouseEvent, item: FlatItem) {
    hoveredId = item.id;
    if (e.shiftKey && onLineageHover) {
      onLineageHover(item.path, true);
    }
  }

  function handleMouseLeaveWithShift(item: FlatItem) {
    hoveredId = null;
    if (onLineageHover) {
      onLineageHover(item.path, false);
    }
  }

  let draggedOverId: string | null = $state(null);
  let dropPosition: "before" | "after" | "inside" | null = $state(null);
  let expandedIds = $state(new Set<string>());
  let editingId: string | null = $state(null);
  let editingValue: string = $state("");
  let isCreatingSection: boolean = $state(false);
  let newSectionName: string = $state("");

  // ============================================
  // AUTO-SCROLL DURING DRAG
  // ============================================
  let scrollContainer: HTMLElement | null = $state(null);
  let autoScrollAnimationId: number | null = null;
  const SCROLL_ZONE_SIZE = 60; // pixels from edge to trigger scroll
  const SCROLL_SPEED = 8; // pixels per frame

  function startAutoScroll(direction: "up" | "down") {
    if (autoScrollAnimationId !== null) return;

    function scrollStep() {
      if (!scrollContainer) return;

      const scrollAmount = direction === "up" ? -SCROLL_SPEED : SCROLL_SPEED;
      scrollContainer.scrollTop += scrollAmount;

      autoScrollAnimationId = requestAnimationFrame(scrollStep);
    }

    autoScrollAnimationId = requestAnimationFrame(scrollStep);
  }

  function stopAutoScroll() {
    if (autoScrollAnimationId !== null) {
      cancelAnimationFrame(autoScrollAnimationId);
      autoScrollAnimationId = null;
    }
  }

  function handleAutoScroll(e: DragEvent) {
    if (!scrollContainer) {
      // Find the scroll container (parent with overflow-auto)
      const el = e.currentTarget as HTMLElement;
      scrollContainer = el.closest('[class*="overflow-auto"]') as HTMLElement;
    }

    if (!scrollContainer) return;

    const rect = scrollContainer.getBoundingClientRect();
    const mouseY = e.clientY;

    const distanceFromTop = mouseY - rect.top;
    const distanceFromBottom = rect.bottom - mouseY;

    if (distanceFromTop < SCROLL_ZONE_SIZE && scrollContainer.scrollTop > 0) {
      startAutoScroll("up");
    } else if (
      distanceFromBottom < SCROLL_ZONE_SIZE &&
      scrollContainer.scrollTop <
        scrollContainer.scrollHeight - scrollContainer.clientHeight
    ) {
      startAutoScroll("down");
    } else {
      stopAutoScroll();
    }
  }

  // Helper to recursively find ALL expandable item IDs (ignoring current expansion state)
  function getAllExpandableIds(obj: unknown, path: string[] = []): string[] {
    const ids: string[] = [];

    if (isObject(obj)) {
      Object.entries(obj).forEach(([key, value]) => {
        const itemPath = [...path, key];
        const id = itemPath.join("/");
        const hasChildren =
          (isObject(value) && Object.keys(value).length > 0) ||
          (Array.isArray(value) && value.length > 0);

        if (hasChildren) {
          ids.push(id);
          ids.push(...getAllExpandableIds(value, itemPath));
        }
      });
    } else if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        const itemPath = [...path, String(idx)];
        const id = itemPath.join("/");
        const hasChildren =
          (isObject(item) && Object.keys(item).length > 0) ||
          (Array.isArray(item) && item.length > 0);

        if (hasChildren) {
          ids.push(id);
          ids.push(...getAllExpandableIds(item, itemPath));
        }
      });
    }

    return ids;
  }

  // Expose expand/collapse all functions
  export function expandAll() {
    const allExpandable = getAllExpandableIds(data);
    expandedIds = new Set(allExpandable);
  }

  export function collapseAll() {
    expandedIds = new Set();
  }

  // Scroll to and expand a specific path, then return a cleanup function
  export function scrollToPath(pathStr: string): (() => void) | null {
    const pathParts = pathStr.split("/");

    // First, expand all parent paths to make the item visible
    const newExpandedIds = new Set(expandedIds);
    for (let i = 1; i < pathParts.length; i++) {
      const parentPath = pathParts.slice(0, i).join("/");
      newExpandedIds.add(parentPath);
    }
    expandedIds = newExpandedIds;

    // Use requestAnimationFrame to wait for DOM update, then scroll
    requestAnimationFrame(() => {
      const element = document.querySelector(
        `[data-path-id="${panelId}/${pathStr}"]`,
      );
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });

    return null;
  }

  function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function flattenTree(
    obj: unknown,
    path: string[] = [],
    depth: number = 0,
  ): FlatItem[] {
    const items: FlatItem[] = [];

    if (isObject(obj)) {
      let entries = Object.entries(obj);
      if (sortByStatus && usageMap) {
        entries = entries
          .map((e) => ({ e, p: computeBestStatus(e[1], [...path, e[0]]) }))
          .sort((a, b) => a.p - b.p)
          .map((x) => x.e);
      }
      entries.forEach(([key, value]) => {
        const currentPath = [...path, key];
        const id = currentPath.join("/");
        const hasChildren = isObject(value) || Array.isArray(value);
        const isExpanded = expandedIds.has(id);

        items.push({
          id,
          key,
          value,
          depth,
          path: currentPath,
          isExpandable: hasChildren,
          isExpanded,
          hasChildren,
          childCount: hasChildren
            ? isObject(value)
              ? Object.keys(value).length
              : (value as unknown[]).length
            : 0,
          isArrayItem: false,
        });

        // Recursively add children if expanded
        if (hasChildren && isExpanded) {
          items.push(...flattenTree(value, currentPath, depth + 1));
        }
      });
    } else if (Array.isArray(obj)) {
      let indices = obj.map((item, idx) => ({ item, idx }));
      if (sortByStatus && usageMap) {
        indices = indices
          .map((x) => ({ ...x, p: computeBestStatus(x.item, [...path, String(x.idx)]) }))
          .sort((a, b) => a.p - b.p);
      }
      indices.forEach(({ item, idx }) => {
        const key = String(idx);
        const currentPath = [...path, key];
        const id = currentPath.join("/");
        const hasChildren = isObject(item) || Array.isArray(item);
        const isExpanded = expandedIds.has(id);

        items.push({
          id,
          key,
          value: item,
          depth,
          path: currentPath,
          isExpandable: hasChildren,
          isExpanded,
          hasChildren,
          childCount: hasChildren
            ? isObject(item)
              ? Object.keys(item).length
              : (item as unknown[]).length
            : 0,
          isArrayItem: true,
        });

        // Recursively add children if expanded
        if (hasChildren && isExpanded) {
          items.push(...flattenTree(item, currentPath, depth + 1));
        }
      });
    }

    return items;
  }

  let flatItems = $derived(flattenTree(data));

  function toggleExpanded(id: string) {
    const newSet = new Set(expandedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    expandedIds = newSet;
  }

  function startEditing(item: FlatItem) {
    editingId = item.id;
    // For array items, edit the value; for object keys, edit the key
    editingValue = item.isArrayItem ? String(item.value) : item.key;
  }

  function commitEdit(item: FlatItem) {
    if (editingId !== item.id) return;

    const newName = editingValue.trim();
    const oldName = item.isArrayItem ? String(item.value) : item.key;

    editingId = null;

    // Only call onRename if the value actually changed
    // Sanitize the new name to prevent XSS
    if (newName && newName !== oldName) {
      onRename(item.path, oldName, escapeHtml(newName), item.isArrayItem);
    }
  }

  function handleEditKeydown(e: KeyboardEvent, item: FlatItem) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingId = null;
    }
  }

  // Initialize all expandable items as expanded on mount
  let initialized = false;
  $effect(() => {
    if (!initialized && data) {
      const allExpandable = flattenTree(data, [], 0)
        .filter((item) => item.isExpandable)
        .map((item) => item.id);
      expandedIds = new Set(allExpandable);
      initialized = true;
    }
  });

  function handleDragStart(e: DragEvent, item: FlatItem) {
    if (!e.dataTransfer) return;

    try {
      e.dataTransfer.effectAllowed = "move";
      const dragData = {
        key: item.key,
        value: item.value,
        sourcePath: [panelId, ...item.path],
        isArrayItem: item.isArrayItem,
      };
      const serialized = JSON.stringify(dragData);
      e.dataTransfer.setData("application/json", serialized);
      console.log("Drag started:", { key: item.key, path: item.path });
    } catch (err) {
      console.error("Failed to serialize drag data:", err);
      return;
    }

    // Create a custom drag image that's compact
    const dragImage = document.createElement("div");
    dragImage.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      background: #f3f4f6;
      border: 2px solid #3b82f6;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 600;
      color: #1f2937;
      max-width: 250px;
      min-width: 100px;
      display: flex;
      align-items: center;
      gap: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      pointer-events: none;
      z-index: -9999;
      opacity: 1;
    `;

    // Show a compact representation with truncated key but visible count
    if (item.hasChildren) {
      const icon = document.createElement("span");
      icon.textContent = "📦";

      const keySpan = document.createElement("span");
      keySpan.style.cssText = `
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
        min-width: 0;
      `;
      const maxKeyLength = 20;
      keySpan.textContent =
        item.key.length > maxKeyLength
          ? item.key.substring(0, maxKeyLength) + "..."
          : item.key;

      const countSpan = document.createElement("span");
      countSpan.style.cssText = `flex-shrink: 0;`;
      countSpan.textContent = `(${item.childCount})`;

      dragImage.appendChild(icon);
      dragImage.appendChild(keySpan);
      dragImage.appendChild(countSpan);
    } else {
      const icon = document.createElement("span");
      icon.textContent = "📄";

      const keySpan = document.createElement("span");
      keySpan.style.cssText = `
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      `;
      const maxKeyLength = 25;
      keySpan.textContent =
        item.key.length > maxKeyLength
          ? item.key.substring(0, maxKeyLength) + "..."
          : item.key;

      dragImage.appendChild(icon);
      dragImage.appendChild(keySpan);
    }

    document.body.appendChild(dragImage);

    // Must call setDragImage synchronously during dragstart
    e.dataTransfer.setDragImage(dragImage, 10, 10);

    // Clean up the drag image after drag ends
    setTimeout(() => {
      if (document.body.contains(dragImage)) {
        document.body.removeChild(dragImage);
      }
    }, 0);

    // Add visual feedback to source
    if (e.target instanceof HTMLElement) {
      e.target.style.opacity = "0.5";
    }
  }

  function handleDragEnd(e: DragEvent) {
    if (e.target instanceof HTMLElement) {
      e.target.style.opacity = "1";
    }
    draggedOverId = null;
    dropPosition = null;
    stopAutoScroll();
    scrollContainer = null;
  }

  function handleDragOver(e: DragEvent, item: FlatItem) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }

    // Handle auto-scroll when near edges
    handleAutoScroll(e);

    // Clear any previous drag over state from different items
    if (draggedOverId !== item.id) {
      draggedOverId = item.id;
    }

    // Determine drop position based on mouse position and item type
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    const height = rect.height;

    // If it's an object or array (can have children), allow dropping inside
    if (item.hasChildren) {
      if (mouseY < height * 0.25) {
        dropPosition = "before";
      } else if (mouseY > height * 0.75) {
        dropPosition = "after";
      } else {
        dropPosition = "inside";
      }
    } else {
      // For simple values (leaf items), also allow "inside" for merging
      // Use a 3-zone split: top 33% = before, middle 34% = inside (merge), bottom 33% = after
      if (mouseY < height * 0.33) {
        dropPosition = "before";
      } else if (mouseY > height * 0.67) {
        dropPosition = "after";
      } else {
        dropPosition = "inside";
      }
    }
  }

  function handleDragLeave(e: DragEvent) {
    // Check if we're leaving to go to a non-child element
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    const currentTarget = e.currentTarget as HTMLElement;

    // Clear state if we're leaving to somewhere outside this element's tree
    if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
      draggedOverId = null;
      dropPosition = null;
      stopAutoScroll();
    }
  }

  function handleDrop(e: DragEvent, targetItem: FlatItem) {
    e.preventDefault();
    e.stopPropagation();

    const currentDropPosition = dropPosition;
    draggedOverId = null;
    dropPosition = null;

    if (!e.dataTransfer) return;

    try {
      const dragData = JSON.parse(e.dataTransfer.getData("application/json"));

      console.log("Drop data:", {
        dragData,
        targetItem,
        currentDropPosition,
        panelId,
      });

      // Don't allow dropping onto itself
      if (
        dragData.sourcePath.join("/") ===
        [panelId, ...targetItem.path].join("/")
      ) {
        console.log("Dropping onto itself, aborting");
        return;
      }

      // Determine the target path and insertion behavior
      let targetPath: string[];
      let insertBefore: string | undefined;
      let dropOnExpandedSection = false;
      let mergeWithLeafItem: {
        path: string[];
        key: string;
        isArrayItem: boolean;
      } | null = null;

      if (currentDropPosition === "inside" && targetItem.hasChildren) {
        // Drop inside the target object/array
        targetPath = targetItem.path;
        // Check if this section is expanded (user can see children)
        dropOnExpandedSection = expandedIds.has(targetItem.id);
        console.log(
          "Drop inside section (has children):",
          targetItem.key,
          "hasChildren:",
          targetItem.hasChildren,
        );
      } else if (currentDropPosition === "inside" && !targetItem.hasChildren) {
        // Drop onto a leaf item - this is a merge operation
        // The target path is the parent, but we signal a merge with the target item
        targetPath = targetItem.path.slice(0, -1); // Parent path
        mergeWithLeafItem = {
          path: targetItem.path,
          key: targetItem.key,
          isArrayItem: targetItem.isArrayItem,
        };
        console.log(
          "Drop onto leaf item (merging):",
          targetItem.key,
          "hasChildren:",
          targetItem.hasChildren,
          "mergeWithLeafItem:",
          mergeWithLeafItem,
        );
      } else if (currentDropPosition === "before") {
        // Drop before the target item (same level as target)
        targetPath = targetItem.path.slice(0, -1); // Parent path
        insertBefore = targetItem.key;
      } else {
        // Drop after the target item (same level)
        targetPath = targetItem.path.slice(0, -1); // Parent path
        const targetIndex = flatItems.findIndex(
          (item) => item.id === targetItem.id,
        );
        // Find next sibling (same depth)
        const nextSibling = flatItems
          .slice(targetIndex + 1)
          .find((item) => item.depth === targetItem.depth);
        if (nextSibling) {
          insertBefore = nextSibling.key;
        }
      }

      console.log("Calling onDrop with:", {
        panelId,
        targetPath,
        key: dragData.key,
        insertBefore,
        isArrayItem: dragData.isArrayItem,
        dropOnExpandedSection,
        mergeWithLeafItem,
      });

      onDrop(
        panelId,
        targetPath,
        dragData.key,
        dragData.value,
        dragData.sourcePath,
        insertBefore,
        dragData.isArrayItem,
        dropOnExpandedSection,
        mergeWithLeafItem,
      );
      console.log("onDrop call completed successfully");
    } catch (err) {
      console.error("Failed to parse drag data or call onDrop:", err);
    }
  }

  function handleRootDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (!e.dataTransfer) return;

    try {
      const dragData = JSON.parse(e.dataTransfer.getData("application/json"));

      // Drop at the root level of this panel
      onDrop(
        panelId,
        [],
        dragData.key,
        dragData.value,
        dragData.sourcePath,
        undefined,
        dragData.isArrayItem,
      );
    } catch (err) {
      console.error("Failed to parse drag data:", err);
    }
  }
</script>

{#if name}
  <div class="text-xs font-medium mb-2">{name}</div>
{/if}

<div
  role="region"
  ondrop={handleRootDrop}
  ondragover={(e) => {
    e.preventDefault();
    handleAutoScroll(e);
  }}
  ondragleave={() => stopAutoScroll()}
  class="min-h-4"
>
  {#if onCreateSection}
    <div class="mb-2 flex gap-2 sticky top-0 bg-card z-20 py-1">
      {#if isCreatingSection}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          bind:value={newSectionName}
          placeholder="Section name..."
          onkeydown={(e) => {
            if (e.key === "Enter" && newSectionName.trim()) {
              onCreateSection(escapeHtml(newSectionName.trim()));
              newSectionName = "";
              isCreatingSection = false;
            } else if (e.key === "Escape") {
              newSectionName = "";
              isCreatingSection = false;
            }
          }}
          onblur={() => {
            if (newSectionName.trim()) {
              onCreateSection(escapeHtml(newSectionName.trim()));
            }
            newSectionName = "";
            isCreatingSection = false;
          }}
          class="flex-1 bg-background border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          autofocus
        />
      {:else}
        <button
          onclick={() => (isCreatingSection = true)}
          class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-1 rounded hover:bg-accent transition-colors"
        >
          <span class="text-lg leading-none">+</span>
          <span>New Section</span>
        </button>
      {/if}
    </div>
  {/if}

  {#if flatItems.length > 0}
    <ul>
      {#each flatItems as item (item.id)}
        <li
          data-path-id="{panelId}/{item.id}"
          class="border-b border-border/50 last:border-b-0 relative {draggedOverId ===
          item.id
            ? dropPosition === 'inside'
              ? 'bg-accent/50'
              : ''
            : ''} {isHighlighted(item.path)
            ? 'bg-yellow-200 dark:bg-yellow-900/50 ring-2 ring-yellow-400 ring-inset'
            : ''}"
          style="padding-left: {item.depth * 20}px;"
          ondragover={(e) => handleDragOver(e, item)}
          ondragleave={handleDragLeave}
          ondrop={(e) => handleDrop(e, item)}
        >
          {#if draggedOverId === item.id && dropPosition === "before"}
            <div
              class="absolute top-0 left-0 right-0 h-0.5 bg-primary z-10"
            ></div>
          {/if}
          {#if draggedOverId === item.id && dropPosition === "after"}
            <div
              class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary z-10"
            ></div>
          {/if}

          {#if item.hasChildren}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex items-center gap-2 text-sm font-medium py-2 border-b border-border/50 group"
              onmouseenter={(e) => handleMouseEnterWithShift(e, item)}
              onmouseleave={() => handleMouseLeaveWithShift(item)}
            >
              <button
                onclick={() => toggleExpanded(item.id)}
                class="flex-shrink-0 w-6 h-6 flex items-center justify-center hover:bg-accent rounded transition-transform duration-200 {item.isExpanded
                  ? 'rotate-90'
                  : ''}"
              >
                <span class="text-lg">›</span>
              </button>
              {#if editingId === item.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  type="text"
                  bind:value={editingValue}
                  onblur={() => commitEdit(item)}
                  onkeydown={(e) => handleEditKeydown(e, item)}
                  class="flex-1 bg-background border border-primary rounded px-2 py-0.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
                  autofocus
                />
              {:else}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  draggable="true"
                  ondragstart={(e) => handleDragStart(e, item)}
                  ondragend={handleDragEnd}
                  ondblclick={() => startEditing(item)}
                  class="flex-1 cursor-grab active:cursor-grabbing select-none {getSourceColor(
                    item.path,
                  )} {getUsageStyle(item.path)}"
                >
                  {item.key}
                </div>
              {/if}
              {#if onDelete && hoveredId === item.id}
                <button
                  onclick={() => handleDelete(item)}
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                  title="Delete section"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><path d="M3 6h18" /><path
                      d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
                    /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line
                      x1="10"
                      x2="10"
                      y1="11"
                      y2="17"
                    /><line x1="14" x2="14" y1="11" y2="17" /></svg
                  >
                </button>
              {/if}
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              draggable={editingId !== item.id}
              ondragstart={(e) => handleDragStart(e, item)}
              ondragend={handleDragEnd}
              onmouseenter={(e) => handleMouseEnterWithShift(e, item)}
              onmouseleave={() => handleMouseLeaveWithShift(item)}
              class="flex gap-2 items-center text-sm py-2 group {editingId !==
              item.id
                ? 'cursor-grab active:cursor-grabbing'
                : ''}"
            >
              {#if item.isArrayItem}
                {#if editingId === item.id}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    type="text"
                    bind:value={editingValue}
                    onblur={() => commitEdit(item)}
                    onkeydown={(e) => handleEditKeydown(e, item)}
                    class="ml-8 flex-1 bg-background border border-primary rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    autofocus
                  />
                {:else}
                  <div
                    class="text-sm ml-8 flex-1 {getSourceColor(
                      item.path,
                    )} {getUsageStyle(item.path)}"
                    ondblclick={() => startEditing(item)}
                  >
                    {String(item.value)}
                  </div>
                {/if}
              {:else}
                <div class="flex gap-2 items-baseline flex-1">
                  {#if editingId === item.id}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      type="text"
                      bind:value={editingValue}
                      onblur={() => commitEdit(item)}
                      onkeydown={(e) => handleEditKeydown(e, item)}
                      class="ml-8 flex-1 bg-background border border-primary rounded px-2 py-0.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
                      autofocus
                    />
                  {:else}
                    <div
                      class="font-medium ml-8 {getSourceColor(
                        item.path,
                      )} {getUsageStyle(item.path)}"
                      ondblclick={() => startEditing(item)}
                    >
                      {item.key}
                    </div>
                  {/if}
                  {#if typeof item.value !== "object" && editingId !== item.id}
                    <div class="text-muted-foreground">
                      {String(item.value)}
                    </div>
                  {/if}
                </div>
              {/if}
              {#if onDelete && hoveredId === item.id}
                <button
                  onclick={() => handleDelete(item)}
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                  title="Delete item"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><path d="M3 6h18" /><path
                      d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
                    /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line
                      x1="10"
                      x2="10"
                      y1="11"
                      y2="17"
                    /><line x1="14" x2="14" y1="11" y2="17" /></svg
                  >
                </button>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if onCreateSection}
    <div
      class="text-sm text-muted-foreground text-center py-8 border-2 border-dashed border-border rounded-lg"
    >
      <p class="mb-2">Drop items here or create a new section</p>
    </div>
  {:else}
    <div class="text-sm">{String(data)}</div>
  {/if}
</div>

<style>
  button {
    border: none;
    background: none;
    padding: 0;
  }
</style>
