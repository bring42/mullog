<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let headline = 'Drop a log, CSV, Excel or JSON file';
  export let hint = 'Or click to choose. Everything stays on this device.';

  const dispatch = createEventDispatcher<{ files: File[] }>();
  let dragging = false;
  let input: HTMLInputElement;

  // Any file is fine: logs often have no extension (syslog, messages, app.log.1) and the
  // parser works out the layout from the content.
  function emitFiles(fileList: FileList | null) {
    const files = [...(fileList ?? [])];
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
    on:change={(event) => emitFiles((event.currentTarget as HTMLInputElement).files)}
  />
  <div class="dz-headline">{headline}</div>
  <div class="dz-hint">{hint}</div>
</div>
