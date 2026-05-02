<script lang="ts">
  import { onMount } from 'svelte';
  import FileDropzone from '$lib/components/FileDropzone.svelte';
  import DetectionPanel from '$lib/components/DetectionPanel.svelte';
  import FilterRail from '$lib/components/FilterRail.svelte';
  import LogTable from '$lib/components/LogTable.svelte';
  import RowInspector from '$lib/components/RowInspector.svelte';
  import ExportButton from '$lib/components/ExportButton.svelte';
  import { demoCsv, demoLog } from '$lib/demo';
  import { decodeBuffer, detectEncoding, supportedEncodings } from '$lib/encoding';
  import { applyFilters, buildFacets, clearFilterToken, describeActiveFilters, downloadCsv, emptyFilters } from '$lib/filters';
  import { parseLogText } from '$lib/parser';
  import type { DetectionState, EncodingName, FilterState, LogRow, ParserMode, ParseWarning, ViewMode } from '$lib/types';

  let currentBuffer: ArrayBuffer | null = null;
  let currentText = demoLog;
  let fileName = 'demo-log.txt';
  let fileSize = new Blob([demoLog]).size;
  let encoding: EncodingName = 'utf-8';
  let encodingConfidence = 0.92;
  let encodingNotes = ['Demo text injected as UTF-8. Upload a local file to replace it.'];
  let encodingWarnings: ParseWarning[] = [];
  let parserMode: ParserMode = 'auto';
  let viewMode: ViewMode = 'hybrid';
  let rows: LogRow[] = [];
  let selectedRow: LogRow | null = null;
  let detection: DetectionState | null = null;
  let filters: FilterState = { ...emptyFilters, columnFilters: {} };
  let filterRailOpen = false;
  let parseError = '';

  const encodings = supportedEncodings();
  const parserModes: ParserMode[] = ['auto', 'csv', 'txt'];
  const viewModes: ViewMode[] = ['raw', 'structured', 'hybrid'];

  $: filteredRows = applyFilters(rows, filters);
  $: facets = buildFacets(rows);
  $: activeTokens = describeActiveFilters(filters);
  $: tableColumns = detection?.schema.map((column) => column.name) ?? [];
  $: exportName = `${fileName.replace(/\.[^.]+$/, '') || 'log'}-filtered.csv`;

  onMount(() => {
    parseCurrent();
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
        parserMode
      });
      detection = result.detection;
      rows = result.rows;
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
      encodingNotes = [`Manual encoding override applied: ${encoding}. File was reparsed from the original ArrayBuffer.`];
      encodingWarnings = [];
    } else {
      encodingConfidence = 1;
      encodingNotes = [`Manual encoding override applied to demo text: ${encoding}.`];
      encodingWarnings = [];
    }
    parseCurrent();
  }

  function changeParserMode(nextMode: ParserMode) {
    parserMode = nextMode;
    parseCurrent();
  }

  function loadDemo(kind: 'txt' | 'csv') {
    currentBuffer = null;
    currentText = kind === 'txt' ? demoLog : demoCsv;
    fileName = kind === 'txt' ? 'demo-log.txt' : 'demo-events.csv';
    fileSize = new Blob([currentText]).size;
    encoding = 'utf-8';
    encodingConfidence = 0.92;
    encodingNotes = ['Demo data injected as UTF-8. Upload a local file to replace it.'];
    encodingWarnings = [];
    parserMode = 'auto';
    filters = { ...emptyFilters, columnFilters: {} };
    selectedRow = null;
    parseCurrent();
  }

  function handleKeyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

    if (event.key === '/' && !typing) {
      event.preventDefault();
      document.getElementById('search-input')?.focus();
    }

    if (event.key === 'Escape') {
      selectedRow = null;
      filterRailOpen = false;
    }

    if ((event.key === 'e' || event.key === 'E') && !typing) {
      event.preventDefault();
      if (filteredRows.length > 0) downloadCsv(filteredRows, exportName);
    }
  }
</script>

<svelte:head>
  <title>Log Inspection Workbench</title>
</svelte:head>

<div class="app-shell">
  <header class="command-bar">
    <div class="brand-block">
      <span class="system-mark">LOG//WB</span>
      <div>
        <p class="label">LOCAL TECHNICAL LOG INSPECTION</p>
        <h1>{fileName}</h1>
      </div>
    </div>

    <div class="command-controls">
      <label>
        <span>TYPE</span>
        <output>{detection?.detectedType.toUpperCase() ?? 'UNKNOWN'}</output>
      </label>
      <label>
        <span>ENCODING</span>
        <select class="machine-select" value={encoding} on:change={(event) => changeEncoding((event.currentTarget as HTMLSelectElement).value as EncodingName)}>
          {#each encodings as item}
            <option value={item}>{item}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>PARSER MODE</span>
        <select class="machine-select" value={parserMode} on:change={(event) => changeParserMode((event.currentTarget as HTMLSelectElement).value as ParserMode)}>
          {#each parserModes as item}
            <option value={item}>{item}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>VIEW</span>
        <select class="machine-select" bind:value={viewMode}>
          {#each viewModes as item}
            <option value={item}>{item}</option>
          {/each}
        </select>
      </label>
      <ExportButton rows={filteredRows} fileName={exportName} />
      <button class="machine-button secondary mobile-filter-button" on:click={() => (filterRailOpen = true)}>FILTERS</button>
    </div>
  </header>

  <main class="workbench-grid">
    <section class="left-zone">
      <FileDropzone on:files={handleFiles} />
      <div class="demo-switches">
        <button class="tiny-button" on:click={() => loadDemo('txt')}>LOAD TXT DEMO</button>
        <button class="tiny-button" on:click={() => loadDemo('csv')}>LOAD CSV DEMO</button>
      </div>
      <DetectionPanel {detection} />
      <FilterRail {filters} {facets} {detection} open={filterRailOpen} on:change={(event) => (filters = event.detail)} on:close={() => (filterRailOpen = false)} />
    </section>

    <section class="main-zone">
      {#if parseError}
        <div class="panel parser-error">
          <strong>PARSER ERROR</strong>
          <p>{parseError}</p>
        </div>
      {/if}

      <div class="active-filter-strip" class:empty={activeTokens.length === 0}>
        <span>ACTIVE FILTERS</span>
        {#if activeTokens.length === 0}
          <b>NONE</b>
        {:else}
          {#each activeTokens as token}
            <button on:click={() => (filters = clearFilterToken(filters, token))}>{token} x</button>
          {/each}
        {/if}
      </div>

      <LogTable rows={filteredRows} columns={tableColumns} {viewMode} selectedId={selectedRow?.id ?? ''} on:select={(event) => (selectedRow = event.detail)} />
    </section>
  </main>

  <RowInspector row={selectedRow} on:close={() => (selectedRow = null)} />

  {#if activeTokens.length > 0}
    <ExportButton rows={filteredRows} fileName={exportName} sticky />
  {/if}
</div>
