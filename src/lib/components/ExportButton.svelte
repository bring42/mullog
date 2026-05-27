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

<button class="btn" disabled={rows.length === 0} on:click={exportRows} title="Export filtered rows as CSV">
  Export
  <span style="font-variant-numeric: tabular-nums; color: var(--text-muted); font-weight: 500;">{rows.length.toLocaleString()}</span>
</button>
