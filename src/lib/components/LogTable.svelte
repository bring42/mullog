<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { LogRow, ViewMode } from '$lib/types';

  export let rows: LogRow[] = [];
  export let columns: string[] = [];
  export let viewMode: ViewMode = 'hybrid';
  export let selectedId = '';

  const dispatch = createEventDispatcher<{ select: LogRow }>();

  $: visibleColumns = columns.slice(0, 10);

  function displayTimestamp(row: LogRow): string {
    return row.timestamp ? row.timestamp.replace('T', ' ').replace('.000Z', 'Z') : '';
  }
</script>

<section class="inspection-surface panel" aria-label="Log inspection table">
  <header class="surface-header">
    <div>
      <p class="label">MAIN INSPECTION SURFACE</p>
      <h2>{rows.length.toLocaleString()} ROWS IN CURRENT VIEW</h2>
    </div>
    <div class="view-hint">VIEW: {viewMode.toUpperCase()}</div>
  </header>

  <div class="table-wrap">
    <table class="log-table {viewMode}">
      <thead>
        <tr>
          <th>LINE</th>
          {#if viewMode !== 'raw'}
            <th>TIME</th>
            <th>SEV</th>
            <th>CAT/SRC</th>
          {/if}
          {#if viewMode === 'structured'}
            {#each visibleColumns as column}
              <th>{column}</th>
            {/each}
          {:else}
            <th>RAW / MESSAGE</th>
          {/if}
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
            <td data-label="LINE" class="line-number">{row.lineNumber}</td>
            {#if viewMode !== 'raw'}
              <td data-label="TIME" class="timestamp">{displayTimestamp(row) || '-'}</td>
              <td data-label="SEV"><span class="severity-pill">{row.severity}</span></td>
              <td data-label="CAT/SRC" class="category-cell">{row.category}</td>
            {/if}
            {#if viewMode === 'structured'}
              {#each visibleColumns as column}
                <td data-label={column}>{row.fields[column] ?? ''}</td>
              {/each}
            {:else}
              <td data-label="RAW" class="raw-cell">{viewMode === 'raw' ? row.rawLine : row.fields.message || row.rawLine}</td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
