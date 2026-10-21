<script lang="ts">
  // MediaBlock renderer.
  //
  // Render recorded media fields without synthesis:
  //   - We render the NAMED inline fields the adapter populated:
  //     `block.url` (remote URL or backend-served extracted path) or
  //     `block.data_b64` (inline base64 from the protocol).
  //   - `body_b64` is NOT an attachment — it's the unparseable-fallback
  //     container — and is NOT routed into MediaBlock by the adapter.
  //
  // Capture is non-blocking. The viewer reads what the extractor and adapter recorded.
  //
  // Filesystem-backed media is fetched as recorded. When `block.url` points at
  // the extracted file served by /api/media/..., the browser fetches the real
  // bytes. When only `data_b64` is present we synthesize a data: URL — no JS
  // decode of the b64 in the render path.
  //
  // Lazy rendering: the media element is only created once its block
  // approaches the viewport (IntersectionObserver). Until then a
  // placeholder shows the hint text. This also keeps the giant data:
  // URL out of the DOM — `src` is a lazy $derived read only by the
  // loaded branch — so opening an image-heavy conversation panel
  // doesn't concatenate / decode every payload up front.
  //
  // Visual restraint:
  //   - No background fills on the block. Hairline border-bottom only.
  //   - Role label upper-left, small-caps, --fg-dim.
  //   - Right-aligned metadata strip: side · container · size · mime,
  //     11px mono, --fg-dim.
  //   - No emojis. Static rows use the `─` glyph; expand control on
  //     the image uses `▸`. Both come from the existing ASCII glyph
  //     family already used by the other Block renderers.
  //
  // onJumpToPair is accepted for symmetry with the other Block
  // renderers but is unused here.

  import type { MediaBlock } from '../../lib/blocks';
  import { safeMediaUrl } from '../../lib/safeMediaUrl';
  import { hydrateLazyString, isLazyToken, lazyApproxChars } from '../../lib/lazyJson';
  import { t } from '../../lib/i18n.svelte';

  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

  type Props = {
    block: MediaBlock;
    onJumpToPair?: (id: string) => void;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { block, onJumpToPair: _onJumpToPair }: Props = $props();

  // ─── Type discrimination ───────────────────────────────────────────
  // Prefer mime_type because it's the protocol-derived truth; fall
  // back to media_type when mime is empty/missing.
  const mime = $derived((block.mime_type || '').toLowerCase());
  const isImage = $derived(mime.startsWith('image/') || block.media_type === 'image');
  const isAudio = $derived(mime.startsWith('audio/') || block.media_type === 'audio');
  const isVideo = $derived(mime.startsWith('video/') || block.media_type === 'video');
  // Documents and anything that isn't image/audio/video render as the
  // download chip.
  const isFile = $derived(!isImage && !isAudio && !isVideo);

  const hasInline = $derived(!!block.data_b64);

  // ─── Source URL (data: or remote/backend-served) ───────────────────
  // Synthesized only when we have something to point at. We hand the
  // base64 to the browser as a data: URL — no atob in render. Every
  // URL is run through safeMediaUrl() so the renderer never trusts
  // a raw trace value: external image-gen URLs go through the http(s)
  // allow, backend-served extractions go through the same-origin
  // /api/media allow, and `javascript:` / `blob:` / `data:text/...`
  // get filtered before they reach the DOM.
  //
  // Lazy payloads (lazyJson tokens): data_b64 / url may arrive as
  // `__apilog_lazy_N__` tokens instead of the real value. They are
  // materialized here — inside these $derived cells — which only get
  // computed when the loaded branch reads `src` (i.e. after the
  // IntersectionObserver fired), so a skipped payload costs nothing
  // until it is actually about to render.
  const inlineMimeOk = $derived(
    /^(image|audio|video)\//.test((block.mime_type || '').toLowerCase()),
  );
  // URL presence WITHOUT validating/materalizing: a lazy token passes
  // safeMediaUrl only after decode, so treat it as present up front.
  const urlIsLazy = $derived(isLazyToken(block.url));
  const hasUrl = $derived(urlIsLazy || (!!block.url && safeMediaUrl(block.url) !== null));

  const safeInlineSrc = $derived<string | null>(
    hasInline && inlineMimeOk
      ? safeMediaUrl(
          `data:${block.mime_type || 'application/octet-stream'};base64,${hydrateLazyString(block.data_b64!)}`,
        )
      : null,
  );
  const safeExternalUrl = $derived<string | null>(
    block.url ? safeMediaUrl(hydrateLazyString(block.url)) : null,
  );
  const src = $derived<string | null>(safeInlineSrc ?? safeExternalUrl);
  const hasSource = $derived((hasInline && inlineMimeOk) || hasUrl);

  // ─── Lazy media loading ────────────────────────────────────────────
  // Media elements (and the `src` computation above) are deferred until
  // the block nears the viewport. Clicking the placeholder loads
  // immediately. Without IntersectionObserver fall back to eager.
  let bodyEl = $state<HTMLDivElement | undefined>(undefined);
  let inView = $state(typeof IntersectionObserver === 'undefined');

  $effect(() => {
    const el = bodyEl;
    if (inView || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          inView = true;
        }
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  });

  function loadNow(): void {
    inView = true;
  }

  // ─── Display filename ─────────────────────────────────────────────
  const displayName = $derived(
    block.filename || `media.${mimeToExt(block.mime_type || '')}`,
  );

  // ─── Approximate size ─────────────────────────────────────────────
  // Base64 decodes to ~3/4 its length. Cheap, no decode. Used as a
  // human label only — never a precise value. Lazy tokens report
  // their recorded original length instead of the token length.
  const approxBytes = $derived(
    block.data_b64 ? Math.floor((lazyApproxChars(block.data_b64) * 3) / 4) : 0,
  );
  const sizeLabel = $derived(approxBytes ? formatBytes(approxBytes) : '');

  // ─── Metadata strip parts (right-aligned) ─────────────────────────
  const metaParts = $derived(
    [
      block.source.side,
      block.source.container,
      sizeLabel,
      block.mime_type || '',
    ].filter((s) => s.length > 0),
  );

  // ─── Inline image expand state ────────────────────────────────────
  let expanded = $state(false);
  function toggleExpand(): void {
    expanded = !expanded;
  }

  // ─── File download ────────────────────────────────────────────────
  // Decode b64 → Blob → object URL only on click. Revoke after 1s so
  // the browser has time to start the download. When only `url` is
  // present we let the anchor's native `download` attribute drive it.
  let downloadError = $state<string | null>(null);

  function downloadInline(): void {
    if (!block.data_b64) return;
    try {
      const bin = atob(hydrateLazyString(block.data_b64));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: block.mime_type || 'application/octet-stream',
      });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch (e) {
      downloadError = e instanceof Error ? e.message : String(e);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  function mimeToExt(m: string): string {
    const map: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'application/pdf': 'pdf',
      'application/json': 'json',
      'text/plain': 'txt',
    };
    return map[m.toLowerCase()] ?? (m.split('/')[1] || 'bin');
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#snippet lazyPlaceholder(kind: 'img' | 'audio' | 'video')}
  <button
    type="button"
    class="ph {kind === 'img' ? 'ph-img' : kind === 'audio' ? 'ph-audio' : 'ph-video'}"
    onclick={loadNow}
    aria-label={t('blocks.loadNow')}
  >
    <span class="hint">{t('blocks.lazyHint')}</span>
  </button>
{/snippet}

<div class="block">
  <div class="head">
    <span class="role">{roleLabel(block.role)}</span>
    <span class="title">
      <span class="glyph" aria-hidden="true">{isImage ? '▸' : '─'}</span>
      <span class="kind">{block.media_type}</span>
    </span>
    <span class="meta">
      {#each metaParts as part, i (i)}
        {#if i > 0}<span class="sep">·</span>{/if}<span>{part}</span>
      {/each}
    </span>
  </div>

  <div class="body" bind:this={bodyEl}>
    {#if isImage && hasSource}
      {#if inView && src}
        <button
          type="button"
          class="thumb-btn"
          class:expanded
          onclick={toggleExpand}
          aria-label={expanded ? t('blocks.collapseImage') : t('blocks.expandImage')}
        >
          <img
            src={src}
            alt={displayName}
            class="thumb"
            class:expanded
            loading="lazy"
            decoding="async"
          />
        </button>
      {:else if inView}
        <span class="dl mono dl--disabled">{t('blocks.unavailable')}</span>
      {:else}
        {@render lazyPlaceholder('img')}
      {/if}
    {:else if isAudio && hasSource}
      {#if inView && src}
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio controls preload="metadata" src={src} class="audio"></audio>
      {:else if inView}
        <span class="dl mono dl--disabled">{t('blocks.unavailable')}</span>
      {:else}
        {@render lazyPlaceholder('audio')}
      {/if}
    {:else if isVideo && hasSource}
      {#if inView && src}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video controls preload="metadata" src={src} class="video"></video>
      {:else if inView}
        <span class="dl mono dl--disabled">{t('blocks.unavailable')}</span>
      {:else}
        {@render lazyPlaceholder('video')}
      {/if}
    {:else if isFile || !hasSource}
      <div class="file">
        <div class="file-info">
          <div class="file-name mono">{displayName}</div>
          <div class="file-meta mono">
            <span>{block.mime_type || 'application/octet-stream'}</span>
            {#if sizeLabel}
              <span class="sep">·</span><span>{sizeLabel}</span>
            {/if}
          </div>
        </div>
        {#if hasInline}
          <button type="button" class="dl mono" onclick={downloadInline}>
            {t('blocks.download')}
          </button>
        {:else if hasUrl && !urlIsLazy}
          <a
            class="dl mono"
            href={safeExternalUrl}
            download={displayName}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('blocks.download')}
          </a>
        {:else}
          <span class="dl mono dl--disabled">{t('blocks.unavailable')}</span>
        {/if}
      </div>
    {/if}

    {#if downloadError}
      <div class="err mono">{downloadError}</div>
    {/if}
  </div>
</div>

<style>
  /* Block frame: 4px left rail + hairline bottom only.
     MediaBlock has no role-class wiring, so the rail defaults to
     --border-strong. The head row's role
     label still carries role identity in text. */
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    line-height: 1;
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .role {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    color: var(--fg-muted);
    font-size: var(--size-label);
  }

  .title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--fg-muted);
  }

  .glyph {
    display: inline-block;
    width: 10px;
    color: var(--fg-dim);
  }

  /* Type indicator — lowercase outline chip. */
  .kind {
    text-transform: lowercase;
    letter-spacing: 0.02em;
    font-size: var(--size-label);
    padding: 1px 4px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    line-height: 1;
    color: var(--fg-muted);
  }

  .meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--fg-dim);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .meta .sep { color: var(--fg-dim); }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ── Image ───────────────────────────────────────────────────────
     Collapsed: 200×200 thumbnail, zoom-in cursor.
     Expanded: natural size capped at 100% of container, zoom-out. */
  .thumb-btn {
    align-self: flex-start;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: zoom-in;
    line-height: 0;
    overflow: hidden;
    max-width: 100%;
  }
  .thumb-btn.expanded { cursor: zoom-out; }
  .thumb-btn:hover { border-color: var(--border-strong); }

  .thumb {
    display: block;
    max-width: 200px;
    max-height: 200px;
    width: auto;
    height: auto;
    object-fit: contain;
  }
  .thumb.expanded {
    max-width: 100%;
    max-height: none;
  }

  /* ── Lazy placeholder (media not loaded yet) ─────────────────────
     Fixed footprint close to the loaded media so layout barely
     shifts when the real element replaces it. */
  .ph {
    align-self: flex-start;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    color: var(--fg-dim);
  }
  .ph:hover {
    border-color: var(--border-strong);
    color: var(--fg-muted);
  }
  .ph:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ph-img { width: 200px; height: 200px; max-width: 100%; }
  .ph-audio { width: 100%; max-width: 360px; height: 54px; }
  .ph-video { width: 320px; height: 180px; max-width: 100%; }
  .hint {
    font-family: var(--font-mono);
    font-size: var(--size-label);
  }

  /* ── Audio / Video ──────────────────────────────────────────────── */
  .audio {
    display: block;
    width: 100%;
    max-width: 360px;
  }

  .video {
    display: block;
    max-width: 100%;
    max-height: 360px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  /* ── File / Document / Other ────────────────────────────────────── */
  .file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .file-name {
    font-size: var(--size-body);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    font-size: var(--size-label);
    color: var(--fg-dim);
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .file-meta .sep { color: var(--fg-dim); }

  .dl {
    flex-shrink: 0;
    font-size: var(--size-label);
    line-height: 1;
    padding: 4px 10px;
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--font-mono);
  }
  .dl:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .dl--disabled {
    color: var(--fg-dim);
    cursor: default;
  }
  .dl--disabled:hover {
    border-color: var(--border);
    color: var(--fg-dim);
  }

  .mono { font-family: var(--font-mono); }

  .err {
    font-size: var(--size-label);
    color: var(--err);
    font-family: var(--font-mono);
  }
</style>
