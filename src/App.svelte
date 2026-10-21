<script lang="ts">
  // App.svelte — top-level shell.
  //
  // Owns the top-level state (view, listMode, selectedId, filter values,
  // datalist suggestion sets, status banner text/kind, auth-modal
  // visibility, pager state) and wires every sibling component together.
  //
  // Routing:
  //   #/                  -> Landing (default)
  //   #/landing           -> Landing
  //   #/dashboard         -> legacy alias, console.warn + replaceState
  //                          to #/landing
  //   #/traces            -> traces list + detail panel
  //   #/traces/<id>       -> traces list + that trace selected
  //   anything else       -> console.warn + fall back to #/landing
  //
  // The boot $effect calls applyHash(); if no hash on first load we
  // explicitly set #/landing so the URL matches the rendered view.
  //
  // What this file is NOT responsible for (lives in sibling components):
  //   - Header markup & CSS                     (components/Header.svelte)
  //   - Default home page                        (components/Landing.svelte)
  //   - Filter sidebar + datalists              (components/FilterSidebar.svelte)
  //   - Traces list table + pager methods       (components/TracesList.svelte)
  //   - Detail head/meta/tabs/loading           (components/DetailPanel.svelte)
  //   - Conversation / overview / raw tab body  (components/tabs/*.svelte)
  //   - Conversation block renderers            (components/blocks/*.svelte)
  //   - Plugins list + edit modal               (components/plugins/*.svelte)
  //   - Export filter + bundle download         (components/Export.svelte)
  //   - Settings page (theme/lang/token/about)  (components/Settings.svelte)
  //   - Cmd+K command palette                   (components/CommandPalette.svelte)
  //   - Auth modal                              (components/AuthModal.svelte)
  //   - Auth/token plumbing                     (lib/api.ts)

  import { tick } from 'svelte';
  import { t } from './lib/i18n.svelte';
  import {
    DEFAULT_PATH_FILTER,
    authFetch,
    getToken,
    registerAuthModalHandler,
  } from './lib/api';

  import Header from './components/Header.svelte';
  import FilterSidebar from './components/FilterSidebar.svelte';
  import type { Filters } from './components/FilterSidebar.svelte';
  import TracesList from './components/TracesList.svelte';
  import DetailPanel from './components/DetailPanel.svelte';
  import type { TabBodyCtx } from './components/DetailPanel.svelte';
  import Landing from './components/Landing.svelte';
  import Export from './components/Export.svelte';
  import Plugins from './components/Plugins.svelte';
  import Settings from './components/Settings.svelte';
  import AuthModal from './components/AuthModal.svelte';
  import CommandPalette from './components/CommandPalette.svelte';

  import ConversationTab from './components/tabs/ConversationTab.svelte';
  import OverviewTab from './components/tabs/OverviewTab.svelte';
  import RawTab from './components/tabs/RawTab.svelte';

  import { getTheme, applyTheme } from './lib/theme.svelte';
  import { bindGlobalShortcut } from './lib/keyboard';

  // ---------- top-level state ----------

  type View = 'landing' | 'traces' | 'plugins' | 'export' | 'settings';

  let view = $state<View>('landing');

  let selectedId = $state<string | null>(null);
  let listScroller = $state<HTMLDivElement | null>(null);
  let savedListScroll = 0;

  function rememberListScroll(event: Event) {
    if (!selectedId) savedListScroll = (event.currentTarget as HTMLDivElement).scrollTop;
  }

  $effect(() => {
    if (!selectedId) {
      void tick().then(() => { if (listScroller) listScroller.scrollTop = savedListScroll; });
    }
  });

  let filters = $state<Filters>({
    status: '',
    path: DEFAULT_PATH_FILTER,
    model: '',
    key_hash: '',
    session_root_id: '',
    since: '',
    limit: '100',
  });

  let knownPaths = $state<Set<string>>(new Set());
  let knownModels = $state<Set<string>>(new Set());
  let knownKeys = $state<Set<string>>(new Set());

  type StatusKind = 'good' | 'bad' | 'warn' | '';
  let statusText = $state<string>('connecting…');
  let statusKind = $state<StatusKind>('');

  function setStatus(text: string, kind: StatusKind = ''): void {
    statusText = text;
    statusKind = kind;
  }

  let authModalOpen = $state<boolean>(false);

  let tracesReloadKey = $state<number>(0);
  let landingReloadKey = $state<number>(0);

  let pagerPrevDisabled = $state<boolean>(true);
  let pagerNextDisabled = $state<boolean>(true);
  let pagerInfo = $state<string>('—');

  let tracesListRef = $state<TracesList | null>(null);

  // ---------- auth modal hook ----------
  registerAuthModalHandler(() => {
    authModalOpen = true;
  });

  // ---------- hash routing ----------
  //
  // KNOWN_VIEWS is the allowlist; anything else logs a warn and falls
  // back to 'landing'. The legacy #/healthz route is gone — the landing
  // page absorbed its content via Landing.svelte's "internal" section.
  //
  // #/dashboard is a legacy alias for #/landing — kept routable so old
  // bookmarks still land somewhere, with a console.warn + replaceState
  // to the canonical route.
  const KNOWN_VIEWS: readonly View[] = ['landing', 'traces', 'plugins', 'export', 'settings'];

  function applyHash(): void {
    const h = window.location.hash;
    // Empty hash / `#` / `#/` all map to landing.
    if (!h || h === '#' || h === '#/') {
      view = 'landing';
      return;
    }
    const parts = h.split('/');
    // Legacy #/dashboard alias → rewrite the URL, then render landing.
    if (parts[1] === 'dashboard') {
      console.warn('[apilog] #/dashboard is deprecated, redirecting to #/landing');
      history.replaceState(null, '', '#/landing');
      view = 'landing';
      return;
    }
    const v = (parts[1] || 'landing') as View;
    if ((KNOWN_VIEWS as readonly string[]).includes(v)) {
      view = v;
    } else {
      console.warn(`[apilog] unknown route ${h}, falling back to #/landing`);
      view = 'landing';
    }
    if (view === 'traces') {
      const id = parts[2] || null;
      if (id !== selectedId) selectedId = id;
    }
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  });

  // ---------- selection handlers ----------

  function onSelectTrace(id: string): void {
    selectedId = id;
    // If a dashboard activity-row click bumped us here, switch the view
    // so the detail panel actually shows up.
    if (view !== 'traces') {
      view = 'traces';
      if (typeof window !== 'undefined') {
        history.replaceState(null, '', `#/traces/${id}`);
      }
    }
  }

  function closeTrace(): void {
    selectedId = null;
    history.replaceState(null, '', '#/traces');
  }

  // ---------- header button handlers ----------

  function onRefresh(): void {
    if (view === 'traces') tracesReloadKey++;
    else landingReloadKey++;
  }

  function onAuth(): void {
    authModalOpen = true;
  }

  // ---------- filter sidebar handlers ----------

  function onApplyFilters(): void { tracesReloadKey++; }
  function onClearFilters(): void { tracesReloadKey++; }

  // ---------- pager handlers ----------

  function onPagerNext(): void { tracesListRef?.next(); }
  function onPagerPrev(): void { tracesListRef?.prev(); }

  function onTracesPagerChange(s: {
    prevDisabled: boolean;
    nextDisabled: boolean;
    info: string;
  }): void {
    pagerPrevDisabled = s.prevDisabled;
    pagerNextDisabled = s.nextDisabled;
    pagerInfo = s.info;
  }

  // ---------- auth-modal saved → reload current view ----------
  function onTokenSaved(): void {
    if (view === 'traces') tracesReloadKey++;
    else landingReloadKey++;
  }

  // ---------- boot sequence ----------
  //
  // 0) Apply the persisted theme BEFORE first render so a light-mode
  //    reload doesn't flash dark.
  // 1) If no token on disk, pop the modal.
  // 2) If there's no hash, force #/landing so the URL reflects the view.
  // 3) applyHash() picks view + selectedId from the URL.
  $effect(() => {
    if (typeof window !== 'undefined') {
      applyTheme(getTheme());
    }
    if (!getToken()) authModalOpen = true;
    if (typeof window !== 'undefined') {
      if (!window.location.hash) {
        history.replaceState(null, '', '#/landing');
      }
    }
    applyHash();
  });

  // ---------- global keyboard shortcut (Cmd+K palette) ----------
  $effect(() => {
    if (typeof window === 'undefined') return;
    return bindGlobalShortcut();
  });

  const statusLevel = $derived(
    statusKind === 'bad' ? 'bad' : statusKind === 'warn' ? 'warn' : '',
  );
</script>

<Header
  {view}
  {statusText}
  {statusLevel}
  {onRefresh}
  {onAuth}
/>

<main>
  {#if view === 'landing'}
  <section id="landing">
    {#key landingReloadKey}
      <Landing {authFetch} />
    {/key}
  </section>
  {/if}

  {#if view === 'export'}
  <section id="export">
    <Export {authFetch} />
  </section>
  {/if}

  {#if view === 'plugins'}
  <section id="plugins">
    <Plugins {authFetch} />
  </section>
  {/if}

  {#if view === 'settings'}
  <section id="settings">
    <Settings {authFetch} onOpenAuthModal={() => (authModalOpen = true)} />
  </section>
  {/if}

  {#if view === 'traces'}
  <section id="traces" class:detail-open={!!selectedId}>
    <div class="filters-wrap">
    <FilterSidebar
      bind:values={filters}
      {knownPaths}
      {knownModels}
      {knownKeys}
      onApply={onApplyFilters}
      onClear={onClearFilters}
    />
    </div>

    <div id="list">
      <div class="table-wrap" bind:this={listScroller} onscroll={rememberListScroll}>
        <TracesList
          bind:this={tracesListRef}
          {filters}
          {selectedId}
          reloadKey={tracesReloadKey}
          reloadResets={true}
          bind:knownPaths
          bind:knownModels
          bind:knownKeys
          {authFetch}
          onStatus={setStatus}
          {onSelectTrace}
          onPagerChange={onTracesPagerChange}
        />
      </div>

      <div class="pager">
        <button
          type="button"
          onclick={onPagerPrev}
          disabled={pagerPrevDisabled}
        >{t('traces.pagerPrev')}</button>
        <button
          type="button"
          onclick={onPagerNext}
          disabled={pagerNextDisabled}
        >{t('traces.pagerNext')}</button>
        <span class="info">{pagerInfo}</span>
      </div>
    </div>

    <div class="detail-wrap">
    <DetailPanel
      traceId={selectedId}
      onClose={closeTrace}
      {authFetch}
      onSelect={(id) => (selectedId = id)}
    >
      {#snippet tabBody({ detail, tab, convoIncludeSession, setConvoIncludeSession }: TabBodyCtx)}
        {#if tab === 'overview'}
          <OverviewTab
            row={detail.row}
            trace={detail.trace ?? {}}
            {authFetch}
            onSelect={(id) => (selectedId = id)}
          />
        {:else if tab === 'conversation'}
          <ConversationTab
            row={{
              ...detail.row,
              path: detail.row.path ?? '',
              ts_start: detail.row.ts_start ?? undefined,
            }}
            trace={detail.trace ?? {}}
            includeSession={convoIncludeSession}
            onIncludeSessionToggle={setConvoIncludeSession}
          />
        {:else if tab === 'raw'}
          <RawTab trace={detail.trace ?? {}} />
        {/if}
      {/snippet}
    </DetailPanel>
    </div>
  </section>
  {/if}
</main>

<AuthModal bind:open={authModalOpen} onSaved={onTokenSaved} />

<CommandPalette recentTraces={[]} />

<style>
  main {
    flex: 1;
    overflow: hidden;
    display: flex;
    min-height: 0;
  }

  #landing,
  #export,
  #plugins,
  #settings {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  #traces {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    min-width: 0;
  }

  .filters-wrap { display: flex; min-height: 0; flex: none; }
  .detail-wrap { display: flex; flex: 1; min-width: 0; min-height: 0; }

  #list {
    width: 52%;
    min-width: 380px;
    max-width: 720px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  #list .table-wrap {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  #list .pager {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--mono);
    font-size: 11px;
  }
  #list .pager button {
    background: var(--bg);
    color: var(--fg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  #list .pager button:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--border-strong);
  }
  #list .pager button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  #list .pager .info {
    margin-left: auto;
    color: var(--fg-muted);
  }
  @media (max-width: 768px) {
    #traces { flex-direction: column; }
    .filters-wrap { display: block; max-height: 55%; overflow: auto; }
    #list { width: 100%; min-width: 0; max-width: none; flex: 1; border-right: 0; }
    .detail-wrap { display: none; }
    #traces.detail-open .filters-wrap,
    #traces.detail-open #list { display: none; }
    #traces.detail-open .detail-wrap { display: flex; }
    #list .pager { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
    #list .pager button { min-height: 44px; padding: 8px 14px; font-size: 13px; }
  }
</style>
