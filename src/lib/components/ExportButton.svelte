<script lang="ts">
  import type { LogRow } from '$lib/types';
  import { downloadBlob, downloadCsv, rowsToTable } from '$lib/filters';

  export let rows: LogRow[] = [];
  /** File name without extension. */
  export let fileName = 'filtered-log-export';

  let open = false;
  let busy = false;
  let error = '';

  function exportCsv() {
    open = false;
    if (rows.length === 0) return;
    downloadCsv(rows, `${fileName}.csv`);
  }

  async function exportExcel() {
    open = false;
    if (rows.length === 0 || busy) return;
    busy = true;
    error = '';
    try {
      const { tableToXlsx } = await import('$lib/spreadsheet');
      const bytes = await tableToXlsx(rowsToTable(rows));
      downloadBlob(
        new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `${fileName}.xlsx`
      );
    } catch {
      error = 'Excel export failed';
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') open = false;
  }

  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as HTMLElement).contains(next)) open = false;
  }
</script>

<div class="export" on:keydown={onKeydown} on:focusout={onFocusOut} role="presentation">
  <button
    class="btn"
    type="button"
    disabled={rows.length === 0 || busy}
    aria-haspopup="menu"
    aria-expanded={open}
    on:click={() => (open = !open)}
    title="Export filtered rows"
  >
    {busy ? 'Exporting…' : 'Export'}
    <span class="btn-count">{rows.length.toLocaleString()}</span>
  </button>
  {#if open}
    <div class="menu" role="menu">
      <button type="button" role="menuitem" on:click={exportCsv}>CSV (.csv)</button>
      <button type="button" role="menuitem" on:click={exportExcel}>Excel (.xlsx)</button>
    </div>
  {/if}
  {#if error}<span class="err" role="alert">{error}</span>{/if}
</div>

<style>
  .export {
    position: relative;
    display: inline-block;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 20;
    min-width: 150px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--surface, Canvas);
    color: inherit;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.4));
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }
  .menu button {
    text-align: left;
    padding: 10px 12px;
    min-height: 44px;
    background: none;
    border: 0;
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: rgba(128, 128, 128, 0.18);
  }
  .err {
    position: absolute;
    right: 0;
    top: 100%;
    font-size: 12px;
    color: #b42318;
    white-space: nowrap;
  }
</style>
