<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { highlightSegments } from '$lib/filters';
  import type { LogRow } from '$lib/types';

  export let rows: LogRow[] = [];
  export let columns: string[] = [];
  export let visibleColumns: string[] = [];
  export let timestampColumn: string | undefined = undefined;
  export let severityColumn: string | undefined = undefined;
  export let messageColumn: string | undefined = undefined;
  export let search = '';
  export let selectedId = '';

  const dispatch = createEventDispatcher<{ select: LogRow }>();

  $: orderedColumns = orderColumns(columns, visibleColumns);
  // The message column (when shown) absorbs all remaining width instead of being capped.
  $: flexColumn = messageColumn && orderedColumns.includes(messageColumn) ? messageColumn : undefined;

  /** Timestamp, then severity, then everything else, with the message last so it can fill the row. */
  function orderColumns(all: string[], visible: string[]): string[] {
    const filtered = all.filter((column) => visible.includes(column));
    const lead = [timestampColumn, severityColumn].filter((column): column is string => !!column && filtered.includes(column));
    const tail = messageColumn && filtered.includes(messageColumn) ? [messageColumn] : [];
    return [...lead, ...filtered.filter((column) => !lead.includes(column) && !tail.includes(column)), ...tail];
  }

  function cellValue(row: LogRow, column: string): string {
    const value = row.fields[column] ?? '';
    if (column === timestampColumn && row.timestampRaw) return row.timestampRaw;
    return value;
  }

  function columnClass(column: string): string {
    if (column === timestampColumn) return 'timestamp';
    if (column === severityColumn) return 'severity';
    if (column === flexColumn) return 'message';
    return 'meta';
  }
</script>

<div class="table-scroll">
  {#if rows.length === 0}
    <div class="empty-table">No rows match the current filters.</div>
  {:else}
    <table class="log" class:has-flex={!!flexColumn}>
      <thead>
        <tr>
          <th class="line-num">#</th>
          {#each orderedColumns as column}
            <th class={columnClass(column)}>{column}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr
            class={row.severity ? `sev-${row.severity.toLowerCase()}` : ''}
            class:selected={selectedId === row.id}
            class:malformed={row.malformed}
            tabindex="0"
            on:click={() => dispatch('select', row)}
            on:keydown={(event) => event.key === 'Enter' && dispatch('select', row)}
          >
            <td class="line-num">{row.lineNumber}</td>
            {#each orderedColumns as column}
              {@const value = cellValue(row, column)}
              <td class={columnClass(column)} title={value}>
                {#if column === severityColumn && value}
                  <span class="sev-tag sev-{(row.severity ?? 'other').toLowerCase()}">{value}</span>
                {:else}
                  {#each highlightSegments(value, search, column === flexColumn ? 90 : 24, column === flexColumn ? 40 : 12) as segment}
                    {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                  {/each}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
