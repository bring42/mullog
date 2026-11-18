<script lang="ts">
  import { tick } from 'svelte';
  import type { LogRow } from '$lib/types';
  import { downloadBlob, type TableView } from '$lib/filters';
  import { buildExport, EXPORT_FORMATS, type ExportFormat } from '$lib/exporters';

  export let rows: LogRow[] = [];
  /** The table's shown columns; the export uses the same ones. */
  export let view: TableView | undefined = undefined;
  /** File name without extension. */
  export let fileName = 'filtered-log-export';

  const groups = [...new Set(EXPORT_FORMATS.map((format) => format.group))].map((group) => ({
    group,
    formats: EXPORT_FORMATS.filter((format) => format.group === group)
  }));

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

  async function exportAs(format: ExportFormat) {
    closeMenu(true);
    if (rows.length === 0 || busy) return;
    busy = true;
    message = '';
    try {
      const result = await buildExport(format.id, rows, view);
      downloadBlob(result.blob, `${fileName}.${format.extension}`);
      if (result.notes.length) {
        messageKind = 'info';
        message = `Exported, ${result.notes.join('; ')}.`;
      }
    } catch (error) {
      messageKind = 'error';
      message = error instanceof Error && error.message.startsWith('Excel supports') ? error.message : `${format.label} export failed.`;
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
    title="Export the rows and columns shown"
  >
    {busy ? 'Exporting…' : 'Export'}
    <span class="btn-count">{rows.length.toLocaleString()}</span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y-interactive-supports-focus -->
    <div id="export-menu" class="menu" role="menu" aria-label="Export format" bind:this={menu} on:keydown={onMenuKeydown}>
      {#each groups as { group, formats }, groupIndex}
        <div class="group" role="group" aria-label={group}>
          {#if groupIndex > 0}<div class="sep" role="separator"></div>{/if}
          <div class="group-label" aria-hidden="true">{group}</div>
          {#each formats as format}
            <button type="button" role="menuitem" tabindex="-1" on:click={() => exportAs(format)}>
              <span class="item-label">{format.label} <span class="ext">.{format.extension}</span></span>
              <span class="item-hint">{format.hint}</span>
            </button>
          {/each}
        </div>
      {/each}
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
    min-width: 240px;
    max-height: min(70vh, 560px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-elevated);
    color: inherit;
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-2);
  }
  .group {
    display: flex;
    flex-direction: column;
  }
  .sep {
    height: 1px;
    margin: 4px 0;
    background: var(--border);
  }
  .group-label {
    padding: 6px 12px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .item-label {
    display: block;
  }
  .ext {
    color: var(--text-faint);
    font-size: 12px;
  }
  .item-hint {
    display: block;
    font-size: 12px;
    color: var(--text-muted);
  }
  .menu button {
    text-align: left;
    padding: 6px 12px;
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
