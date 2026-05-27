<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { LogRow } from '$lib/types';

  export let rows: LogRow[] = [];
  export let columns: string[] = [];
  export let visibleColumns: string[] = [];
  export let timestampColumn: string | undefined = undefined;
  export let selectedId = '';

  const dispatch = createEventDispatcher<{ select: LogRow }>();

  $: orderedColumns = orderColumns(columns, visibleColumns, timestampColumn);

  function orderColumns(all: string[], visible: string[], timeCol: string | undefined): string[] {
    const filtered = all.filter((column) => visible.includes(column));
    if (timeCol && filtered.includes(timeCol)) {
      return [timeCol, ...filtered.filter((column) => column !== timeCol)];
    }
    return filtered;
  }

  function cellValue(row: LogRow, column: string): string {
    const value = row.fields[column] ?? '';
    if (column === timestampColumn && row.timestampRaw) return row.timestampRaw;
    return value;
  }
</script>

<div class="table-scroll">
  {#if rows.length === 0}
    <div class="empty-table">No rows match the current filters.</div>
  {:else}
    <table class="log">
      <thead>
        <tr>
          <th class="line-num">#</th>
          {#each orderedColumns as column}
            <th class:timestamp={column === timestampColumn}>{column}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr
            class:selected={selectedId === row.id}
            class:malformed={row.malformed}
            tabindex="0"
            on:click={() => dispatch('select', row)}
            on:keydown={(event) => event.key === 'Enter' && dispatch('select', row)}
          >
            <td class="line-num">{row.lineNumber}</td>
            {#each orderedColumns as column}
              <td class:timestamp={column === timestampColumn} title={cellValue(row, column)}>
                {cellValue(row, column)}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
