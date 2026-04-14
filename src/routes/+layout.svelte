<script lang="ts">
  import "./layout.css";
  import favicon from "$lib/assets/favicon.svg";
  import { ModeWatcher } from "mode-watcher";
  let { children } = $props();
</script>

<ModeWatcher />
<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<div class="flex flex-col h-screen">
  <main class="flex-1 overflow-hidden">
    {@render children()}
  </main>
</div>
