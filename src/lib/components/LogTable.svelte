<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { highlightSegments } from '$lib/filters';
  import type { LogRow } from '$lib/types';

  export let rows: LogRow[] = [];
  export let columns: string[] = [];
  export let visibleColumns: string[] = [];
  export let timestampColumn: string | undefined = undefined;
  export let severityColumn: string | undefined = undefined;
  export let messageColumn: string | undefined = undefined;
  export let search = '';
  export let selectedId = '';

  const dispatch = createEventDispatcher<{ select: LogRow }>();

  // Only the rows in view (plus some overscan) are in the DOM; spacer rows above and below stand in
  // for the rest, so files with hundreds of thousands of rows stay responsive. Every row has the
  // same height (fixed in app.css), which keeps the scroll offset → row index mapping exact.
  const OVERSCAN = 20;
  let scroller: HTMLDivElement | undefined;
  let tbody: HTMLTableSectionElement | undefined;
  let scrollTop = 0;
  let viewportHeight = 0;
  let headerHeight = 0;
  // Refined by measure() once a row is rendered; 37px is what app.css gives every row.
  let rowHeight = 37;

  $: total = rows.length;
  $: rowsInView = Math.ceil((viewportHeight || 800) / rowHeight);
  // Clamped so a shrinking row count (new filter) never renders an empty window before the browser
  // clamps the scroll position.
  $: firstVisible = Math.min(Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight), Math.max(0, total - rowsInView));
  $: start = Math.max(0, firstVisible - OVERSCAN);
  $: end = Math.min(total, firstVisible + rowsInView + OVERSCAN);
  $: windowRows = (noteFocusedRow(), rows.slice(start, end));
  $: topSpacer = start * rowHeight;
  $: bottomSpacer = (total - end) * rowHeight;
  $: columnCount = orderedColumns.length + 1;
  // Re-measure when the layout may have changed: new columns or a table appearing after being empty.
  $: void orderedColumns, total > 0, tick().then(measure);

  // With only a window of rows rendered, auto table layout would size columns to whatever is on
  // screen and shift them while scrolling (the # column gains a digit, a longer category appears).
  // Columns therefore only grow while the same rows and columns are shown, like a fully rendered table.
  let columnWidths: Record<string, number> = {};
  $: void rows, orderedColumns, (columnWidths = {});
  $: void windowRows, columnWidths, tick().then(growColumnWidths);

  function growColumnWidths() {
    if (!scroller) return;
    const cells = scroller.querySelectorAll<HTMLElement>('thead th');
    const keys = ['#', ...orderedColumns];
    const next = { ...columnWidths };
    let grew = false;
    cells.forEach((cell, index) => {
      const key = keys[index];
      if (key === undefined || key === flexColumn) return;
      const style = getComputedStyle(cell);
      const width = cell.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      if (width > (next[key] ?? 0) + 0.5) {
        next[key] = width;
        grew = true;
      }
    });
    if (grew) columnWidths = next;
  }

  function widthStyle(key: string, widths: Record<string, number>): string | undefined {
    const width = widths[key];
    return width ? `${width}px` : undefined;
  }

  // A focused row that scrolls out of the window is removed from the DOM and focus falls back to the
  // page body. Remember it, so keyboard stepping still treats focus as being on the rows and the row
  // gets focus back when it is rendered again.
  let focusedRowId: string | null = null;
  $: void windowRows, tick().then(restoreRowFocus);

  /** Runs just before the rendered window changes, while a focused row is still in the DOM. */
  function noteFocusedRow() {
    if (typeof document === 'undefined') return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.matches('tr[data-row-id]') && tbody?.contains(active)) focusedRowId = active.dataset.rowId ?? null;
    else if (!focusIsOnPageBody()) focusedRowId = null;
  }

  function handleFocusOut(event: FocusEvent) {
    const row = event.target as HTMLElement;
    // Still in the DOM: focus left on purpose (e.g. a click elsewhere), not because the row scrolled away.
    queueMicrotask(() => {
      if (row.isConnected && !document.activeElement?.matches('tr[data-row-id]')) focusedRowId = null;
    });
  }

  function focusIsOnPageBody(): boolean {
    return !document.activeElement || document.activeElement === document.body;
  }

  function restoreRowFocus() {
    if (!focusedRowId || !focusIsOnPageBody()) return;
    tbody?.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(focusedRowId)}"]`)?.focus({ preventScroll: true });
  }

  /** Whether keyboard focus is on a row, or was until that row scrolled out of the rendered window. */
  export function rowHasFocus(): boolean {
    noteFocusedRow();
    if (document.activeElement?.matches('tr[data-row-id]')) return true;
    return focusedRowId !== null && focusIsOnPageBody();
  }

  onMount(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(scroller);
    return () => observer.disconnect();
  });

  function measure() {
    if (!scroller) return;
    viewportHeight = scroller.clientHeight;
    headerHeight = scroller.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const row = tbody?.querySelector('tr[data-row-id]');
    const height = row?.getBoundingClientRect().height;
    if (height) rowHeight = height;
    scrollTop = scroller.scrollTop;
  }

  function handleScroll() {
    if (scroller) scrollTop = scroller.scrollTop;
  }

  /**
   * Scrolls just far enough for the row to be rendered and fully visible below the sticky header,
   * then waits for it to be in the DOM so the caller can focus it.
   */
  export async function reveal(id: string): Promise<void> {
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1 || !scroller) return;
    const top = headerHeight + index * rowHeight;
    const bottom = top + rowHeight;
    let next = scroller.scrollTop;
    if (top < next + headerHeight) next = top - headerHeight;
    else if (bottom > next + scroller.clientHeight) next = bottom - scroller.clientHeight;
    if (next !== scroller.scrollTop) {
      scroller.scrollTop = next;
      scrollTop = scroller.scrollTop;
    }
    await tick();
  }

  $: orderedColumns = orderColumns(columns, visibleColumns);
  // The message column (when shown) absorbs all remaining width instead of being capped.
  $: flexColumn = messageColumn && orderedColumns.includes(messageColumn) ? messageColumn : undefined;
  // Merged rows get a "+N lines" hint in the message column, or the last column if message is hidden.
  $: hintColumn = flexColumn ?? orderedColumns[orderedColumns.length - 1];

  function extraLines(row: LogRow): number {
    return row.lineEnd ? row.lineEnd - row.lineNumber : 0;
  }

  /** Timestamp, then severity, then everything else, with the message last so it can fill the row. */
  function orderColumns(all: string[], visible: string[]): string[] {
    const filtered = all.filter((column) => visible.includes(column));
    const lead = [timestampColumn, severityColumn].filter((column): column is string => !!column && filtered.includes(column));
    const tail = messageColumn && filtered.includes(messageColumn) ? [messageColumn] : [];
    return [...lead, ...filtered.filter((column) => !lead.includes(column) && !tail.includes(column)), ...tail];
  }

  function cellValue(row: LogRow, column: string): string {
    const value = row.fields[column] ?? '';
    if (column === timestampColumn && row.timestampRaw) return row.timestampRaw;
    return value;
  }

  function columnClass(column: string): string {
    if (column === timestampColumn) return 'timestamp';
    if (column === severityColumn) return 'severity';
    if (column === flexColumn) return 'message';
    return 'meta';
  }
</script>

<div class="table-scroll" bind:this={scroller} on:scroll={handleScroll}>
  {#if rows.length === 0}
    <div class="empty-table">No rows match the current filters.</div>
  {:else}
    <table class="log" class:has-flex={!!flexColumn}>
      <thead>
        <tr>
          <!-- The inner div sets a floor on the column's width; a width on the cell itself would also cap it. -->
          <th class="line-num"><div style:min-width={widthStyle('#', columnWidths)}>#</div></th>
          {#each orderedColumns as column}
            <th class={columnClass(column)}><div style:min-width={widthStyle(column, columnWidths)}>{column}</div></th>
          {/each}
        </tr>
      </thead>
      <tbody bind:this={tbody} on:focusout={handleFocusOut}>
        {#if topSpacer > 0}
          <tr class="spacer" aria-hidden="true"><td colspan={columnCount} style:height="{topSpacer}px"></td></tr>
        {/if}
        {#each windowRows as row, offset (row.id)}
          <tr
            class={row.severity ? `sev-${row.severity.toLowerCase()}` : ''}
            class:stripe={(start + offset) % 2 === 1}
            class:selected={selectedId === row.id}
            class:malformed={row.malformed}
            data-row-id={row.id}
            aria-selected={selectedId === row.id}
            tabindex="0"
            on:click={() => dispatch('select', row)}
            on:keydown={(event) => {
              if (event.key !== 'Enter') return;
              // Stop the same keypress from activating a control that gains focus as the row opens.
              event.preventDefault();
              dispatch('select', row);
            }}
          >
            <td class="line-num">{row.lineNumber}</td>
            {#each orderedColumns as column}
              {@const value = cellValue(row, column)}
              <td class={columnClass(column)} title={value}>
                {#if column === hintColumn && extraLines(row) > 0}
                  <span class="more-lines" title="Lines {row.lineNumber}–{row.lineEnd}">+{extraLines(row)} line{extraLines(row) === 1 ? '' : 's'}</span>
                {/if}
                {#if column === severityColumn && value}
                  <span class="sev-tag sev-{(row.severity ?? 'other').toLowerCase()}">{value}</span>
                {:else}
                  {#each highlightSegments(value, search, column === flexColumn ? 90 : 24, column === flexColumn ? 40 : 12) as segment}
                    {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                  {/each}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
        {#if bottomSpacer > 0}
          <tr class="spacer" aria-hidden="true"><td colspan={columnCount} style:height="{bottomSpacer}px"></td></tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>
