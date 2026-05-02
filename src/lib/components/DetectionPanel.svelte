<script lang="ts">
  import type { DetectionState } from '$lib/types';

  export let detection: DetectionState | null = null;

  function pct(value?: number): string {
    return `${Math.round((value ?? 0) * 100)}%`;
  }
</script>

<section class="panel detection-panel" aria-label="Detection summary">
  <header class="panel-header">
    <span>DETECTION SUMMARY</span>
    <span class="status">ASSUMPTIONS VISIBLE</span>
  </header>

  {#if detection}
    <div class="assumption-grid">
      {#each detection.assumptions as assumption}
        <article class="assumption" class:low={assumption.confidence < 0.6}>
          <div class="assumption-top">
            <span>{assumption.label}</span>
            <strong>{pct(assumption.confidence)}</strong>
          </div>
          <p>{assumption.value}</p>
          <meter min="0" max="1" value={assumption.confidence}>{pct(assumption.confidence)}</meter>
        </article>
      {/each}
    </div>

    <dl class="machine-list">
      <div>
        <dt>ROWS</dt>
        <dd>{detection.rowCount.toLocaleString()}</dd>
      </div>
      <div>
        <dt>TYPE</dt>
        <dd>{detection.detectedType.toUpperCase()}</dd>
      </div>
      <div>
        <dt>ENCODING</dt>
        <dd>{detection.encoding} / {pct(detection.encodingConfidence)}</dd>
      </div>
      {#if detection.delimiter}
        <div>
          <dt>DELIMITER</dt>
          <dd>{detection.delimiter} / {pct(detection.delimiterConfidence)}</dd>
        </div>
      {/if}
      {#if typeof detection.hasHeader === 'boolean'}
        <div>
          <dt>HEADER</dt>
          <dd>{detection.hasHeader ? 'YES' : 'NO'}</dd>
        </div>
      {/if}
      <div>
        <dt>TIMESTAMP</dt>
        <dd>{detection.timestampFormat ?? 'NOT DETECTED'}</dd>
      </div>
    </dl>

    <div class="schema-box">
      <h3>SCHEMA / ROLES</h3>
      {#if detection.schema.length === 0}
        <p class="muted">No schema inferred.</p>
      {:else}
        <div class="schema-list">
          {#each detection.schema as column}
            <span title={`${column.uniqueCount} unique / ${column.emptyCount} empty`}>
              {column.name}<em>{column.role ?? column.inferredType}</em>
            </span>
          {/each}
        </div>
      {/if}
    </div>

    <div class="notes-box">
      <h3>ENCODING NOTES</h3>
      {#each detection.encodingNotes as note}
        <p>{note}</p>
      {/each}
    </div>
  {:else}
    <p class="muted">No file parsed yet.</p>
  {/if}
</section>
