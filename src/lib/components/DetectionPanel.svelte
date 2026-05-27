<script lang="ts">
  import type { DetectionState } from '$lib/types';
  import { onMount } from 'svelte';

  export let detection: DetectionState | null = null;

  let open = false;
  let container: HTMLDivElement;

  function pct(value?: number): string {
    return `${Math.round((value ?? 0) * 100)}%`;
  }

  function onDocClick(event: MouseEvent) {
    if (!open) return;
    if (container && !container.contains(event.target as Node)) open = false;
  }

  onMount(() => {
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  });

  $: warningCount = detection?.warnings.length ?? 0;
</script>

<div class="detection-popover" bind:this={container}>
  <button class="btn ghost" type="button" on:click={() => (open = !open)} aria-expanded={open}>
    {#if detection}
      {detection.detectedType.toUpperCase()} · {detection.rowCount.toLocaleString()}
    {:else}
      Detection
    {/if}
    {#if warningCount > 0}
      <span style="color: var(--warn); font-weight: 600;">⚠ {warningCount}</span>
    {/if}
  </button>

  {#if open && detection}
    <div class="panel" role="dialog">
      <h4>Detection</h4>
      <dl>
        <dt>Rows</dt>
        <dd>{detection.rowCount.toLocaleString()}</dd>
        <dt>Type</dt>
        <dd>{detection.detectedType.toUpperCase()}</dd>
        <dt>Encoding</dt>
        <dd>{detection.encoding} ({pct(detection.encodingConfidence)})</dd>
        {#if detection.delimiter}
          <dt>Delimiter</dt>
          <dd>{detection.delimiter} ({pct(detection.delimiterConfidence)})</dd>
        {/if}
        {#if typeof detection.hasHeader === 'boolean'}
          <dt>Header</dt>
          <dd>{detection.hasHeader ? 'present' : 'not detected'}</dd>
        {/if}
        <dt>Timestamp</dt>
        <dd>{detection.timestampFormat ?? 'not detected'}</dd>
      </dl>
      {#if warningCount > 0}
        <div class="warn-line">
          {warningCount} parser warning{warningCount === 1 ? '' : 's'}.
          {#if detection.warnings[0]}
            <div style="margin-top: 4px; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px;">
              {detection.warnings[0].lineNumber ? `L${detection.warnings[0].lineNumber}: ` : ''}{detection.warnings[0].message}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
