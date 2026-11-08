<script lang="ts">
  import type { LogRow } from '$lib/types';
  import { downloadCsv } from '$lib/filters';

  export let rows: LogRow[] = [];
  export let fileName = 'filtered-log-export.csv';

  function exportRows() {
    if (rows.length === 0) return;
    downloadCsv(rows, fileName);
  }
</script>

<button class="btn" type="button" disabled={rows.length === 0} on:click={exportRows} title="Export filtered rows as CSV">
  Export
  <span class="btn-count">{rows.length.toLocaleString()}</span>
</button>
