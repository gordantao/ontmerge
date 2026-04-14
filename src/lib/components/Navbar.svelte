<script lang="ts">
  import { toggleMode } from "mode-watcher";
  import {
    Moon,
    Sun,
    Undo2,
    Redo2,
    FileCode,
    FileUp,
    ArrowUpDown,
    FileDown,
    CircleHelp,
    X,
  } from "lucide-svelte";

  let {
    onUndo,
    onRedo,
    canUndo = false,
    canRedo = false,
    onImportFile,
    onExportV4,
    sourceSortByStatus = false,
    onToggleSort,
  }: {
    onUndo?: () => void;
    onRedo?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
    onImportFile?: (event: Event) => void;
    onExportV4?: () => void;
    sourceSortByStatus?: boolean;
    onToggleSort?: () => void;
  } = $props();

  let showHelp = $state(false);

  function openHelp() {
    showHelp = true;
  }

  function closeHelp() {
    showHelp = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && showHelp) {
      closeHelp();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<nav
  class="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
>
  <div class="flex h-14 items-center px-4 gap-2">
    <div class="flex items-center gap-2 shrink-0">
      <h1 class="text-lg font-semibold">OntMerge</h1>
    </div>

    <div class="w-px h-5 bg-border mx-1"></div>

    <div class="flex items-center gap-1">
      {#if onUndo}
        <button
          onclick={onUndo}
          disabled={!canUndo}
          class="p-1.5 rounded hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed {canUndo
            ? 'text-muted-foreground hover:text-foreground'
            : 'text-muted-foreground'}"
          title="Undo (⌘Z)"
        >
          <Undo2 class="h-4 w-4" />
        </button>
      {/if}

      {#if onRedo}
        <button
          onclick={onRedo}
          disabled={!canRedo}
          class="p-1.5 rounded hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed {canRedo
            ? 'text-muted-foreground hover:text-foreground'
            : 'text-muted-foreground'}"
          title="Redo (⌘⇧Z)"
        >
          <Redo2 class="h-4 w-4" />
        </button>
      {/if}

      <div class="w-px h-4 bg-border mx-1 self-center"></div>

      {#if onImportFile}
        <label
          class="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          title="Import merge file"
        >
          <FileUp class="h-4 w-4" />
          <input
            type="file"
            accept=".json"
            class="hidden"
            onchange={onImportFile}
          />
        </label>
      {/if}

      {#if onExportV4}
        <button
          onclick={onExportV4}
          class="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          title="Export merge file"
        >
          <FileDown class="h-4 w-4" />
        </button>
      {/if}

      <div class="w-px h-4 bg-border mx-1 self-center"></div>

      {#if onToggleSort}
        <button
          onclick={onToggleSort}
          class="p-1.5 rounded hover:bg-accent transition-colors {sourceSortByStatus
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          title="Sort source panels by merge status"
        >
          <ArrowUpDown class="h-4 w-4" />
        </button>
      {/if}
    </div>

    <div class="flex-1"></div>

    <button
      onclick={openHelp}
      class="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
      title="Help"
    >
      <CircleHelp class="h-4 w-4" />
    </button>

    <button
      onclick={toggleMode}
      class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-9 w-9"
    >
      <Sun
        class="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
      />
      <Moon
        class="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
      />
      <span class="sr-only">Toggle theme</span>
    </button>
  </div>
</nav>

<!-- Help Modal -->
{#if showHelp}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={closeHelp}
    onkeydown={(e) => e.key === "Escape" && closeHelp()}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="bg-background rounded-lg shadow-lg max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="document"
    >
      <div class="flex items-center justify-between p-4 border-b">
        <h2 class="text-lg font-semibold">OntMerge Help</h2>
        <button
          onclick={closeHelp}
          class="p-1 rounded hover:bg-accent transition-colors"
          aria-label="Close help"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
      <div class="p-4 space-y-4">
        <p class="text-sm text-muted-foreground">
          OntMerge is a no-code drag-and-drop tool for merging two medical
          ontologies Classification into a unified hierarchy.
        </p>

        <div>
          <h3 class="font-medium text-sm mb-2">Keyboard Shortcuts</h3>
          <ul class="text-sm space-y-1 text-muted-foreground">
            <li>
              <kbd class="kbd">⌘Z</kbd> / <kbd class="kbd">Ctrl+Z</kbd> — Undo
            </li>
            <li>
              <kbd class="kbd">⌘⇧Z</kbd> / <kbd class="kbd">Ctrl+⇧Z</kbd> or
              <kbd class="kbd">Ctrl+Y</kbd> — Redo
            </li>
            <li><kbd class="kbd">x</kbd> — Expand all nodes in a tree</li>
            <li><kbd class="kbd">c</kbd> — Collapse all nodes in a tree</li>
            <li><kbd class="kbd">Shift</kbd> + hover — Show concept details</li>
          </ul>
        </div>

        <div>
          <h3 class="font-medium text-sm mb-2">Toolbar Buttons</h3>
          <ul class="text-sm space-y-1 text-muted-foreground">
            <li><kbd class="kbd">↩</kbd> — Undo last action</li>
            <li><kbd class="kbd">↪</kbd> — Redo previously undone action</li>
            <li><kbd class="kbd">↑</kbd> — Import a merge file</li>
            <li><kbd class="kbd">↓</kbd> — Export merged ontology</li>
            <li><kbd class="kbd">⇅</kbd> — Sort by merge status</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
{/if}
