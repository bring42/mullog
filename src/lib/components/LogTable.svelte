<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { LogRow, ViewMode } from '$lib/types';

  export let rows: LogRow[] = [];
  export let columns: string[] = [];
  export let visibleColumns: string[] = [];
  export let viewMode: ViewMode = 'hybrid';
  export let selectedId = '';

  const dispatch = createEventDispatcher<{ select: LogRow }>();

  type HeaderColumn = {
    key: string;
    label: string;
    dataLabel: string;
    minWidth: number;
    defaultWidth: number;
    className?: string;
    fieldName?: string;
  };

  let columnWidths: Record<string, number> = {};
  let activeResize: { key: string; startX: number; startWidth: number } | null = null;

  $: structuredColumns = columns.filter((column) => visibleColumns.includes(column));
  $: headerColumns = buildHeaderColumns(viewMode, structuredColumns);
  $: syncColumnWidths(headerColumns);

  function displayTimestamp(row: LogRow): string {
    return row.timestamp ? row.timestamp.replace('T', ' ').replace('.000Z', 'Z') : '';
  }

  function buildHeaderColumns(mode: ViewMode, structured: string[]): HeaderColumn[] {
    const headers: HeaderColumn[] = [{ key: 'line', label: 'LINE', dataLabel: 'LINE', minWidth: 80, defaultWidth: 80, className: 'line-number' }];

    if (mode !== 'raw') {
      headers.push(
        { key: 'time', label: 'TIME', dataLabel: 'TIME', minWidth: 200, defaultWidth: 220, className: 'timestamp' },
        { key: 'severity', label: 'SEV', dataLabel: 'SEV', minWidth: 90, defaultWidth: 90 },
        { key: 'category', label: 'CAT/SRC', dataLabel: 'CAT/SRC', minWidth: 180, defaultWidth: 180, className: 'category-cell' }
      );
    }

    if (mode === 'structured') {
      return [
        ...headers,
        ...structured.map((column) => ({
          key: `field:${column}`,
          label: column,
          dataLabel: column,
          fieldName: column,
          minWidth: 160,
          defaultWidth: 220
        }))
      ];
    }

    return [...headers, { key: 'raw', label: 'RAW / MESSAGE', dataLabel: 'RAW', minWidth: 320, defaultWidth: 560, className: 'raw-cell' }];
  }

  function syncColumnWidths(headers: HeaderColumn[]) {
    columnWidths = Object.fromEntries(
      headers.map((header) => [header.key, Math.max(header.minWidth, columnWidths[header.key] ?? header.defaultWidth)])
    );
  }

  function columnValue(row: LogRow, header: HeaderColumn): string | number {
    if (header.key === 'line') return row.lineNumber;
    if (header.key === 'time') return displayTimestamp(row) || '-';
    if (header.key === 'severity') return row.severity;
    if (header.key === 'category') return row.category;
    if (header.key === 'raw') return viewMode === 'raw' ? row.rawLine : row.fields.message || row.rawLine;
    return row.fields[header.fieldName ?? ''] ?? '';
  }

  function startResize(event: PointerEvent, header: HeaderColumn) {
    event.preventDefault();
    event.stopPropagation();
    activeResize = {
      key: header.key,
      startX: event.clientX,
      startWidth: columnWidths[header.key] ?? header.defaultWidth
    };
    window.addEventListener('pointermove', handleResize);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
    window.addEventListener('blur', stopResize);
  }

  function handleResize(event: PointerEvent) {
    if (!activeResize) return;
    const header = headerColumns.find((item) => item.key === activeResize?.key);
    if (!header) return;
    const nextWidth = Math.max(header.minWidth, activeResize.startWidth + event.clientX - activeResize.startX);
    columnWidths = { ...columnWidths, [header.key]: nextWidth };
  }

  function stopResize() {
    window.removeEventListener('pointermove', handleResize);
    window.removeEventListener('pointerup', stopResize);
    window.removeEventListener('pointercancel', stopResize);
    window.removeEventListener('blur', stopResize);
    activeResize = null;
  }

  function resetWidths() {
    columnWidths = Object.fromEntries(headerColumns.map((header) => [header.key, header.defaultWidth]));
  }

  onDestroy(() => stopResize());
</script>

<section class="inspection-surface panel" aria-label="Log inspection table">
  <header class="surface-header">
    <div>
      <p class="label">MAIN INSPECTION SURFACE</p>
      <h2>{rows.length.toLocaleString()} ROWS IN CURRENT VIEW</h2>
    </div>
    <div class="surface-actions">
      {#if viewMode === 'structured' && columns.length > 0}
        <div class="view-hint">COLUMNS: {structuredColumns.length}/{columns.length}</div>
      {/if}
      <div class="view-hint">VIEW: {viewMode.toUpperCase()}</div>
      <button class="tiny-button table-action" type="button" on:click={resetWidths}>RESET WIDTHS</button>
    </div>
  </header>

  <div class="table-wrap">
    <table class="log-table {viewMode}">
      <colgroup>
        {#each headerColumns as header}
          <col style:width={`${columnWidths[header.key] ?? header.defaultWidth}px`} />
        {/each}
      </colgroup>
      <thead>
        <tr>
          {#each headerColumns as header}
            <th class={header.className}>
              <div class="th-content">
                <span>{header.label}</span>
                <button
                  class="column-resizer"
                  type="button"
                  aria-label={`Resize ${header.label} column`}
                  on:pointerdown={(event) => startResize(event, header)}
                ></button>
              </div>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr
            class:selected={selectedId === row.id}
            class="severity-{row.severity.toLowerCase()}"
            tabindex="0"
            on:click={() => dispatch('select', row)}
            on:keydown={(event) => event.key === 'Enter' && dispatch('select', row)}
          >
            {#each headerColumns as header}
              <td data-label={header.dataLabel} class={header.className}>
                {#if header.key === 'severity'}
                  <span class="severity-pill">{row.severity}</span>
                {:else}
                  {columnValue(row, header)}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
