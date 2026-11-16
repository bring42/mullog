<script lang="ts">
  import { onMount, tick } from 'svelte';
  import FileDropzone from '$lib/components/FileDropzone.svelte';
  import DetectionPanel from '$lib/components/DetectionPanel.svelte';
  import FilterRail from '$lib/components/FilterRail.svelte';
  import LogTable from '$lib/components/LogTable.svelte';
  import RowInspector from '$lib/components/RowInspector.svelte';
  import ExportButton from '$lib/components/ExportButton.svelte';
  import ImportSetup from '$lib/components/ImportSetup.svelte';
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
  import { parseLogText, parseSpreadsheet, splitLines } from '$lib/parser';
  import { analyseSheetRows, analyseText } from '$lib/layout';
  import { gunzip, gunzippedName, isGzip, isTarArchive } from '$lib/compression';
  import { firstUsefulSheet, readWorkbook, spreadsheetType, type Workbook } from '$lib/spreadsheet';
  import { decodeHashPayload, hasHashPayload, takePendingShare } from '$lib/share';
  import type {
    ColumnMeta,
    DetectionState,
    EncodingName,
    FilterState,
    ImportSettings,
    LayoutAnalysis,
    LogRow,
    ParseResult,
    ParseWarning,
    PreviewLine,
    SpreadsheetType
  } from '$lib/types';

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
  let logTable: LogTable | undefined;
  /** How the current file (or sheet) is laid out, and the settings it is read with. */
  let analysis: LayoutAnalysis | null = null;
  let importSettings: ImportSettings | null = null;
  let setupOpen = false;
  /** The setup opened on its own after loading, rather than from the toolbar. */
  let setupInitial = false;
  let setupLines: string[] = [];
  /** The last whole-file JSON parse for the setup preview. */
  let jsonPreview: { key: string; result: ParseResult } | null = null;
  /** True once the user applied their own import settings; detection then stops replacing them. */
  let settingsCustomised = false;
  /** Where focus goes back to when the setup closes. */
  let setupReturnFocus: HTMLElement | null = null;
  let headLines: PreviewLine[] = [];
  let tailLines: PreviewLine[] = [];

  /** Lines shown in the setup's line picker. */
  const HEAD_PREVIEW = 120;
  const TAIL_PREVIEW = 12;
  /** Lines parsed for the setup's live preview. */
  const PREVIEW_LINES = 400;

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
  $: exportName = `${fileName.replace(/\.[^.]+$/, '') || 'log'}-filtered`;
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
    setupOpen = false;

    if (isTarArchive(name, buffer)) {
      loadingMessage = '';
      loadError = `${name} is a tar archive with several files inside. Extract it first, then open the log you want.`;
      return;
    }

    if (isGzip(name, buffer)) {
      loadingMessage = `Decompressing ${name}…`;
      try {
        const inner = await gunzip(buffer);
        if (token !== loadToken) return;
        loadingMessage = '';
        return loadFile(gunzippedName(name), inner);
      } catch (error) {
        if (token !== loadToken) return;
        loadingMessage = '';
        loadError = `${name} could not be decompressed${error instanceof Error && error.message ? `: ${error.message}` : '.'}`;
        return;
      }
    }

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
        analyseCurrent();
        parseCurrent();
        openSetupIfUnclear();
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
    analyseCurrent();
    parseCurrent();
    openSetupIfUnclear();
  }

  function currentSheet() {
    return workbook?.sheets[sheetIndex] ?? { name: 'Sheet1', rows: [] };
  }

  function sheetRowNumbers(sheet: { rows: string[][]; rowNumbers?: number[] }): number[] {
    return sheet.rows.map((_, index) => sheet.rowNumbers?.[index] ?? index + 1);
  }

  function analyseCurrent(keepCustom = false) {
    if (workbook) {
      const sheet = currentSheet();
      analysis = analyseSheetRows(sheet.rows, sheetRowNumbers(sheet));
    } else {
      analysis = analyseText(currentText, { fileName });
    }
    if (keepCustom && settingsCustomised && importSettings) return;
    importSettings = analysis.suggested;
    settingsCustomised = false;
  }

  function openSetupIfUnclear() {
    if (analysis?.unclear && !parseError) openSetup(true);
  }

  function openSetup(initial = false) {
    if (!analysis) analyseCurrent();
    if (!analysis) return;
    if (workbook) {
      const sheet = currentSheet();
      const numbers = sheetRowNumbers(sheet);
      const asLine = (index: number): PreviewLine => ({ number: numbers[index], text: sheet.rows[index].join('  │  ').replace(/(\s+│\s+)+$/, '') });
      headLines = sheet.rows.slice(0, HEAD_PREVIEW).map((_, index) => asLine(index));
      const tailStart = Math.max(HEAD_PREVIEW, sheet.rows.length - TAIL_PREVIEW);
      tailLines = sheet.rows.slice(tailStart).map((_, index) => asLine(tailStart + index));
    } else {
      setupLines = splitLines(currentText);
      if (setupLines.length > 1 && setupLines[setupLines.length - 1] === '') setupLines.pop();
      headLines = setupLines.slice(0, HEAD_PREVIEW).map((text, index) => ({ number: index + 1, text }));
      const tailStart = Math.max(HEAD_PREVIEW, setupLines.length - TAIL_PREVIEW);
      tailLines = setupLines.slice(tailStart).map((text, index) => ({ number: tailStart + index + 1, text }));
    }
    setupInitial = initial;
    setupReturnFocus = initial ? null : (document.activeElement as HTMLElement | null);
    setupOpen = true;
  }

  async function closeSetup() {
    if (!setupOpen) return;
    setupOpen = false;
    setupLines = [];
    jsonPreview = null;
    const target = setupReturnFocus;
    setupReturnFocus = null;
    await tick();
    if (target?.isConnected) target.focus();
  }

  function applySettings(next: ImportSettings) {
    importSettings = next;
    settingsCustomised = true;
    filters = { ...emptyFilters, columnFilters: {} };
    selectedRow = null;
    closeSetup();
    parseCurrent();
  }

  /** Parses just the start of the file, for the setup's live preview. */
  function previewParse(settings: ImportSettings): ParseResult {
    const options = parseOptions();
    if (workbook && workbookType) {
      const sheet = currentSheet();
      const numbers = sheetRowNumbers(sheet);
      const lastRow = numbers[numbers.length - 1] ?? 0;
      const count = numbers.filter((number) => number <= settings.skipStart).length + PREVIEW_LINES;
      const rows = sheet.rows.slice(0, count);
      const sliceLast = numbers[rows.length - 1] ?? 0;
      return parseSpreadsheet({ name: sheet.name, rows, rowNumbers: numbers.slice(0, rows.length) }, [], workbookType, {
        ...sheetOptions(options),
        settings: { ...settings, skipEnd: Math.max(0, sliceLast - (lastRow - settings.skipEnd)) }
      });
    }
    // A JSON document only parses whole, so only when the file can plausibly be one, and once per
    // set of settings. Otherwise the start of the file shows that it doesn't read as JSON.
    if (settings.layout === 'json' && analysis?.candidates.some((candidate) => candidate.layout === 'json' && candidate.confidence >= 0.5)) {
      const key = JSON.stringify(settings);
      if (jsonPreview?.key !== key) jsonPreview = { key, result: parseLogText(currentText, { ...options, settings }) };
      return jsonPreview.result;
    }
    const lines = setupLines.slice(0, settings.skipStart + PREVIEW_LINES);
    const skipEnd = Math.max(0, lines.length - (setupLines.length - settings.skipEnd));
    return parseLogText(lines.join('\n'), { ...options, settings: { ...settings, skipEnd } });
  }

  function parseOptions() {
    return {
      fileName,
      fileSize,
      encoding,
      encodingConfidence,
      encodingNotes,
      encodingWarnings,
      parserMode: 'auto' as const,
      settings: importSettings ?? undefined
    };
  }

  function sheetOptions<T extends ReturnType<typeof parseOptions>>(options: T): T {
    return {
      ...options,
      encoding: 'utf-8',
      encodingConfidence: 1,
      encodingNotes: ['Cells are read by the spreadsheet reader; no text encoding applies.'],
      encodingWarnings: []
    };
  }

  function parseCurrent() {
    try {
      parseError = '';
      const options = parseOptions();
      const result =
        workbook && workbookType
          ? parseSpreadsheet(
              currentSheet(),
              workbook.sheets.map((sheet) => sheet.name),
              workbookType,
              sheetOptions(options)
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
    analyseCurrent();
    parseCurrent();
    openSetupIfUnclear();
  }

  function changeEncoding(nextEncoding: EncodingName) {
    encoding = nextEncoding;
    if (currentBuffer) {
      currentText = decodeBuffer(currentBuffer, encoding);
      encodingConfidence = 1;
      encodingNotes = [`Manual override: ${encoding}.`];
      encodingWarnings = [];
      // Detection on the wrongly decoded text may have been off; settings the user chose stay.
      analyseCurrent(true);
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
    analysis = null;
    importSettings = null;
    closeSetup();
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
    const focusWasOnRow = logTable?.rowHasFocus() ?? document.activeElement?.matches('tr[data-row-id]') ?? false;
    selectedRow = filteredRows[index];
    await tick();
    // The table only renders rows near the viewport, so bring the row into range first.
    await logTable?.reveal(selectedRow.id);
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
    await logTable?.reveal(id);
    rowElement(id)?.focus();
  }

  function handleKeyboard(event: KeyboardEvent) {
    // The import setup is a modal dialog with its own keys.
    if (setupOpen) return;
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
        Logs (.log, .txt, syslog, access logs, IIS/W3C, logfmt), CSV/TSV, Excel (.xlsx, .xls), OpenDocument (.ods), JSON and JSON Lines, also gzipped (.gz) — UTF-8, Windows-1252, and ISO-8859-1.
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
          <DetectionPanel
            {detection}
            {encoding}
            encodings={workbook ? [] : encodings}
            on:encodingChange={(event) => changeEncoding(event.detail)}
            on:setup={() => openSetup()}
          />
        </div>
        <button class="btn ghost desktop-only" type="button" on:click={() => openSetup()} title="Choose which lines to read and how">
          <Icon name="sliders" size={16} />
          Import
        </button>
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
            on:setup={() => openSetup()}
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

        {#if rows.length === 0 && !parseError}
          <div class="no-rows" role="status">
            <p>No rows with the current import settings.</p>
            <button class="btn" type="button" on:click={() => openSetup()}>
              <Icon name="sliders" size={16} />
              Adjust import
            </button>
          </div>
        {/if}

        <LogTable
          bind:this={logTable}
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

      {#if setupOpen && analysis && importSettings}
        <ImportSetup
          {fileName}
          kind={workbook ? 'sheet' : 'text'}
          {analysis}
          settings={importSettings}
          {headLines}
          {tailLines}
          preview={previewParse}
          initial={setupInitial}
          on:apply={(event) => applySettings(event.detail)}
          on:close={closeSetup}
        />
      {/if}

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

  .no-rows {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 16px;
    color: var(--text-muted);
  }

  .no-rows p {
    margin: 0;
  }

  .load-error {
    margin: 14px 0 0;
    text-align: left;
  }
</style>
