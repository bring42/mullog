<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { LogRow } from '$lib/types';

  export let row: LogRow | null = null;
  const dispatch = createEventDispatcher<{ close: void }>();
</script>

{#if row}
  <aside class="row-inspector" aria-label="Selected row inspector">
    <header>
      <div>
        <p class="label">SELECTED ROW INSPECTOR</p>
        <h2>LINE {row.lineNumber}</h2>
      </div>
      <button class="machine-button secondary" on:click={() => dispatch('close')}>ESC CLOSE</button>
    </header>

    <section>
      <h3>RAW LINE</h3>
      <pre>{row.rawLine}</pre>
    </section>

    <section class="inspector-grid">
      <div>
        <h3>PARSED CONTROL FIELDS</h3>
        <dl class="machine-list">
          <div><dt>TIME</dt><dd>{row.timestamp ?? 'not detected'}</dd></div>
          <div><dt>RAW TIME</dt><dd>{row.timestampRaw ?? 'not detected'}</dd></div>
          <div><dt>SEVERITY</dt><dd>{row.severity}</dd></div>
          <div><dt>CATEGORY</dt><dd>{row.category}</dd></div>
        </dl>
      </div>

      <div>
        <h3>DETECTION NOTES</h3>
        {#if row.notes.length > 0}
          <ul class="note-list">
            {#each row.notes as note}
              <li>{note}</li>
            {/each}
          </ul>
        {:else}
          <p class="muted">No row-specific notes emitted.</p>
        {/if}
      </div>
    </section>

    <section>
      <h3>PARSED FIELDS</h3>
      <div class="field-grid">
        {#each Object.entries(row.fields) as [key, value]}
          <div>
            <span>{key}</span>
            <code>{value}</code>
          </div>
        {/each}
      </div>
    </section>
  </aside>
{/if}
