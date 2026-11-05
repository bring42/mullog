<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { normaliseSeverity } from '$lib/parser';
  import type { FilterFacets, FilterState } from '$lib/types';

  export let filters: FilterState;
  export let facets: FilterFacets;
  export let tableColumns: string[] = [];
  export let visibleColumns: string[] = [];
  export let open = false;
  export let severityColumn: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ change: FilterState; columnsChange: string[]; close: void }>();

  function setFilters(next: FilterState) {
    dispatch('change', next);
  }

  function toggleColumnFilter(column: string, value: string) {
    const selected = filters.columnFilters[column] ?? [];
    const nextValues = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    setFilters({ ...filters, columnFilters: { ...filters.columnFilters, [column]: nextValues } });
  }

  function toggleVisibleColumn(column: string) {
    const next = visibleColumns.includes(column)
      ? visibleColumns.filter((item) => item !== column)
      : [...visibleColumns, column];
    dispatch('columnsChange', next);
  }
</script>

<aside class="filters" class:open aria-label="Filters">
  <div class="filters-group">
    <div class="group-label">Search</div>
    <input
      id="search-input"
      class="input"
      type="search"
      placeholder="Press / to focus"
      value={filters.search}
      on:input={(event) => setFilters({ ...filters, search: (event.currentTarget as HTMLInputElement).value })}
    />
  </div>

  <div class="filters-group">
    <div class="group-label">Time range</div>
    <div class="date-grid">
      <input
        class="input"
        type="datetime-local"
        aria-label="From"
        value={filters.from}
        on:input={(event) => setFilters({ ...filters, from: (event.currentTarget as HTMLInputElement).value })}
      />
      <input
        class="input"
        type="datetime-local"
        aria-label="To"
        value={filters.to}
        on:input={(event) => setFilters({ ...filters, to: (event.currentTarget as HTMLInputElement).value })}
      />
    </div>
  </div>


  {#each facets.columns as column}
    <details class="facet" open={column.column === severityColumn}>
      <summary>
        {column.column}
        <span class="meta">{column.values.length}</span>
      </summary>
      <div class="facet-body">
        {#each column.values as item}
          {@const checked = (filters.columnFilters[column.column] ?? []).includes(item.value)}
          <label class="facet-row" class:zero={item.count === 0 && !checked}>
            <input type="checkbox" {checked} on:change={() => toggleColumnFilter(column.column, item.value)} />
            {#if column.column === severityColumn}
              <span class="sev-dot sev-{(normaliseSeverity(item.value) ?? 'other').toLowerCase()}" aria-hidden="true"></span>
            {/if}
            <span class="label" title={item.value}>{item.value}</span>
            <span class="count" title="{item.count.toLocaleString()} with current filters, {item.total.toLocaleString()} in file">
              {item.count.toLocaleString()}{#if item.count !== item.total}<span class="of"> / {item.total.toLocaleString()}</span>{/if}
            </span>
          </label>
        {/each}
      </div>
    </details>
  {/each}

  {#if tableColumns.length > 0}
    <details class="facet">
      <summary>
        Columns
        <span class="meta">{visibleColumns.length}/{tableColumns.length}</span>
      </summary>
      <div class="facet-body">
        <div class="columns-toolbar">
          <button type="button" on:click={() => dispatch('columnsChange', tableColumns)}>All</button>
          <button type="button" on:click={() => dispatch('columnsChange', [])}>None</button>
        </div>
        {#each tableColumns as column}
          <label class="facet-row">
            <input type="checkbox" checked={visibleColumns.includes(column)} on:change={() => toggleVisibleColumn(column)} />
            <span class="label">{column}</span>
          </label>
        {/each}
      </div>
    </details>
  {/if}

  <button class="btn ghost mobile-only" on:click={() => dispatch('close')} style="margin-top: 8px;">Close filters</button>
</aside>
