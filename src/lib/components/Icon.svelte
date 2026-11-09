<script lang="ts" module>
  export type IconName = 'filter' | 'close' | 'warning' | 'more' | 'arrow-up' | 'arrow-down';
</script>

<script lang="ts">
  /**
   * Small stroke icon drawn in currentColor. Decorative by default (the control around it
   * carries the accessible name); pass `label` when the icon itself conveys meaning.
   */
  export let name: IconName;
  export let size = 16;
  export let label: string | undefined = undefined;
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
  focusable="false"
>
  {#if name === 'filter'}
    <path d="M3.5 5h17l-6.5 7.5V19l-4 1.5v-8z" />
  {:else if name === 'close'}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'warning'}
    <path d="M12 3.8 2.8 19.5h18.4z" />
    <path d="M12 10v4.2" />
    <path d="M12 17.2v.1" />
  {:else if name === 'more'}
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  {:else if name === 'arrow-up'}
    <path d="M12 19V5M6 11l6-6 6 6" />
  {:else if name === 'arrow-down'}
    <path d="M12 5v14M6 13l6 6 6-6" />
  {/if}
</svg>
