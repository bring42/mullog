<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { DetectionState, EncodingName } from '$lib/types';

  export let detection: DetectionState | null = null;
  export let encoding: EncodingName = 'utf-8';
  export let encodings: EncodingName[] = [];
  /** Shown under the details in the compact (phone) variant, where the toolbar has no room for it. */
  export let fileSize = '';
  /**
   * `summary` shows the detected type on the trigger (desktop toolbar);
   * `overflow` is a ⋯ button that also carries "Load another file" (phone toolbar).
   */
  export let variant: 'summary' | 'overflow' = 'summary';

  const dispatch = createEventDispatcher<{ encodingChange: EncodingName; newFile: void }>();
  const panelId = `detection-panel-${Math.random().toString(36).slice(2, 8)}`;

  let open = false;
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;

  function pct(value?: number): string {
    return `${Math.round((value ?? 0) * 100)}%`;
  }

  function onDocClick(event: MouseEvent) {
    if (!open) return;
    if (container && !container.contains(event.target as Node)) open = false;
  }

  async function close() {
    open = false;
    await tick();
    trigger?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    // Keep the page-level Escape handler from also closing the inspector or filters.
    event.stopPropagation();
    close();
  }

  onMount(() => {
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  });

  $: warningCount = detection?.warnings.length ?? 0;
  $: triggerLabel =
    variant === 'overflow'
      ? `File details and options${warningCount > 0 ? `, ${warningCount} parser warning${warningCount === 1 ? '' : 's'}` : ''}`
      : undefined;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="detection-popover" bind:this={container} on:keydown={onKeydown}>
  <button
    bind:this={trigger}
    class="btn ghost"
    class:icon={variant === 'overflow'}
    type="button"
    on:click={() => (open = !open)}
    aria-expanded={open}
    aria-controls={panelId}
    aria-label={triggerLabel}
    title={variant === 'overflow' ? 'File details' : 'Detection details and encoding'}
  >
    {#if variant === 'overflow'}
      <Icon name="more" size={18} />
      {#if warningCount > 0}<span class="warn-dot" aria-hidden="true"></span>{/if}
    {:else}
      {#if detection}
        {detection.detectedType.toUpperCase()} · {detection.rowCount.toLocaleString()}
      {:else}
        Detection
      {/if}
      {#if warningCount > 0}
        <span class="warn-count">
          <Icon name="warning" size={14} />
          {warningCount}<span class="sr-only"> parser warning{warningCount === 1 ? '' : 's'}</span>
        </span>
      {/if}
    {/if}
  </button>

  {#if open && detection}
    <div class="panel" id={panelId} role="dialog" aria-labelledby="{panelId}-title">
      <h4 id="{panelId}-title">Detection</h4>
      <dl>
        <dt>Rows</dt>
        <dd>{detection.rowCount.toLocaleString()}</dd>
        {#if fileSize}
          <dt>Size</dt>
          <dd>{fileSize}</dd>
        {/if}
        <dt>Type</dt>
        <dd>{detection.detectedType.toUpperCase()}</dd>
        <dt><label for="{panelId}-encoding">Encoding</label></dt>
        <dd class="encoding-row">
          <select
            id="{panelId}-encoding"
            class="select"
            value={encoding}
            on:change={(event) => dispatch('encodingChange', (event.currentTarget as HTMLSelectElement).value as EncodingName)}
          >
            {#each encodings as item}
              <option value={item}>{item}</option>
            {/each}
          </select>
          <span class="confidence">{pct(detection.encodingConfidence)} sure</span>
        </dd>
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
          <Icon name="warning" size={14} />
          <div>
            {warningCount} parser warning{warningCount === 1 ? '' : 's'}.
            {#if detection.warnings[0]}
              <div class="warn-detail">
                {detection.warnings[0].lineNumber ? `L${detection.warnings[0].lineNumber}: ` : ''}{detection.warnings[0].message}
              </div>
            {/if}
          </div>
        </div>
      {/if}
      {#if variant === 'overflow'}
        <button class="btn panel-action" type="button" on:click={() => dispatch('newFile')}>Load another file</button>
      {/if}
    </div>
  {/if}
</div>
