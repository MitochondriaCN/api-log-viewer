<script lang="ts">
  // Conversation tab — adapter-driven block timeline.
  //
  // Previous incarnation inlined an extractTurns / contentToText / SSE
  // walker right here in the component. That logic now lives in the
  // per-protocol adapters under lib/adapters/. This component is a thin
  // shell that:
  //   1. Runs the dispatch adapter `adapt(path, trace) -> Block[]`.
  //   2. Delegates rendering, tool folding and pair navigation to
  //      BlockTimeline, shared by single-trace and session views.
  //   3. Provides bulk expand/collapse controls for tool activity.
  //   4. Surfaces a small counts strip at the top (text / reasoning /
  //      tool_call / tool_result / media / error / unknown).
  //   5. Keeps the "include earlier turns from this session" checkbox.
  //      In session mode the loader walks up to 30 sibling traces via
  //      /api/traces?session_root_id=...; each trace gets its own
  //      adapt() pass and the first trace contributes all blocks while
  //      every subsequent trace contributes only its response-side
  //      blocks (the request side is prior history already shown).
  //
  // includeSession + onIncludeSessionToggle are inherited from DetailPanel
  // via TabBodyCtx so the toggle survives tab switches within one trace.

  import { authFetch } from '../../lib/api';
  import { shortId, shortTs } from '../../lib/format';
  import { adapt } from '../../lib/adapters';
  import type { Block } from '../../lib/blocks';
  import { countByType } from '../../lib/blocks';
  import { createLazyScope, parseJsonLazily } from '../../lib/lazyJson';
  import { t } from '../../lib/i18n.svelte';

  import BlockTimeline from '../blocks/BlockTimeline.svelte';

  let conversationRoot: HTMLDivElement;

  function setToolsOpen(open: boolean) {
    conversationRoot?.querySelectorAll<HTMLDetailsElement>('details[data-tool-group]')
      .forEach((group) => { group.open = open; });
  }

  import type { TraceBlob } from '../DetailPanel.svelte';

  // ---------- types ----------

  interface Row {
    id: string;
    path: string;
    session_root_id?: string | null;
    ts_start?: string;
    [k: string]: unknown;
  }

  interface Props {
    row: Row;
    trace: TraceBlob;
    includeSession: boolean;
    onIncludeSessionToggle: (v: boolean) => void;
  }

  const { row, trace, includeSession, onIncludeSessionToggle }: Props = $props();

  // ---------- session-include checkbox state ----------
  //
  // No session_root_id on the row -> checkbox disabled.
  const hasSession = $derived(!!row.session_root_id);

  // ---------- single-trace block timeline ----------

  const singleTraceBlocks = $derived<Block[]>(adapt(row.path, trace));

  // ---------- session transcript loader ----------

  interface SessionEntry {
    traceId: string;
    tsStart: string;
    blocks: Block[];
  }

  type TranscriptState =
    | { kind: 'idle' }
    | { kind: 'loading'; entries: SessionEntry[]; loaded: number; total: number }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; entries: SessionEntry[] };

  let transcript = $state<TranscriptState>({ kind: 'idle' });

  // Bounded concurrency for the sibling-trace fetches. High enough to
  // overlap latency, low enough not to stampede the backend; each
  // trace renders the moment it lands so one big payload never blocks
  // the rest of the conversation.
  const SESSION_FETCH_CONCURRENCY = 4;
  const SESSION_MAX_TRACES = 30;

  $effect(() => {
    if (!includeSession || !row.session_root_id) {
      transcript = { kind: 'idle' };
      return;
    }
    let cancelled = false;
    const scope = createLazyScope();
    const sessionRootId = row.session_root_id;
    transcript = { kind: 'loading', entries: [], loaded: 0, total: 0 };
    (async () => {
      try {
        const r = await authFetch(
          `api/traces?session_root_id=${sessionRootId}&limit=100`,
        );
        const j = await r.json();
        const traceRows: Array<{ id: string; ts_start: string; path: string }> = (
          j.traces || []
        )
          .slice()
          .sort((a: any, b: any) => a.ts_start.localeCompare(b.ts_start))
          .slice(0, SESSION_MAX_TRACES);
        if (cancelled) return;

        const slots: Array<SessionEntry | null> = traceRows.map(() => null);
        let loaded = 0;
        const refresh = () => {
          if (cancelled) return;
          transcript = {
            kind: 'loading',
            entries: slots.filter((e): e is SessionEntry => e !== null),
            loaded,
            total: traceRows.length,
          };
        };

        const loadOne = async (i: number): Promise<void> => {
          const tRow = traceRows[i];
          try {
            const dr = await authFetch(`api/traces/${tRow.id}`);
            if (!dr.ok) return;
            const text = await dr.text();
            const dj = parseJsonLazily(text, scope) as { trace?: TraceBlob };
            const tb = (dj.trace ?? {}) as TraceBlob;
            let entryBlocks = adapt(tRow.path, tb);
            // For non-first traces the request side is prior history we
            // already showed via the first trace; keep response-side blocks
            // only. The first trace contributes its full timeline.
            if (i !== 0) {
              entryBlocks = entryBlocks.filter((b) => b.source.side === 'resp');
            }
            slots[i] = {
              traceId: tRow.id,
              tsStart: tRow.ts_start,
              blocks: entryBlocks,
            };
          } catch {
            /* skip this trace; the gap is visible in the numbering */
          } finally {
            loaded++;
            refresh();
          }
        };

        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(SESSION_FETCH_CONCURRENCY, traceRows.length) }, async () => {
            while (!cancelled) {
              const i = next++;
              if (i >= traceRows.length) return;
              await loadOne(i);
            }
          }),
        );
        if (cancelled) return;
        transcript = {
          kind: 'ready',
          entries: slots.filter((e): e is SessionEntry => e !== null),
        };
      } catch (e: any) {
        if (cancelled) return;
        transcript = { kind: 'error', message: e?.message || String(e) };
      }
    })();
    return () => {
      cancelled = true;
      scope.dispose();
    };
  });

  // ---------- counts strip ----------
  //
  // Sum over the currently rendered blocks (single or session). The
  // count names use the actual Block type strings (text, reasoning,
  // tool_call, tool_result, media, error, unknown) so they line up
  // with lib/blocks.ts countByType.

  const COUNT_ORDER = [
    'text',
    'reasoning',
    'tool_call',
    'tool_result',
    'media',
    'error',
    'unknown',
  ] as const;

  const flatBlocks = $derived.by<Block[]>(() => {
    if (!includeSession || !row.session_root_id) return singleTraceBlocks;
    if (transcript.kind === 'ready' || transcript.kind === 'loading') {
      return transcript.entries.flatMap((e) => e.blocks);
    }
    return [];
  });

  const counts = $derived(countByType(flatBlocks));

</script>

<div class="conversation" bind:this={conversationRoot}>
<div class="convo-controls">
  <label>
    <input
      type="checkbox"
      checked={includeSession}
      onchange={(e) =>
        onIncludeSessionToggle((e.currentTarget as HTMLInputElement).checked)}
      disabled={!hasSession}
    />
    {t('conversation.includeSession', { id: shortId(row.session_root_id) })}
  </label>
  {#if (counts.tool_call || 0) + (counts.tool_result || 0) > 0}
    <div class="tool-controls">
      <button type="button" onclick={() => setToolsOpen(true)}>{t('conversation.expandTools')}</button>
      <button type="button" onclick={() => setToolsOpen(false)}>{t('conversation.collapseTools')}</button>
    </div>
  {/if}
  <div class="counts">
    {#each COUNT_ORDER as kind (kind)}
      {#if (counts[kind] || 0) > 0}
        <span class="count">{counts[kind]} {t(`conversation.count.${kind}`)}</span>
      {/if}
    {/each}
  </div>
</div>

{#if includeSession && hasSession && transcript.kind === 'error'}
  <div class="err">{t('conversation.transcriptFailed', { message: transcript.message })}</div>
{:else if includeSession && hasSession && (transcript.kind === 'loading' || transcript.kind === 'ready')}
  {#if transcript.kind === 'loading'}
    <div class="muted">{t('conversation.transcriptProgress', { n: transcript.loaded, m: transcript.total })}</div>
  {/if}
  {#if transcript.entries.length > 0}
    <div class="blocks">
      {#each transcript.entries as entry, i (entry.traceId)}
        <div class="session-divider">
          {t('conversation.sessionTurn', {
            n: i + 1,
            ts: shortTs(entry.tsStart),
            id: shortId(entry.traceId),
          })}
        </div>
        <BlockTimeline blocks={entry.blocks} scopeId={entry.traceId} />
      {/each}
    </div>
  {/if}
{:else if singleTraceBlocks.length === 0}
  <div class="muted">{t('conversation.empty')}</div>
{:else}
  <div class="blocks">
    {#key row.id}
      <BlockTimeline blocks={singleTraceBlocks} scopeId={row.id} />
    {/key}
  </div>
{/if}
</div>

<style>
  .conversation { min-width: 0; }
  .tool-controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .tool-controls button {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--fg-muted);
    font: inherit;
    padding: 4px 8px;
    cursor: pointer;
  }
  .tool-controls button:hover {
    color: var(--fg);
    background: var(--surface);
  }
  .tool-controls button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .convo-controls {
    margin-bottom: 12px;
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 11px;
  }
  .convo-controls label {
    display: inline-flex;
    gap: 5px;
    align-items: center;
    color: var(--fg-muted);
  }
  .convo-controls input[type='checkbox'] {
    accent-color: var(--accent);
  }
  .counts {
    margin-left: auto;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--fg-dim);
  }
  .count {
    white-space: nowrap;
  }

  .blocks {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 920px;
    min-width: 0;
  }

  .session-divider {
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 0 4px;
    border-bottom: 1px dashed var(--border);
    margin-top: 10px;
  }
  .session-divider:first-child {
    margin-top: 0;
  }

  .muted {
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .err {
    color: var(--err);
    font-family: var(--mono);
    font-size: 12px;
  }
</style>
