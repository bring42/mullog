<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { DEFAULT_VISIBLE_COLUMNS } from '$lib/constants';
  import type { DetectionState, FilterFacets, FilterState, Severity } from '$lib/types';

  export let filters: FilterState;
  export let facets: FilterFacets;
  export let detection: DetectionState | null = null;
  export let tableColumns: string[] = [];
  export let visibleColumns: string[] = [];
  export let open = false;

  const dispatch = createEventDispatcher<{ change: FilterState; columnsChange: string[]; close: void }>();

  function setFilters(next: FilterState) {
    dispatch('change', next);
  }

  function toggleSeverity(value: Severity) {
    const severities = filters.severities.includes(value)
      ? filters.severities.filter((severity) => severity !== value)
      : [...filters.severities, value];
    setFilters({ ...filters, severities });
  }

  function toggleCategory(value: string) {
    const categories = filters.categories.includes(value)
      ? filters.categories.filter((category) => category !== value)
      : [...filters.categories, value];
    setFilters({ ...filters, categories });
  }

  function toggleColumn(column: string, value: string) {
    const selected = filters.columnFilters[column] ?? [];
    const nextValues = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    setFilters({ ...filters, columnFilters: { ...filters.columnFilters, [column]: nextValues } });
  }

  function setVisibleColumns(nextVisibleColumns: string[]) {
    dispatch('columnsChange', nextVisibleColumns);
  }

  function toggleVisibleColumn(column: string) {
    const nextVisibleColumns = visibleColumns.includes(column)
      ? visibleColumns.filter((item) => item !== column)
      : [...visibleColumns, column];
    setVisibleColumns(nextVisibleColumns);
  }

  $: quickSelectCount = Math.min(DEFAULT_VISIBLE_COLUMNS, tableColumns.length);
</script>

<aside class="filter-rail" class:open aria-label="Filter rail">
  <div class="rail-mobile-handle">
    <button class="tiny-button" on:click={() => dispatch('close')}>CLOSE FILTERS</button>
  </div>

  <details class="panel rail-section" open>
    <summary class="rail-section-summary">
      <span>SEARCH + TIME</span>
      <b>{filters.search || filters.from || filters.to ? 'ACTIVE' : 'IDLE'}</b>
    </summary>
    <div class="rail-section-body search-panel">
      <label class="control-label" for="search-input">FREE TEXT SEARCH</label>
      <input
        id="search-input"
        class="machine-input"
        type="search"
        placeholder="/ TO FOCUS"
        value={filters.search}
        on:input={(event) => setFilters({ ...filters, search: (event.currentTarget as HTMLInputElement).value })}
      />

      <div class="date-grid">
        <label>
          <span>FROM</span>
          <input
            class="machine-input"
            type="datetime-local"
            value={filters.from}
            on:input={(event) => setFilters({ ...filters, from: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label>
          <span>TO</span>
          <input
            class="machine-input"
            type="datetime-local"
            value={filters.to}
            on:input={(event) => setFilters({ ...filters, to: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
      </div>
    </div>
  </details>

  {#if tableColumns.length > 0}
    <details class="panel rail-section" open>
      <summary class="rail-section-summary">
        <span>TABLE COLUMNS</span>
        <b>{visibleColumns.length}/{tableColumns.length}</b>
      </summary>
      <div class="rail-section-body">
        <div class="column-visibility-toolbar">
          <button class="tiny-button" type="button" on:click={() => setVisibleColumns(tableColumns)}>ALL</button>
          <button
            class="tiny-button"
            type="button"
            on:click={() => setVisibleColumns(tableColumns.slice(0, quickSelectCount))}
          >
            TOP {quickSelectCount}
          </button>
          <button class="tiny-button" type="button" on:click={() => setVisibleColumns([])}>NONE</button>
        </div>
        <div class="checkbox-stack tall">
          {#each tableColumns as column}
            <label class="check-row">
              <input type="checkbox" checked={visibleColumns.includes(column)} on:change={() => toggleVisibleColumn(column)} />
              <span>{column}</span>
            </label>
          {/each}
        </div>
      </div>
    </details>
  {/if}

  <details class="panel rail-section" open>
    <summary class="rail-section-summary">
      <span>SEVERITY</span>
      <b>{filters.severities.length}</b>
    </summary>
    <div class="rail-section-body checkbox-stack">
      {#each facets.severities as item}
        <label class="check-row severity-{item.value.toLowerCase()}">
          <input type="checkbox" checked={filters.severities.includes(item.value)} on:change={() => toggleSeverity(item.value)} />
          <span>{item.value}</span>
          <b>{item.count}</b>
        </label>
      {/each}
    </div>
  </details>

  <details class="panel rail-section">
    <summary class="rail-section-summary">
      <span>CATEGORY / SOURCE</span>
      <b>{filters.categories.length}</b>
    </summary>
    <div class="rail-section-body">
      <div class="checkbox-stack tall">
        {#each facets.categories as item}
          <label class="check-row">
            <input type="checkbox" checked={filters.categories.includes(item.value)} on:change={() => toggleCategory(item.value)} />
            <span>{item.value}</span>
            <b>{item.count}</b>
          </label>
        {/each}
      </div>
    </div>
  </details>

  {#if facets.columns.length > 0}
    <details class="panel rail-section">
      <summary class="rail-section-summary">
        <span>CSV COLUMN FACETS</span>
        <b>{facets.columns.length}</b>
      </summary>
      <div class="rail-section-body column-facets">
        {#each facets.columns as column}
          <details>
            <summary>{column.column}</summary>
            <div class="checkbox-stack compact">
              {#each column.values as item}
                <label class="check-row">
                  <input
                    type="checkbox"
                    checked={(filters.columnFilters[column.column] ?? []).includes(item.value)}
                    on:change={() => toggleColumn(column.column, item.value)}
                  />
                  <span>{item.value}</span>
                  <b>{item.count}</b>
                </label>
              {/each}
            </div>
          </details>
        {/each}
      </div>
    </details>
  {/if}

  <details class="panel rail-section warnings-panel">
    <summary class="rail-section-summary">
      <span>PARSE WARNINGS</span>
      <b>{detection?.warnings.length ?? 0}</b>
    </summary>
    <div class="rail-section-body">
      {#if detection && detection.warnings.length > 0}
        <div class="warning-list">
          {#each detection.warnings.slice(0, 30) as warning}
            <article class="warning-item {warning.level}">
              <strong>{warning.type}</strong>
              <p>{warning.lineNumber ? `L${warning.lineNumber}: ` : ''}{warning.message}</p>
            </article>
          {/each}
          {#if detection.warnings.length > 30}
            <p class="muted">Showing first 30 warnings.</p>
          {/if}
        </div>
      {:else}
        <p class="muted">No parse warnings emitted.</p>
      {/if}
    </div>
  </details>
</aside>
