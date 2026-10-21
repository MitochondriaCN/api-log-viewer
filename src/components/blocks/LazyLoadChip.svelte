<script lang="ts">
  // LazyLoadChip — "load full text" button shown in place of a text
  // body that is still elided as lazyJson token(s). Click hydrates the
  // string; the owning block then renders the full content through its
  // normal pipeline.

  import { t } from '../../lib/i18n.svelte';

  type Props = {
    approxChars: number;
    onclick: () => void;
  };

  let { approxChars, onclick }: Props = $props();

  function fmt(chars: number): string {
    if (chars < 1024) return `${chars} B`;
    if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
    return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<button type="button" class="lazy-chip mono" {onclick}>
  {t('blocks.loadFullText', { size: fmt(approxChars) })}
</button>

<style>
  .lazy-chip {
    align-self: flex-start;
    font-family: var(--font-mono);
    font-size: var(--size-label);
    line-height: 1;
    padding: 6px 10px;
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .lazy-chip:hover {
    border-color: var(--accent);
  }
  .lazy-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
