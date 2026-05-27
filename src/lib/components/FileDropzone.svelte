<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let headline = 'Drop a .csv, .tsv, .log or .txt';
  export let hint = 'Or click to choose. Everything stays on this device.';

  const dispatch = createEventDispatcher<{ files: File[] }>();
  let dragging = false;
  let input: HTMLInputElement;

  function emitFiles(fileList: FileList | null) {
    const files = [...(fileList ?? [])].filter(
      (file) =>
        /\.(txt|csv|tsv|log)$/i.test(file.name) ||
        ['text/plain', 'text/csv', 'text/tab-separated-values', 'application/vnd.ms-excel'].includes(file.type)
    );
    if (files.length > 0) dispatch('files', files);
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
  on:drop={(event) => {
    event.preventDefault();
    dragging = false;
    emitFiles(event.dataTransfer?.files ?? null);
  }}
>
  <input
    bind:this={input}
    type="file"
    accept=".txt,.csv,.tsv,.log,text/plain,text/csv,text/tab-separated-values"
    on:change={(event) => emitFiles((event.currentTarget as HTMLInputElement).files)}
  />
  <div class="dz-headline">{headline}</div>
  <div class="dz-hint">{hint}</div>
</div>
