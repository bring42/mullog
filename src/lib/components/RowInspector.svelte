<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import type { LogRow } from '$lib/types';

  export let row: LogRow | null = null;
  /** Zero-based position of `row` in the rows currently shown, or -1 when filters hide it. */
  export let position = -1;
  /** Number of rows currently shown. */
  export let total = 0;
  export let canPrev = false;
  export let canNext = false;

  const dispatch = createEventDispatcher<{ close: void; prev: void; next: void }>();

  const MOBILE_QUERY = '(max-width: 800px)';
  const WIDTH_KEY = 'mullog.inspectorWidth';
  const MIN_WIDTH = 320;
  const DEFAULT_WIDTH = 420;

  let sheet: HTMLElement;
  let closeButton: HTMLButtonElement;
  let mobile = false;
  let width = DEFAULT_WIDTH;
  let wasOpenAsDialog = false;

  $: open = row !== null;
  $: hidden = open && position < 0;
  $: asDialog = open && mobile;
  $: if (asDialog !== wasOpenAsDialog) {
    wasOpenAsDialog = asDialog;
    if (asDialog) focusDialog();
  }

  onMount(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => (mobile = query.matches);
    sync();
    query.addEventListener('change', sync);

    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      if (stored) width = clampWidth(stored);
    } catch {
      // Storage unavailable; keep the default width.
    }

    return () => query.removeEventListener('change', sync);
  });

  async function focusDialog() {
    await tick();
    closeButton?.focus();
  }

  function maxWidth(): number {
    return Math.max(MIN_WIDTH, Math.min(760, Math.round(window.innerWidth * 0.6)));
  }

  function clampWidth(value: number): number {
    return Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, value)));
  }

  function persistWidth() {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Ignore storage failures; the width just won't be remembered.
    }
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;

    const move = (moveEvent: PointerEvent) => {
      width = clampWidth(startWidth + (startX - moveEvent.clientX));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-inspector');
      persistWidth();
    };

    document.body.classList.add('resizing-inspector');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function resizeWithKeys(event: KeyboardEvent) {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === 'ArrowLeft') width = clampWidth(width + step);
    else if (event.key === 'ArrowRight') width = clampWidth(width - step);
    else if (event.key === 'Home') width = clampWidth(maxWidth());
    else if (event.key === 'End') width = MIN_WIDTH;
    else return;
    event.preventDefault();
    event.stopPropagation();
    persistWidth();
  }

  /** Keep Tab inside the sheet while it is a modal dialog. */
  function trapFocus(event: KeyboardEvent) {
    if (!asDialog || event.key !== 'Tab') return;
    const focusable = [
      ...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
    ].filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

{#if open}
  <button class="scrim open mobile-only" tabindex="-1" aria-label="Close row inspector" on:click={() => dispatch('close')}></button>
{/if}

<aside
  bind:this={sheet}
  class="row-sheet"
  class:open
  style:--inspector-width="{width}px"
  role={asDialog ? 'dialog' : 'complementary'}
  aria-modal={asDialog ? 'true' : undefined}
  aria-labelledby="row-inspector-title"
  inert={!open}
  on:keydown={trapFocus}
>
  {#if open && !mobile}
    <!-- A focusable separator with a value is the ARIA window-splitter pattern. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize row inspector"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabindex="0"
      on:pointerdown={startResize}
      on:keydown={resizeWithKeys}
    ></div>
  {/if}

  {#if row}
    <header>
      <div class="title-block">
        <h2 id="row-inspector-title">Line {row.lineNumber}</h2>
        {#if row.timestampRaw}
          <div class="sub">{row.timestampRaw}</div>
        {/if}
      </div>
      <div class="sheet-actions">
        <span class="position" aria-live="polite">
          {#if hidden}
            Not among {total.toLocaleString()} shown
          {:else}
            Row {(position + 1).toLocaleString()} of {total.toLocaleString()} shown
          {/if}
        </span>
        <button
          class="btn ghost icon"
          type="button"
          on:click={() => dispatch('prev')}
          disabled={!canPrev}
          aria-label="Previous row"
          aria-keyshortcuts="ArrowUp K"
          title="Previous row (↑ or k)">↑</button
        >
        <button
          class="btn ghost icon"
          type="button"
          on:click={() => dispatch('next')}
          disabled={!canNext}
          aria-label="Next row"
          aria-keyshortcuts="ArrowDown J"
          title="Next row (↓ or j)">↓</button
        >
        <button
          bind:this={closeButton}
          class="btn ghost icon"
          type="button"
          on:click={() => dispatch('close')}
          aria-label="Close row inspector"
          aria-keyshortcuts="Escape"
          title="Close (Esc)">✕</button
        >
      </div>
    </header>

    {#if hidden}
      <p class="hidden-note">This row is hidden by the current filters.</p>
    {/if}

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
