<script lang="ts">
  import { onMount, tick } from 'svelte';
  import FileDropzone from '$lib/components/FileDropzone.svelte';
  import DetectionPanel from '$lib/components/DetectionPanel.svelte';
  import FilterRail from '$lib/components/FilterRail.svelte';
  import LogTable from '$lib/components/LogTable.svelte';
  import RowInspector from '$lib/components/RowInspector.svelte';
  import ExportButton from '$lib/components/ExportButton.svelte';
  import { decodeBuffer, detectEncoding, supportedEncodings } from '$lib/encoding';
  import { applyFilters, buildFacets, clearFilterToken, describeActiveFilters, emptyFilters } from '$lib/filters';
  import { parseLogText } from '$lib/parser';
  import type { DetectionState, EncodingName, FilterState, LogRow, ParseWarning } from '$lib/types';

  let currentBuffer: ArrayBuffer | null = null;
  let currentText = '';
  let fileName = '';
  let fileSize = 0;
  let encoding: EncodingName = 'utf-8';
  let encodingConfidence = 1;
  let encodingNotes: string[] = [];
  let encodingWarnings: ParseWarning[] = [];
  let rows: LogRow[] = [];
  let selectedRow: LogRow | null = null;
  let detection: DetectionState | null = null;
  let filters: FilterState = { ...emptyFilters, columnFilters: {} };
  let visibleColumns: string[] = [];
  let filtersOpen = false;
  let parseError = '';
  let schemaKey = '';

  const encodings = supportedEncodings();

  $: hasFile = currentText.length > 0;
  $: filteredRows = applyFilters(rows, filters);
  $: facets = buildFacets(rows);
  $: activeTokens = describeActiveFilters(filters);
  $: tableColumns = detection?.schema.map((column) => column.name) ?? [];
  $: timestampColumn = detection?.schema.find((column) => column.role === 'timestamp')?.name;
  $: exportName = `${fileName.replace(/\.[^.]+$/, '') || 'log'}-filtered.csv`;
  $: rowOrder = new Map(rows.map((row, index) => [row.id, index]));
  $: selectedPosition = selectedRow ? filteredRows.findIndex((row) => row.id === selectedRow?.id) : -1;
  $: canPrev = neighbourIndex(-1, selectedRow, selectedPosition, filteredRows, rowOrder) !== -1;
  $: canNext = neighbourIndex(1, selectedRow, selectedPosition, filteredRows, rowOrder) !== -1;

  onMount(() => {
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  });

  async function handleFiles(event: CustomEvent<File[]>) {
    const file = event.detail[0];
    if (!file) return;

    currentBuffer = await file.arrayBuffer();
    fileName = file.name;
    fileSize = file.size;
    const detected = detectEncoding(currentBuffer);
    encoding = detected.encoding;
    encodingConfidence = detected.confidence;
    encodingNotes = detected.notes;
    encodingWarnings = detected.warnings;
    currentText = decodeBuffer(currentBuffer, encoding);
    filters = { ...emptyFilters, columnFilters: {} };
    selectedRow = null;
    parseCurrent();
  }

  function parseCurrent() {
    try {
      parseError = '';
      const result = parseLogText(currentText, {
        fileName,
        fileSize,
        encoding,
        encodingConfidence,
        encodingNotes,
        encodingWarnings,
        parserMode: 'auto'
      });
      detection = result.detection;
      rows = result.rows;
      syncVisibleColumns(result.detection.schema.map((column) => column.name));
      if (selectedRow && !rows.some((row) => row.id === selectedRow?.id)) selectedRow = null;
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'Unknown parser error.';
    }
  }

  function changeEncoding(nextEncoding: EncodingName) {
    encoding = nextEncoding;
    if (currentBuffer) {
      currentText = decodeBuffer(currentBuffer, encoding);
      encodingConfidence = 1;
      encodingNotes = [`Manual override: ${encoding}.`];
      encodingWarnings = [];
      parseCurrent();
    }
  }

  function syncVisibleColumns(nextColumns: string[]) {
    const nextSchemaKey = JSON.stringify(nextColumns);
    const schemaChanged = nextSchemaKey !== schemaKey;
    schemaKey = nextSchemaKey;

    if (nextColumns.length === 0) {
      visibleColumns = [];
      return;
    }

    if (!schemaChanged) {
      visibleColumns = visibleColumns.filter((column) => nextColumns.includes(column));
      return;
    }

    visibleColumns = nextColumns;
  }

  function clearFile() {
    currentBuffer = null;
    currentText = '';
    fileName = '';
    fileSize = 0;
    rows = [];
    detection = null;
    filters = { ...emptyFilters, columnFilters: {} };
    selectedRow = null;
    visibleColumns = [];
    schemaKey = '';
    parseError = '';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /**
   * Index in `filteredRows` of the row before (-1) or after (1) the selection.
   * A selection hidden by filters steps to the nearest shown row in file order.
   */
  function neighbourIndex(
    direction: -1 | 1,
    selected: LogRow | null,
    position: number,
    shown: LogRow[],
    order: Map<string, number>
  ): number {
    if (!selected) return -1;
    if (position >= 0) {
      const next = position + direction;
      return next >= 0 && next < shown.length ? next : -1;
    }
    const selectedOrder = order.get(selected.id) ?? -1;
    if (direction === 1) return shown.findIndex((row) => (order.get(row.id) ?? -1) > selectedOrder);
    return shown.findLastIndex((row) => (order.get(row.id) ?? -1) < selectedOrder);
  }

  function rowElement(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(id)}"]`);
  }

  async function step(direction: -1 | 1) {
    const index = neighbourIndex(direction, selectedRow, selectedPosition, filteredRows, rowOrder);
    if (index === -1) return;
    const focusWasOnRow = document.activeElement?.matches('tr[data-row-id]') ?? false;
    selectedRow = filteredRows[index];
    await tick();
    const element = rowElement(selectedRow.id);
    if (!element) return;
    if (focusWasOnRow) element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest' });
  }

  async function closeInspector(returnFocus = true) {
    const id = selectedRow?.id;
    selectedRow = null;
    if (!id || !returnFocus) return;
    await tick();
    rowElement(id)?.focus();
  }

  function handleKeyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'SELECT' ||
      target?.isContentEditable;
    const modified = event.metaKey || event.ctrlKey || event.altKey;

    if (event.key === '/' && !typing && hasFile) {
      event.preventDefault();
      document.getElementById('search-input')?.focus();
    }

    if (selectedRow && !typing && !modified && !event.defaultPrevented) {
      const direction = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
      if (direction !== 0) {
        event.preventDefault();
        step(direction);
        return;
      }
    }

    if (event.key === 'Escape') {
      if (selectedRow) closeInspector(!typing);
      else if (filtersOpen) filtersOpen = false;
    }
  }
</script>

<svelte:head>
  <title>{fileName ? `${fileName} · mullog` : 'mullog'}</title>
</svelte:head>

{#if !hasFile}
  <div class="empty-shell">
    <div class="empty-card">
      <h1>mullog</h1>
      <p class="lede">Local CSV &amp; log inspector. Files never leave your browser.</p>
      <FileDropzone on:files={handleFiles} />
      <div class="empty-foot">Supports .csv, .tsv, .log, .txt — UTF-8, Windows-1252, and ISO-8859-1.</div>
    </div>
  </div>
{:else}
  <div class="app-shell">
    <header class="toolbar">
      <div class="file-block">
        <div class="file-name" title={fileName}>{fileName}</div>
        <div class="file-meta">{formatSize(fileSize)} · {rows.length.toLocaleString()} rows</div>
      </div>

      <div class="toolbar-actions">
        <button class="btn ghost mobile-only" type="button" on:click={() => (filtersOpen = true)} aria-label="Open filters">
          ☰
        </button>

        <span class="row-count-pill"><b>{filteredRows.length.toLocaleString()}</b> shown</span>

        <select
          class="select"
          value={encoding}
          on:change={(event) => changeEncoding((event.currentTarget as HTMLSelectElement).value as EncodingName)}
          title="Encoding"
        >
          {#each encodings as item}
            <option value={item}>{item}</option>
          {/each}
        </select>

        <DetectionPanel {detection} />
        <ExportButton rows={filteredRows} fileName={exportName} />
        <button class="btn ghost" type="button" on:click={clearFile} title="Load another file">New file</button>
      </div>
    </header>

    {#if parseError}
      <div class="parse-error"><strong>Parser error:</strong> {parseError}</div>
    {/if}

    <div class="main" class:inspecting={selectedRow !== null}>
      {#if filtersOpen}
        <button class="scrim open mobile-only" aria-label="Close filters" on:click={() => (filtersOpen = false)}></button>
      {/if}

      <FilterRail
        {filters}
        {facets}
        {tableColumns}
        {visibleColumns}
        open={filtersOpen}
        on:change={(event) => (filters = event.detail)}
        on:columnsChange={(event) => (visibleColumns = event.detail)}
        on:close={() => (filtersOpen = false)}
      />

      <section class="table-region" aria-label="Log rows">
        {#if activeTokens.length > 0}
          <div class="active-filters">
            {#each activeTokens as token}
              <button class="chip" on:click={() => (filters = clearFilterToken(filters, token))}>
                <span>{token}</span>
                <span class="x">×</span>
              </button>
            {/each}
          </div>
        {/if}

        <LogTable
          rows={filteredRows}
          columns={tableColumns}
          {visibleColumns}
          {timestampColumn}
          selectedId={selectedRow?.id ?? ''}
          on:select={(event) => (selectedRow = event.detail)}
        />
      </section>

      <RowInspector
        row={selectedRow}
        position={selectedPosition}
        total={filteredRows.length}
        {canPrev}
        {canNext}
        on:prev={() => step(-1)}
        on:next={() => step(1)}
        on:close={() => closeInspector()}
      />
    </div>
  </div>
{/if}

<style>
  .scrim {
    border: none;
    padding: 0;
  }
</style>
