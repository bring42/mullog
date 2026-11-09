<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let headline = 'Drop a log, CSV, Excel or JSON file';
  export let hint = 'Or click to choose. Everything stays on this device.';

  const ACCEPTED_TYPES = [
    'text/plain',
    'text/csv',
    'text/tab-separated-values',
    'application/json',
    'application/x-ndjson',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet'
  ];
  const ACCEPT = ['.txt', '.csv', '.tsv', '.log', '.json', '.jsonl', '.ndjson', '.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', ...ACCEPTED_TYPES].join(',');

  const dispatch = createEventDispatcher<{ files: File[] }>();
  let dragging = false;
  let input: HTMLInputElement;

  function emitFiles(fileList: FileList | null) {
    const files = [...(fileList ?? [])].filter(
      (file) =>
        /\.(txt|csv|tsv|log|json|jsonl|ndjson|xlsx|xlsm|xlsb|xls|ods)$/i.test(file.name) || ACCEPTED_TYPES.includes(file.type)
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
    accept={ACCEPT}
    on:change={(event) => emitFiles((event.currentTarget as HTMLInputElement).files)}
  />
  <div class="dz-headline">{headline}</div>
  <div class="dz-hint">{hint}</div>
</div>
