<script lang="ts">
  import type { LogRow } from '$lib/types';
  import { downloadCsv } from '$lib/filters';

  export let rows: LogRow[] = [];
  export let fileName = 'filtered-log-export.csv';
  export let sticky = false;

  function exportRows() {
    if (rows.length === 0) return;
    downloadCsv(rows, fileName);
  }
</script>

<button class="machine-button export" class:sticky-action={sticky} disabled={rows.length === 0} on:click={exportRows}>
  EXPORT CSV <span>{rows.length.toLocaleString()}</span>
</button>
