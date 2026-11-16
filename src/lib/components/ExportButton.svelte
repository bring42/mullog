<script lang="ts">
  import { tick } from 'svelte';
  import type { LogRow } from '$lib/types';
  import { downloadBlob, downloadCsv, rowsToTable } from '$lib/filters';

  export let rows: LogRow[] = [];
  /** File name without extension. */
  export let fileName = 'filtered-log-export';

  let open = false;
  let busy = false;
  let message = '';
  let messageKind: 'error' | 'info' = 'info';
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;

  // A new file or filter makes any earlier export message stale.
  $: rows, (message = '');

  function items(): HTMLButtonElement[] {
    return menu ? [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] : [];
  }

  async function openMenu(focus: 'first' | 'last' = 'first') {
    open = true;
    await tick();
    const list = items();
    (focus === 'first' ? list[0] : list[list.length - 1])?.focus();
  }

  function closeMenu(restoreFocus = false) {
    open = false;
    if (restoreFocus) trigger?.focus();
  }

  function exportCsv() {
    closeMenu(true);
    message = '';
    if (rows.length === 0) return;
    downloadCsv(rows, `${fileName}.csv`);
  }

  async function exportExcel() {
    closeMenu(true);
    if (rows.length === 0 || busy) return;
    busy = true;
    message = '';
    try {
      const { tableToXlsx } = await import('$lib/spreadsheet');
      const result = await tableToXlsx(rowsToTable(rows));
      downloadBlob(
        new Blob([result.bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `${fileName}.xlsx`
      );
      const notes: string[] = [];
      if (result.sheetCount > 1) notes.push(`split across ${result.sheetCount} sheets (Excel row limit)`);
      if (result.truncatedCells > 0) {
        notes.push(`${result.truncatedCells.toLocaleString()} long cell${result.truncatedCells === 1 ? '' : 's'} cut to Excel's 32,767-character limit; use CSV for full text`);
      }
      if (notes.length) {
        messageKind = 'info';
        message = `Exported, ${notes.join('; ')}.`;
      }
    } catch (error) {
      messageKind = 'error';
      message = error instanceof Error && error.message.startsWith('Excel supports') ? error.message : 'Excel export failed.';
    } finally {
      busy = false;
    }
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    } else if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (next !== -1) {
      event.preventDefault();
      list[next]?.focus();
    }
  }

  // Close on any press outside. Focus events alone miss Safari, where clicking a button does not focus it.
  function onWindowPointerDown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) closeMenu();
  }

</script>

<svelte:window on:pointerdown={onWindowPointerDown} />

<div class="export" bind:this={root}>
  <button
    bind:this={trigger}
    class="btn"
    type="button"
    disabled={rows.length === 0 || busy}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="export-menu"
    on:click={() => (open ? closeMenu() : openMenu())}
    on:keydown={onTriggerKeydown}
    title="Export filtered rows"
  >
    {busy ? 'Exporting…' : 'Export'}
    <span class="btn-count">{rows.length.toLocaleString()}</span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y-interactive-supports-focus -->
    <div id="export-menu" class="menu" role="menu" aria-label="Export format" bind:this={menu} on:keydown={onMenuKeydown}>
      <button type="button" role="menuitem" tabindex="-1" on:click={exportCsv}>CSV (.csv)</button>
      <button type="button" role="menuitem" tabindex="-1" on:click={exportExcel}>Excel (.xlsx)</button>
    </div>
  {/if}
  {#if message}
    <span class="note" class:error={messageKind === 'error'} role={messageKind === 'error' ? 'alert' : 'status'}>
      {message}
      <button type="button" class="dismiss" aria-label="Dismiss" on:click={() => (message = '')}>×</button>
    </span>
  {/if}
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
    background: var(--bg-elevated);
    color: inherit;
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-2);
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
    background: var(--bg-muted);
  }
  .note {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 19;
    width: max-content;
    max-width: min(320px, calc(100vw - 32px));
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 4px 6px 10px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-2);
  }
  .note.error {
    color: var(--error);
  }
  .dismiss {
    flex: none;
    min-width: 24px;
    min-height: 24px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
</style>
