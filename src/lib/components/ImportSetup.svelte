<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { DELIMITERS, LAYOUT_LABELS, delimiterName } from '$lib/layout';
  import type { ImportSettings, LayoutAnalysis, LayoutCandidate, LogRow, ParseResult, PreviewLine, TextLayout } from '$lib/types';

  export let fileName = '';
  export let kind: 'text' | 'sheet' = 'text';
  export let analysis: LayoutAnalysis;
  /** The settings in use now; the dialog edits a copy. */
  export let settings: ImportSettings;
  export let headLines: PreviewLine[] = [];
  export let tailLines: PreviewLine[] = [];
  /** Parses the start of the file with the given settings, for the live preview. */
  export let preview: (settings: ImportSettings) => ParseResult;
  /** First open after loading a file (the setup opened on its own) vs. reopened from the toolbar. */
  export let initial = false;

  const dispatch = createEventDispatcher<{ apply: ImportSettings; close: void }>();
  const unit = kind === 'sheet' ? 'row' : 'line';

  let dialog: HTMLDialogElement;
  let draft: ImportSettings = { ...settings };
  let headerChoice: 'auto' | 'yes' | 'no' = settings.hasHeader === undefined ? 'auto' : settings.hasHeader ? 'yes' : 'no';

  // The draft with the header choice folded in: what the preview shows and Apply uses.
  $: effective = { ...draft, hasHeader: headerChoice === 'auto' ? undefined : headerChoice === 'yes' } satisfies ImportSettings;
  $: lastLine = analysis.totalLines;
  $: firstKept = draft.skipStart + 1;
  $: lastKept = lastLine - draft.skipEnd;

  // Every layout, best fit first; ones the analysis didn't consider go last as "doesn't fit".
  const allLayouts: TextLayout[] = ['freeform', 'delimited', 'json', 'jsonl', 'logfmt', 'access', 'w3c', 'syslog'];
  $: fitting = kind === 'sheet' ? [] : analysis.candidates;
  // Layouts that don't match the sample stay available, folded away, for when detection gets it wrong.
  $: others = (
    kind === 'sheet' ? [] : allLayouts.filter((layout) => !fitting.some((candidate) => candidate.layout === layout))
  ).map((layout): LayoutCandidate => ({ layout, label: LAYOUT_LABELS[layout], confidence: 0, reason: "Doesn't match the sampled lines." }));
  $: choices = [...fitting, ...others];
  let showOthers = false;
  $: if (others.some((choice) => choice.layout === draft.layout)) showOthers = true;

  $: result = safePreview(effective);
  $: shownColumns = (result?.detection.schema ?? []).filter((column) => column.role !== 'raw' && column.role !== 'lineNumber');
  $: previewRows = (result?.rows ?? []).filter((row) => row.rawLine.trim() !== '').slice(0, 8);
  $: sampleRow = pickSample(result?.rows ?? [], analysis.sampleLine);
  $: stats = summarise(result);

  // Per-layout comparison on the same real line further down the file.
  $: comparisons = new Map(
    choices.map((choice) => {
      const parsed = safePreview({ ...effective, layout: choice.layout, delimiter: choice.delimiter ?? effective.delimiter });
      // A layout that fell back to plain lines, or didn't match the sample, has nothing to compare.
      const fellBack = parsed && choice.layout !== 'freeform' && parsed.detection.detectedType === 'txt';
      const row = parsed && !fellBack ? pickSample(parsed.rows, analysis.sampleLine) : undefined;
      return [choice.layout, row && parsed && !row.malformed ? describeRow(row, parsed) : []] as const;
    })
  );

  function safePreview(next: ImportSettings): ParseResult | undefined {
    try {
      return preview(next);
    } catch {
      return undefined;
    }
  }

  function pickSample(rows: LogRow[], line: number | undefined): LogRow | undefined {
    const filled = rows.filter((row) => row.rawLine.trim() !== '');
    if (filled.length === 0) return undefined;
    if (line !== undefined) {
      const exact = filled.find((row) => row.lineNumber <= line && (row.lineEnd ?? row.lineNumber) >= line);
      if (exact) return exact;
      const after = filled.find((row) => row.lineNumber > line);
      if (after) return after;
    }
    return filled[Math.min(filled.length - 1, Math.floor(filled.length / 3))];
  }

  /** The parsed fields of a row, roles first, as short label/value pairs. */
  function describeRow(row: LogRow, parsed: ParseResult): Array<{ name: string; value: string }> {
    const roleOrder = ['timestamp', 'severity', 'category', 'message'];
    const columns = parsed.detection.schema
      .filter((column) => column.role !== 'raw' && column.role !== 'lineNumber')
      .sort((a, b) => rank(a.role) - rank(b.role));
    function rank(role: string | undefined) {
      const index = role ? roleOrder.indexOf(role) : -1;
      return index === -1 ? roleOrder.length : index;
    }
    return columns
      .map((column) => ({ name: column.name, value: row.fields[column.name] ?? '' }))
      .filter((field) => field.value !== '')
      .slice(0, 6);
  }

  function summarise(parsed: ParseResult | undefined) {
    if (!parsed) return undefined;
    const rows = parsed.rows.filter((row) => row.rawLine.trim() !== '');
    const share = (count: number) => (rows.length ? Math.round((count / rows.length) * 100) : 0);
    return {
      columns: parsed.detection.schema.filter((column) => column.role !== 'raw' && column.role !== 'lineNumber').length,
      timestamps: share(rows.filter((row) => row.timestampMs !== undefined).length),
      levels: share(rows.filter((row) => row.severity).length),
      malformed: rows.filter((row) => row.malformed).length
    };
  }

  function fitLabel(confidence: number): { text: string; tone: 'good' | 'maybe' | 'poor' } {
    if (confidence >= 0.8) return { text: 'Good fit', tone: 'good' };
    if (confidence >= 0.5) return { text: 'Possible', tone: 'maybe' };
    return { text: "Doesn't fit", tone: 'poor' };
  }

  function lineState(number: number, text: string): 'skipped' | 'comment' | 'header' | 'data' {
    if (number < firstKept || number > lastKept) return 'skipped';
    if (kind === 'text' && effective.ignoreComments && /^\s*(?:#|\/\/)/.test(text)) return 'comment';
    if (number === headerLine) return 'header';
    return 'data';
  }

  // The line that becomes column names, when the layout has one.
  $: headerLine =
    (kind === 'sheet' || effective.layout === 'delimited') && result?.detection.hasHeader
      ? headLines.find((line) => line.number >= firstKept && line.text.trim() !== '')?.number
      : undefined;

  function setLayout(layout: TextLayout, delimiter?: string) {
    draft = { ...draft, layout, ...(layout === 'delimited' ? { delimiter: delimiter ?? draft.delimiter ?? ',' } : {}) };
  }

  function startAt(number: number) {
    draft = { ...draft, skipStart: number - 1 };
  }

  function endAt(number: number) {
    draft = { ...draft, skipEnd: Math.max(0, lastLine - number) };
  }

  function setNumber(key: 'skipStart' | 'skipEnd', value: string) {
    const parsed = Math.max(0, Math.min(lastLine - 1, Math.floor(Number(value) || 0)));
    draft = { ...draft, [key]: parsed };
  }

  function reset() {
    draft = { ...analysis.suggested };
    headerChoice = draft.hasHeader === undefined ? 'auto' : draft.hasHeader ? 'yes' : 'no';
  }

  function apply() {
    dispatch('apply', { ...effective });
  }

  function onCancel(event: Event) {
    event.preventDefault();
    dispatch('close');
  }

  onMount(async () => {
    dialog.showModal();
    await tick();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  });
</script>

<dialog bind:this={dialog} class="setup" aria-labelledby="setup-title" on:cancel={onCancel}>
  <form method="dialog" class="shell" on:submit|preventDefault={apply}>
    <header class="head">
      <div>
        <h2 id="setup-title">{initial ? 'Check how this file is read' : 'Import settings'}</h2>
        <div class="file" title={fileName}>{fileName}</div>
      </div>
      <button class="btn ghost icon" type="button" aria-label="Close" on:click={() => dispatch('close')}>
        <Icon name="close" size={18} />
      </button>
    </header>

    {#if analysis.reasons.length > 0}
      <ul class="reasons">
        {#each analysis.reasons as reason}
          <li><Icon name="warning" size={14} /> {reason}</li>
        {/each}
      </ul>
    {/if}

    <div class="body">
      <section class="col" aria-labelledby="setup-lines">
        <h3 id="setup-lines">What to read</h3>
        <p class="hint">Click the {unit} where the data starts. Greyed-out {unit}s are left out.</p>

        <div class="range">
          <label>
            <span>Skip first</span>
            <input class="num" type="number" min="0" inputmode="numeric" value={draft.skipStart} on:change={(event) => setNumber('skipStart', event.currentTarget.value)} data-autofocus />
            <span>{unit}s</span>
          </label>
          <label>
            <span>Skip last</span>
            <input class="num" type="number" min="0" inputmode="numeric" value={draft.skipEnd} on:change={(event) => setNumber('skipEnd', event.currentTarget.value)} />
            <span>{unit}s</span>
          </label>
          {#if kind === 'text'}
            <label class="check">
              <input type="checkbox" bind:checked={draft.ignoreComments} />
              <span>Ignore comment lines (<code>#</code>, <code>//</code>)</span>
            </label>
          {/if}
        </div>

        <ol class="lines" aria-label="First {unit}s of the file">
          {#each headLines as line (line.number)}
            {@const state = lineState(line.number, line.text)}
            <li class="line {state}">
              <button
                type="button"
                class="line-btn"
                aria-label="Start at {unit} {line.number}{state === 'skipped' ? ' (now skipped)' : ''}"
                aria-pressed={line.number === firstKept}
                on:click={() => startAt(line.number)}
              >
                <span class="no">{line.number}</span>
                <span class="text">{line.text || ' '}</span>
                {#if state === 'header'}<span class="tag">columns</span>{:else if line.number === firstKept}<span class="tag">start</span>{/if}
              </button>
            </li>
          {/each}
          {#if tailLines.length > 0}
            <li class="gap" aria-hidden="true">⋯</li>
            {#each tailLines as line (line.number)}
              {@const state = lineState(line.number, line.text)}
              <li class="line {state}">
                <button
                  type="button"
                  class="line-btn"
                  aria-label="End at {unit} {line.number}"
                  aria-pressed={line.number === lastKept}
                  on:click={() => endAt(line.number)}
                >
                  <span class="no">{line.number}</span>
                  <span class="text">{line.text || ' '}</span>
                  {#if line.number === lastKept}<span class="tag">end</span>{/if}
                </button>
              </li>
            {/each}
          {/if}
        </ol>
        {#if tailLines.length > 0}<p class="hint">In the last {unit}s, click where the data ends.</p>{/if}
      </section>

      <section class="col" aria-labelledby="setup-layout">
        {#if kind === 'text'}
          <h3 id="setup-layout">How to read each line</h3>
          {#if analysis.sampleLine}
            <p class="hint">Each option shows how it would read {unit} {analysis.sampleLine}, a typical {unit} further down.</p>
          {/if}
          <div class="choices" role="radiogroup" aria-labelledby="setup-layout">
            {#each showOthers ? choices : fitting as choice (choice.layout)}
              {@const fit = fitLabel(choice.confidence)}
              {@const fields = comparisons.get(choice.layout) ?? []}
              <label class="choice" class:selected={draft.layout === choice.layout}>
                <input type="radio" name="layout" value={choice.layout} checked={draft.layout === choice.layout} on:change={() => setLayout(choice.layout, choice.delimiter)} />
                <span class="choice-body">
                  <span class="choice-top">
                    <span class="choice-label">{choice.label}{#if choice.delimiter}{' · '}{delimiterName(choice.delimiter)}{/if}</span>
                    <span class="fit {fit.tone}">{fit.text}</span>
                  </span>
                  <span class="choice-reason">{choice.reason}</span>
                  {#if fields.length > 0}
                    <span class="fields">
                      {#each fields as field}
                        <span class="field"><span class="field-name">{field.name}</span> <span class="field-value">{field.value}</span></span>
                      {/each}
                    </span>
                  {:else if choice.confidence > 0}
                    <span class="choice-reason">Can't read {unit} {analysis.sampleLine ?? ''} this way.</span>
                  {/if}
                </span>
              </label>
            {/each}
          </div>
          {#if others.length > 0}
            <button class="link-btn more" type="button" aria-expanded={showOthers} on:click={() => (showOthers = !showOthers)}>
              {showOthers ? 'Hide' : 'Show'} {others.length} layout{others.length === 1 ? '' : 's'} that don't fit
            </button>
          {/if}
        {:else}
          <h3 id="setup-layout">Table</h3>
        {/if}

        {#if kind === 'sheet' || draft.layout === 'delimited'}
          <div class="options">
            {#if kind === 'text'}
              <label>
                <span>Delimiter</span>
                <select class="select" bind:value={draft.delimiter}>
                  {#each DELIMITERS as delimiter}
                    <option value={delimiter}>{delimiterName(delimiter)}</option>
                  {/each}
                </select>
              </label>
            {/if}
            <label>
              <span>First {unit} has column names</span>
              <select class="select" bind:value={headerChoice}>
                <option value="auto">Detect{result && headerChoice === 'auto' ? ` (${result.detection.hasHeader ? 'yes' : 'no'})` : ''}</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          </div>
        {/if}

        <h3 class="preview-title">Preview</h3>
        {#if stats}
          <p class="stats">
            {stats.columns} column{stats.columns === 1 ? '' : 's'} · timestamps on {stats.timestamps}% · levels on {stats.levels}%{#if stats.malformed > 0} · <span class="warn">{stats.malformed} {unit}{stats.malformed === 1 ? '' : 's'} didn't fit</span>{/if}
          </p>
        {/if}
        {#if result && previewRows.length > 0}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  {#each shownColumns as column}<th scope="col">{column.name}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each previewRows as row (row.id)}
                  <tr class:sample={row === sampleRow} class:bad={row.malformed}>
                    <td class="no">{row.lineNumber}</td>
                    {#each shownColumns as column}<td>{row.fields[column.name] ?? ''}</td>{/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="empty">Nothing to show with these settings.</p>
        {/if}
      </section>
    </div>

    <footer class="foot">
      <button class="link-btn" type="button" on:click={reset}>Reset to detected</button>
      <span class="spacer"></span>
      <button class="btn" type="button" on:click={() => dispatch('close')}>{initial ? 'Keep as detected' : 'Cancel'}</button>
      <button class="btn primary" type="submit">Apply</button>
    </footer>
  </form>
</dialog>

<style>
  .setup {
    width: min(1100px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-3);
  }
  .setup::backdrop {
    background: var(--scrim);
  }
  .shell {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 34px);
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 20px 8px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .file {
    color: var(--text-muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reasons {
    list-style: none;
    margin: 0 20px 8px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--text);
    font-size: 13px;
  }
  .reasons li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .reasons :global(.icon) {
    color: var(--warn);
    flex: none;
    position: relative;
    top: 2px;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 20px;
    padding: 4px 20px 12px;
    overflow: auto;
    min-height: 0;
  }
  .col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h3 {
    margin: 4px 0 0;
    font-size: 14px;
  }
  .preview-title {
    margin-top: 12px;
  }
  .hint,
  .stats,
  .empty {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .stats .warn {
    color: var(--warn);
  }
  .range,
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    font-size: 13px;
  }
  .range label,
  .options label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .num {
    width: 72px;
    min-height: 36px;
    padding: 4px 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .lines {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: 12px;
    max-height: 420px;
    overflow: auto;
  }
  .line-btn {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 2px 8px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    min-height: 24px;
  }
  .line-btn:hover {
    background: var(--bg-row-hover);
  }
  .line-btn:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .no {
    flex: none;
    min-width: 3ch;
    text-align: right;
    color: var(--text-faint);
  }
  .text {
    flex: 1;
    min-width: 0;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .line.skipped .text,
  .line.comment .text {
    color: var(--text-faint);
    text-decoration: line-through;
    text-decoration-color: var(--border-strong);
  }
  .line.header .text {
    font-weight: 600;
  }
  .tag {
    flex: none;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-family: var(--font-sans);
    font-size: 11px;
  }
  .gap {
    padding: 2px 8px;
    color: var(--text-faint);
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 340px;
    overflow: auto;
  }
  .more {
    align-self: flex-start;
    font-size: 12px;
  }
  .choice {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .choice.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .choice input {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .choice-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .choice-top {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .choice-reason {
    font-size: 12px;
    color: var(--text-muted);
  }
  .fit {
    flex: none;
    font-size: 11px;
    font-weight: 500;
    padding: 0 6px;
    border-radius: 999px;
  }
  .fit.good {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .fit.maybe {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .fit.poor {
    color: var(--text-faint);
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .field {
    max-width: 100%;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field-name {
    color: var(--text-muted);
  }
  .field-value {
    font-family: var(--font-mono);
  }
  .table-wrap {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    max-height: 260px;
  }
  table {
    border-collapse: collapse;
    font-size: 12px;
    width: max-content;
    min-width: 100%;
  }
  th,
  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--bg-muted);
    font-weight: 600;
  }
  td.no {
    color: var(--text-faint);
  }
  tr.sample td {
    background: var(--bg-row-selected);
  }
  tr.bad td {
    background: var(--row-warn);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  @media (max-width: 800px) {
    .setup {
      width: 100vw;
      max-width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      margin: 0;
      border-radius: 0;
    }
    .shell {
      height: 100%;
      max-height: 100dvh;
    }
    .head,
    .body,
    .foot {
      padding-left: 16px;
      padding-right: 16px;
    }
    .reasons {
      margin-left: 16px;
      margin-right: 16px;
    }
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
    .lines {
      max-height: 260px;
    }
    .foot {
      flex-wrap: wrap;
    }
  }
</style>
