<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { LogRow } from '$lib/types';

  export let row: LogRow | null = null;
  const dispatch = createEventDispatcher<{ close: void }>();

  $: open = row !== null;
</script>

{#if open}
  <button class="scrim open" aria-label="Close row inspector" on:click={() => dispatch('close')}></button>
{/if}

<aside class="row-sheet" class:open aria-hidden={!open}>
  {#if row}
    <header>
      <div>
        <h2>Row {row.lineNumber}</h2>
        {#if row.timestampRaw}
          <div class="sub">{row.timestampRaw}</div>
        {/if}
      </div>
      <button class="btn ghost" on:click={() => dispatch('close')} aria-label="Close">✕</button>
    </header>

    <div class="body">
      <section>
        <h3>Fields</h3>
        <div class="field-grid">
          {#each Object.entries(row.fields) as [key, value]}
            <div class="k">{key}</div>
            {#if value === ''}
              <div class="v empty">empty</div>
            {:else}
              <div class="v">{value}</div>
            {/if}
          {/each}
        </div>
      </section>

      <section>
        <h3>Raw line</h3>
        <pre class="raw">{row.rawLine}</pre>
      </section>

      {#if row.notes.length > 0}
        <section>
          <h3>Parser notes</h3>
          <ul class="notes-list">
            {#each row.notes as note}
              <li>{note}</li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .scrim {
    border: none;
    padding: 0;
    cursor: pointer;
  }
</style>
