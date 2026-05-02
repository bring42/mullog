<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ files: File[] }>();
  let dragging = false;
  let input: HTMLInputElement;

  function emitFiles(fileList: FileList | null) {
    const files = [...(fileList ?? [])].filter((file) => /\.(txt|csv|log)$/i.test(file.name) || ['text/plain', 'text/csv', 'application/vnd.ms-excel'].includes(file.type));
    if (files.length > 0) dispatch('files', files);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    emitFiles(event.dataTransfer?.files ?? null);
  }
</script>

<div
  class:dragging
  class="dropzone"
  role="button"
  tabindex="0"
  on:click={() => input.click()}
  on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && input.click()}
  on:dragover={(event) => {
    event.preventDefault();
    dragging = true;
  }}
  on:dragleave={() => (dragging = false)}
  on:drop={onDrop}
>
  <input
    bind:this={input}
    type="file"
    accept=".txt,.csv,.log,text/plain,text/csv"
    on:change={(event) => emitFiles((event.currentTarget as HTMLInputElement).files)}
  />
  <div>
    <p class="label">LOCAL FILE INPUT</p>
    <p class="headline">DROP .TXT OR .CSV</p>
    <p class="hint">Browser-only decode, parse, inspect, filter, export. No upload leaves this device.</p>
  </div>
</div>
