<script lang="ts">
  import { onMount, tick } from 'svelte';
  import FileDropzone from '$lib/components/FileDropzone.svelte';
  import DetectionPanel from '$lib/components/DetectionPanel.svelte';
  import FilterRail from '$lib/components/FilterRail.svelte';
  import LogTable from '$lib/components/LogTable.svelte';
  import RowInspector from '$lib/components/RowInspector.svelte';
  import ExportButton from '$lib/components/ExportButton.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { decodeBuffer, detectEncoding, supportedEncodings } from '$lib/encoding';
  import {
    applyFilters,
    buildFacets,
    clearFilterToken,
    describeActiveFilters,
    emptyFilters,
    facetColumnsFor,
    filterTokenKey,
    filterTokenLabel
  } from '$lib/filters';
  import { parseLogText, parseSpreadsheet } from '$lib/parser';
  import { firstUsefulSheet, readWorkbook, spreadsheetType, type Workbook } from '$lib/spreadsheet';
  import { decodeHashPayload, hasHashPayload, takePendingShare } from '$lib/share';
  import type { ColumnMeta, DetectionState, EncodingName, FilterState, LogRow, ParseWarning, SpreadsheetType } from '$lib/types';

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
  let loadError = '';
  let schemaKey = '';
  let fileLoaded = false;
  let loadingMessage = '';
  let workbook: Workbook | null = null;
  let workbookType: SpreadsheetType | null = null;
  let sheetIndex = 0;

  const encodings = supportedEncodings();

  $: hasFile = fileLoaded;
  $: filteredRows = applyFilters(rows, filters);
  $: schema = detection?.schema ?? [];
  $: severityColumn = schema.find((column) => column.role === 'severity')?.name;
  $: messageColumn = schema.find((column) => column.role === 'message')?.name;
  $: facets = buildFacets(rows, filters, facetColumnsFor(schema), severityColumn);
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
    window.addEventListener('hashchange', loadFromHash);
    document.addEventListener('paste', handlePasteEvent);
    void loadIncoming();
    return () => {
      window.removeEventListener('keydown', handleKeyboard);
      window.removeEventListener('hashchange', loadFromHash);
      document.removeEventListener('paste', handlePasteEvent);
    };
  });

  /** Picks up files handed over by the OS: share sheet, "Open with", or an iOS Shortcut URL. */
  async function loadIncoming() {
    const params = new URLSearchParams(location.search);
    const shared = params.get('shared');
    if (shared) {
      history.replaceState(history.state, '', location.pathname + location.hash);
      try {
        const pending = shared === '1' ? await takePendingShare() : null;
        if (pending) loadFile(pending.name, pending.buffer);
        else if (shared === 'empty') loadError = 'Nothing was shared — the share contained no file or text.';
        else loadError = 'The shared file could not be opened. Try sharing it again, or open it with the file picker.';
      } catch {
        loadError = 'The shared file could not be read from local storage.';
      }
    }

    if ('launchQueue' in window && window.launchQueue) {
      window.launchQueue.setConsumer(async (launchParams) => {
        const handle = launchParams.files[0];
        if (!handle || handle.kind !== 'file') return;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          loadFile(file.name, await file.arrayBuffer());
        } catch {
          loadError = 'The file could not be opened.';
        }
      });
    }

    await loadFromHash();
  }

  async function loadFromHash() {
    if (!hasHashPayload(location.hash)) return;
    const hash = location.hash;
    // Drop the payload from the address bar and history right away.
    history.replaceState(history.state, '', location.pathname + location.search);
    try {
      const incoming = await decodeHashPayload(hash);
      loadFile(incoming.name, incoming.buffer);
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'The link could not be decoded.';
    }
  }

  async function handleFiles(event: CustomEvent<File[]>) {
    const file = event.detail[0];
    if (!file) return;
    loadFile(file.name, await file.arrayBuffer());
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        loadError = 'The clipboard is empty.';
        return;
      }
      loadText(text);
    } catch {
      loadError = 'Clipboard access was blocked. Press Ctrl/⌘+V on this page instead.';
    }
  }

  function handlePasteEvent(event: ClipboardEvent) {
    if (hasFile) return;
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    loadText(text);
  }

  function loadText(text: string) {
    loadFile('pasted.log', new TextEncoder().encode(text).buffer as ArrayBuffer);
  }

  let loadToken = 0;

  async function loadFile(name: string, buffer: ArrayBuffer) {
    const token = ++loadToken;
    loadError = '';
    parseError = '';
    filters = { ...emptyFilters, columnFilters: {} };
    selectedRow = null;

    const sheetType = spreadsheetType(name, buffer);
    if (sheetType) {
      loadingMessage = `Reading ${name}…`;
      try {
        const book = await readWorkbook(buffer);
        if (token !== loadToken) return;
        currentBuffer = buffer;
        currentText = '';
        fileName = name;
        fileSize = buffer.byteLength;
        workbook = book;
        workbookType = sheetType;
        sheetIndex = firstUsefulSheet(book);
        fileLoaded = true;
        parseCurrent();
      } catch (error) {
        if (token !== loadToken) return;
        loadError = `${name} could not be read as a spreadsheet${error instanceof Error && error.message ? `: ${error.message}` : '.'}`;
      } finally {
        if (token === loadToken) loadingMessage = '';
      }
      return;
    }

    loadingMessage = '';
    workbook = null;
    workbookType = null;
    currentBuffer = buffer;
    fileName = name;
    fileSize = buffer.byteLength;
    const detected = detectEncoding(currentBuffer);
    encoding = detected.encoding;
    encodingConfidence = detected.confidence;
    encodingNotes = detected.notes;
    encodingWarnings = detected.warnings;
    currentText = decodeBuffer(currentBuffer, encoding);
    fileLoaded = true;
    parseCurrent();
  }

  function parseCurrent() {
    try {
      parseError = '';
      const options = {
        fileName,
        fileSize,
        encoding,
        encodingConfidence,
        encodingNotes,
        encodingWarnings,
        parserMode: 'auto' as const
      };
      const result =
        workbook && workbookType
          ? parseSpreadsheet(
              workbook.sheets[sheetIndex] ?? { name: 'Sheet1', rows: [] },
              workbook.sheets.map((sheet) => sheet.name),
              workbookType,
              { ...options, encoding: 'utf-8', encodingConfidence: 1, encodingNotes: ['Cells are read by the spreadsheet reader; no text encoding applies.'], encodingWarnings: [] }
            )
          : parseLogText(currentText, options);
      detection = result.detection;
      rows = result.rows;
      syncVisibleColumns(result.detection.schema);
      if (selectedRow && !rows.some((row) => row.id === selectedRow?.id)) selectedRow = null;
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'Unknown parser error.';
    }
  }

  function changeSheet(index: number) {
    if (!workbook || index === sheetIndex) return;
    sheetIndex = index;
    filters = { ...emptyFilters, columnFilters: {} };
    selectedRow = null;
    parseCurrent();
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

  function syncVisibleColumns(nextSchema: ColumnMeta[]) {
    const nextColumns = nextSchema.map((column) => column.name);
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

    // Line numbers already live in the # column and raw duplicates the parsed fields:
    // hide both by default so the message gets the room. They stay toggleable.
    visibleColumns = nextSchema.filter((column) => column.role !== 'raw' && column.role !== 'lineNumber').map((column) => column.name);
  }

  function clearFile() {
    loadToken += 1;
    fileLoaded = false;
    loadingMessage = '';
    workbook = null;
    workbookType = null;
    sheetIndex = 0;
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
    loadError = '';
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
      <p class="lede">Local log, CSV, Excel &amp; JSON inspector. Files never leave your browser.</p>
      <FileDropzone on:files={handleFiles} />
      <button class="btn ghost paste-btn" type="button" on:click={pasteFromClipboard}>Paste log text</button>
      {#if loadingMessage}
        <div class="loading-line" role="status">{loadingMessage}</div>
      {/if}
      {#if loadError}
        <div class="parse-error load-error" role="alert">{loadError}</div>
      {/if}
      <div class="empty-foot">
        Logs (.log, .txt), CSV/TSV, Excel (.xlsx, .xls), OpenDocument (.ods), JSON and JSON Lines — UTF-8, Windows-1252, and ISO-8859-1.
      </div>
    </div>
  </div>
{:else}
  <div class="app-shell">
    <header class="toolbar">
      <button
        class="btn ghost icon mobile-only"
        type="button"
        on:click={() => (filtersOpen = true)}
        aria-label={activeTokens.length > 0 ? `Open filters, ${activeTokens.length} active` : 'Open filters'}
        aria-expanded={filtersOpen}
        aria-controls="filters-rail"
      >
        <Icon name="filter" size={18} />
        {#if activeTokens.length > 0}<span class="badge" aria-hidden="true">{activeTokens.length}</span>{/if}
      </button>

      <div class="file-block">
        <div class="file-name" title={fileName}>{fileName}</div>
        {#if workbook && workbook.sheets.length > 1}
          <label class="sheet-picker">
            <span class="sr-only">Sheet</span>
            <select
              class="select sheet-select"
              value={sheetIndex}
              on:change={(event) => changeSheet(Number((event.currentTarget as HTMLSelectElement).value))}
            >
              {#each workbook.sheets as sheet, index}
                <option value={index}>{sheet.name} ({Math.max(sheet.rows.length - 1, 0).toLocaleString()} rows)</option>
              {/each}
            </select>
          </label>
        {/if}
        <div class="file-meta desktop-only">{formatSize(fileSize)} · {rows.length.toLocaleString()} rows</div>
        <div class="file-meta mobile-only">
          {#if filteredRows.length === rows.length}
            {rows.length.toLocaleString()} rows
          {:else}
            {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} rows
          {/if}
        </div>
      </div>

      <div class="toolbar-actions">
        <span class="row-count-pill desktop-only"><b>{filteredRows.length.toLocaleString()}</b> shown</span>
        <div class="desktop-only">
          <DetectionPanel {detection} {encoding} encodings={workbook ? [] : encodings} on:encodingChange={(event) => changeEncoding(event.detail)} />
        </div>
        <ExportButton rows={filteredRows} fileName={exportName} />
        <button class="btn ghost desktop-only" type="button" on:click={clearFile} title="Load another file">New file</button>
        <div class="mobile-only">
          <DetectionPanel
            variant="overflow"
            {detection}
            {encoding}
            encodings={workbook ? [] : encodings}
            fileSize={formatSize(fileSize)}
            on:encodingChange={(event) => changeEncoding(event.detail)}
            on:newFile={clearFile}
          />
        </div>
      </div>
    </header>

    {#if parseError}
      <div class="parse-error"><strong>Parser error:</strong> {parseError}</div>
    {/if}
    {#if loadError}
      <div class="parse-error" role="alert">{loadError}</div>
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
        {severityColumn}
        open={filtersOpen}
        on:change={(event) => (filters = event.detail)}
        on:columnsChange={(event) => (visibleColumns = event.detail)}
        on:close={() => (filtersOpen = false)}
      />

      <section class="table-region" aria-label="Log rows">
        {#if activeTokens.length > 0}
          <div class="active-filters" role="group" aria-label="Active filters">
            {#each activeTokens as token (filterTokenKey(token))}
              {@const label = filterTokenLabel(token)}
              <button
                class="chip"
                type="button"
                title="Remove filter"
                aria-label="Remove filter {[label.key, label.value].filter(Boolean).join(' ')}"
                on:click={() => (filters = clearFilterToken(filters, token))}
              >
                <span class="chip-label">{#if label.key}<span class="chip-key">{label.key}</span>{' '}{/if}{label.value}</span>
                <Icon name="close" size={12} />
              </button>
            {/each}
            {#if activeTokens.length >= 2}
              <button class="link-btn" type="button" on:click={() => (filters = { ...emptyFilters, columnFilters: {} })}>Clear all</button>
            {/if}
          </div>
        {/if}

        <LogTable
          rows={filteredRows}
          columns={tableColumns}
          {visibleColumns}
          {timestampColumn}
          {severityColumn}
          {messageColumn}
          search={filters.search}
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

  .paste-btn {
    margin-top: 12px;
    color: var(--text-muted);
  }

  .load-error {
    margin: 14px 0 0;
    text-align: left;
  }
</style>
