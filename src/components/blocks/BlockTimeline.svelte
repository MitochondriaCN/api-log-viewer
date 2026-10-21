<script lang="ts">
  import { tick } from 'svelte';
  import type { Block, ToolCallBlock, ToolResultBlock } from '../../lib/blocks';
  import { t } from '../../lib/i18n.svelte';
  import TextBlockComp from './TextBlock.svelte';
  import ReasoningBlockComp from './ReasoningBlock.svelte';
  import ToolCallBlockComp from './ToolCallBlock.svelte';
  import ToolResultBlockComp from './ToolResultBlock.svelte';
  import MediaBlockComp from './MediaBlock.svelte';
  import ErrorBlockComp from './ErrorBlock.svelte';
  import UnknownBlockComp from './UnknownBlock.svelte';

  interface Props {
    blocks: Block[];
    scopeId: string;
  }

  let { blocks, scopeId }: Props = $props();
  let root: HTMLDivElement;

  type ToolBlock = ToolCallBlock | ToolResultBlock;
  interface Entry { block: Block; index: number }
  interface ToolGroup {
    kind: 'tools';
    index: number;
    entries: Entry[];
    calls: number;
    results: number;
    errors: number;
    names: string[];
  }
  type TimelineItem = { kind: 'block'; entry: Entry; index: number } | ToolGroup;

  function isTool(block: Block): block is ToolBlock {
    return block.type === 'tool_call' || block.type === 'tool_result';
  }

  // Group only adjacent tools; never move a message, image or reasoning block.
  const items = $derived.by<TimelineItem[]>(() => {
    const timeline: TimelineItem[] = [];
    let group: ToolGroup | undefined;
    blocks.forEach((block, index) => {
      if (!isTool(block)) {
        group = undefined;
        timeline.push({ kind: 'block', entry: { block, index }, index });
        return;
      }
      if (!group) {
        group = { kind: 'tools', index, entries: [], calls: 0, results: 0, errors: 0, names: [] };
        timeline.push(group);
      }
      group.entries.push({ block, index });
      if (block.type === 'tool_call') group.calls++;
      else {
        group.results++;
        if (block.is_error) group.errors++;
      }
      if (block.tool_name && !group.names.includes(block.tool_name)) group.names.push(block.tool_name);
    });
    return timeline;
  });

  const pairs = $derived.by(() => {
    const calls = new Map<string, number[]>();
    const results = new Map<string, number[]>();
    blocks.forEach((block, index) => {
      if (!isTool(block) || !block.tool_id) return;
      const map = block.type === 'tool_call' ? calls : results;
      const indices = map.get(block.tool_id) ?? [];
      indices.push(index);
      map.set(block.tool_id, indices);
    });
    const targets = new Map<number, number>();
    blocks.forEach((block, index) => {
      if (!isTool(block) || !block.tool_id) return;
      const candidates = (block.type === 'tool_call' ? results : calls).get(block.tool_id);
      if (!candidates?.length) return;
      // Prefer a following result / preceding call when IDs are repeated.
      const directional = candidates.filter((i) => block.type === 'tool_call' ? i > index : i < index);
      const choices = directional.length ? directional : candidates;
      const target = choices.reduce((best, i) => Math.abs(i - index) < Math.abs(best - index) ? i : best);
      targets.set(index, target);
    });
    return targets;
  });

  function domId(index: number): string {
    return `timeline-${encodeURIComponent(scopeId)}-${index}`;
  }

  async function jumpToPair(index: number) {
    const targetIndex = pairs.get(index);
    if (targetIndex === undefined || !root) return;
    const target = root.querySelector<HTMLElement>(`[id="${domId(targetIndex)}"]`);
    if (!target) return;
    const group = target.closest<HTMLDetailsElement>('details[data-tool-group]');
    if (group) group.open = true;
    await tick();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
</script>

{#snippet renderBlock(entry: Entry)}
  {@const block = entry.block}
  {@const targetIndex = pairs.get(entry.index)}
  <div class="block-wrap">
    {#if block.type === 'text'}
      <TextBlockComp {block} />
    {:else if block.type === 'reasoning'}
      <ReasoningBlockComp {block} />
    {:else if block.type === 'tool_call'}
      <ToolCallBlockComp
        {block}
        domId={domId(entry.index)}
        onJumpToPair={targetIndex === undefined ? undefined : () => jumpToPair(entry.index)}
      />
    {:else if block.type === 'tool_result'}
      <ToolResultBlockComp
        {block}
        domId={domId(entry.index)}
        pairDomId={targetIndex === undefined ? undefined : domId(targetIndex)}
        onJumpToPair={targetIndex === undefined ? undefined : () => jumpToPair(entry.index)}
      />
    {:else if block.type === 'media'}
      <MediaBlockComp {block} />
    {:else if block.type === 'error'}
      <ErrorBlockComp {block} />
    {:else}
      <UnknownBlockComp {block} />
    {/if}
  </div>
{/snippet}

<div class="timeline" bind:this={root}>
  {#each items as item (item.index)}
    {#if item.kind === 'tools'}
      <details class="tool-group" data-tool-group>
        <summary>
          <span class="marker" aria-hidden="true">▸</span>
          <span class="group-label">{t('conversation.toolActivity')}</span>
          <span class="group-counts">
            {#if item.calls}{t('conversation.toolCalls', { n: item.calls })}{/if}
            {#if item.calls && item.results} · {/if}
            {#if item.results}{t('conversation.toolResults', { n: item.results })}{/if}
          </span>
          {#if item.errors}
            <span class="error-count">{t('conversation.toolErrors', { n: item.errors })}</span>
          {/if}
          <span class="tool-names" title={item.names.join(', ')}>{item.names.join(', ')}</span>
        </summary>
        <div class="tool-content">
          {#each item.entries as entry (entry.index)}
            {@render renderBlock(entry)}
          {/each}
        </div>
      </details>
    {:else}
      {@render renderBlock(item.entry)}
    {/if}
  {/each}
</div>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .block-wrap { min-width: 0; }
  .block-wrap :global([id]) { scroll-margin-top: 80px; }
  .tool-group {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--fg-muted);
  }
  summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: 10px var(--space-3);
    cursor: pointer;
    list-style: none;
    font-family: var(--sans);
    font-size: 12px;
  }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: var(--surface); }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }
  .marker { transition: transform 120ms ease; }
  .tool-group[open] > summary .marker { transform: rotate(90deg); }
  .group-label { font-weight: 600; }
  .group-counts { font-size: 11px; }
  .tool-names {
    flex: 1 1 140px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
    font-family: var(--mono);
    font-size: 11px;
    text-align: right;
  }
  .error-count { color: var(--err); font-weight: 600; }
  .tool-content {
    border-top: 1px solid var(--border);
    padding: var(--space-2);
  }
  @media (prefers-reduced-motion: reduce) {
    .marker { transition: none; }
  }
</style>
