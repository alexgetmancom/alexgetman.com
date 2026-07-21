<!-- =============================================================================
  ПРАВАЯ ПАНЕЛЬ: текст поста + кнопки + вкладка обсуждения.
  ─────────────────────────────────────────────────────────────────────────────
  Презентационный компонент: своего состояния нет. Показывает:
    - категорию, заголовок (единственный <h1> страницы — noscript-SEO в
      Astro-слое дублирует его как <p>, во избежание двух h1 в разметке),
      время чтения, дату, просмотры
    - параграфы поста + кнопку «Читать дальше» (видимость меряет корень)
    - контейнер giscus (в него корень инжектит скрипт через discussion.ts)
    - кнопки «Обсудить» / «Поделиться»
  Стили — в <style> внизу (scoped). Правила, зависящие от состояния корня
  (.story-player.is-discussing / .is-reading), написаны через :global(...) —
  корневой класс живёт в StoryPlayer.svelte. Контент giscus инжектится JS,
  поэтому его селекторы тоже :global.
============================================================================= -->
<script lang="ts">
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";

let {
  post,
  ui,
  updating,
  expanded,
  readMoreVisible,
  discussionVisible,
  readingVisible,
  shareCopied,
  copyEl = $bindable(null),
  discussionFrame = $bindable(null),
  ontogglereadmore,
  onopendiscussion,
  onshare,
}: {
  post: PlayerPost;
  ui: StoryUi;
  updating: boolean;
  expanded: boolean;
  readMoreVisible: boolean;
  discussionVisible: boolean;
  readingVisible: boolean;
  shareCopied: boolean;
  copyEl?: HTMLElement | null;
  discussionFrame?: HTMLElement | null;
  ontogglereadmore: () => void;
  onopendiscussion: () => void;
  onshare: () => void;
} = $props();

const readingTimeMin = $derived(Math.max(1, Math.ceil(post.body.join(" ").split(/\s+/).length / 180)));
</script>

<aside class="story-context" data-story-context aria-hidden={!readingVisible && !discussionVisible}>
  <div class="story-panel is-active" class:is-updating={updating} data-panel="post">
    <div class="story-category-wrap" hidden={discussionVisible}>
      <span class="story-category-badge">{post.category}</span>
    </div>
    <h1 class="story-title" data-story-title hidden={discussionVisible}>{post.title}</h1>
    <div class="story-meta" hidden={discussionVisible}>
      <span class="story-meta-item">⏱️ {readingTimeMin} min</span>
      <span class="story-meta-dot">•</span>
      <span class="story-meta-item">{post.relativeDate}</span>
      <span class="story-meta-dot">•</span>
      <span class="story-meta-item">👁️ <span>{post.views}</span></span>
    </div>
    <div class="story-copy" class:is-expanded={expanded} data-story-copy hidden={discussionVisible} bind:this={copyEl}>
      {#each post.body as paragraph}
        <p>{paragraph}</p>
      {/each}
    </div>
    {#if post.sources.length > 0 && !discussionVisible}
      <div class="story-sources" aria-label="Sources">
        {#each post.sources as source}
          <a href={source.url} target="_blank" rel="noopener noreferrer" class="story-source-link">
            {source.label} ↗
          </a>
        {/each}
      </div>
    {/if}
    <button class="read-more-button" type="button" hidden={!readMoreVisible || discussionVisible} onclick={ontogglereadmore}>
      {expanded ? ui.collapse : ui.readMore}
    </button>
    <div class="story-panel story-panel--discussion" data-panel="discussion" hidden={!discussionVisible}>
      <div class="story-discussion-frame" bind:this={discussionFrame}></div>
    </div>
    <div class="story-actions">
      <button class="story-action story-action--primary" type="button" onclick={onopendiscussion}>
        <svg class="story-action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>{discussionVisible ? ui.backToPost : ui.discuss}</span>
      </button>
      <button class="story-action" type="button" onclick={onshare}>
        <svg class="story-action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
          <circle cx="18" cy="5" r="3"></circle>
          <circle cx="6" cy="12" r="3"></circle>
          <circle cx="18" cy="19" r="3"></circle>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
        </svg>
        <span>{shareCopied ? ui.copied : ui.share}</span>
      </button>
    </div>
  </div>
</aside>

<style>
  /* --------------------- Панель контекста (правая колонка) ------------------ */
  .story-context {
    align-self: center;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.042), rgba(255, 255, 255, 0.012)), rgba(0, 0, 0, 0.56);
    overflow: hidden;
    min-width: 0;
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    animation: appReveal 0.68s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: 0.36s;
    opacity: 0;
  }

  @keyframes appReveal {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .story-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: clamp(1rem, 1.35vw, 1.25rem);
    overflow: hidden;
  }

  .story-panel[hidden] {
    display: none;
  }

  .story-context [hidden] {
    display: none;
  }

  /* --------------------------- Категория и мета ----------------------------- */
  .story-category-wrap {
    margin-bottom: 0.44rem;
    flex-shrink: 0;
  }

  .story-category-badge {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 900;
    text-transform: uppercase;
    color: #ff5c77; /* ≥4.5:1 на тёмной панели (контраст Lighthouse) */
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.28);
    padding: 0.22rem 0.54rem;
    border-radius: 6px;
    letter-spacing: 0.05em;
  }

  .story-meta {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: -0.2rem;
    margin-bottom: 1rem;
    font-family: var(--font-sans);
    font-size: 0.8rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .story-meta-item {
    display: inline-flex;
    align-items: center;
    font-weight: 500;
  }

  .story-meta-dot {
    color: rgba(255, 255, 255, 0.16);
    font-weight: bold;
    font-size: 0.9rem;
  }

  /* ------------------------------- Заголовок -------------------------------- */
  .story-title {
    margin: 0 0 0.62rem;
    color: var(--text-header);
    letter-spacing: -0.015em;
    line-height: 1.14;
    font-size: clamp(1.8rem, 2.3vw, 2.5rem);
    font-weight: bold;
  }

  /* Плавная смена поста (.is-updating ставит корень на время перерисовки). */
  .story-title,
  .story-copy,
  .story-meta,
  .story-category-wrap {
    transition:
      opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 1;
    transform: translateY(0);
  }

  .story-panel.is-updating .story-title,
  .story-panel.is-updating .story-copy,
  .story-panel.is-updating .story-meta,
  .story-panel.is-updating .story-category-wrap {
    opacity: 0;
    transform: translateY(8px);
    transition: none;
  }

  /* ----------------------------- Текст поста -------------------------------- */
  .story-copy {
    display: block;
    color: #e2e8f0;
    font-size: clamp(1.16rem, 1.28vw, 1.48rem);
    line-height: 1.32;
    flex-grow: 1;
    overflow-y: auto;
    position: relative;
    padding-right: 0.45rem;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
  }

  .story-copy::-webkit-scrollbar {
    width: 4px;
  }

  .story-copy::-webkit-scrollbar-track {
    background: transparent;
  }

  .story-copy::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.16);
    border-radius: 999px;
  }

  .story-copy p {
    margin: 0 0 1.1rem 0;
    max-width: 52ch;
  }

  /* Заголовок — h1 внутри панели: вернуть его отступ поверх правила выше. */
  .story-panel > h1.story-title {
    margin: 0 0 0.62rem;
  }

  /* ------------------------------- Кнопки ----------------------------------- */
  .story-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.52rem;
    margin-top: auto;
    padding-top: 0.72rem;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .story-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.6rem;
    margin-top: 0.65rem;
    font-size: 0.72rem;
    line-height: 1.25;
  }

  .story-source-link {
    color: var(--muted);
    text-decoration: none;
  }

  .story-source-link:hover {
    color: var(--text);
    text-decoration: underline;
  }

  .story-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 0.44rem 0.52rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--text-header);
    font-weight: 900;
    font-size: 0.82rem;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .story-action:hover {
    border-color: rgba(243, 246, 250, 0.25);
    color: var(--text-header);
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 4px 12px rgba(255, 255, 255, 0.04);
  }

  .story-action--primary {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }

  .story-action--primary:hover {
    background: #e53e3e;
    border-color: #e53e3e;
    color: white;
    box-shadow: 0 0 16px rgba(220, 38, 38, 0.5);
    transform: translateY(-1px);
  }

  /* ---------------------- Вкладка обсуждения (giscus) ----------------------- */
  /* Корень вешает .is-discussing на .story-player — прячем контент поста. */
  :global(.story-player.is-discussing) .story-category-wrap,
  :global(.story-player.is-discussing) .story-meta,
  :global(.story-player.is-discussing) [data-story-title],
  :global(.story-player.is-discussing) [data-story-copy],
  :global(.story-player.is-discussing) .read-more-button {
    display: none;
  }

  .story-panel--discussion {
    height: auto;
    min-height: 0;
    flex: 1 1 auto;
    gap: 0.85rem;
    padding: 0;
    overflow: hidden;
  }

  .story-discussion-frame {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 0.2rem;
  }

  /* Внутрь фрейма giscus инжектит свой iframe из JS — поэтому :global. */
  .story-discussion-frame :global(.giscus),
  .story-discussion-frame :global(iframe) {
    width: 100%;
  }

  .story-discussion-frame :global(.story-discussion-loading) {
    min-height: 120px;
    display: grid;
    place-items: center;
    color: var(--text-secondary);
    font-weight: 800;
  }

  /* Примечание: в старом CSS был блок «компактный десктоп»
     (max-height: 800px) с уменьшенной типографикой панели, но он никогда
     не применялся — его перебивал порядок @import. При миграции сохранено
     фактическое поведение; если захочешь компактный режим — добавь здесь
     @media (max-height: 800px) and (min-width: 1121px) осознанно. */

  /* ---- Планшет (≤1120px): панель под сценой ---- */
  @media (max-width: 1120px) {
    .story-context {
      order: 2;
      width: min(100%, 720px);
      justify-self: center;
      height: auto;
      min-height: 0;
      max-height: none;
    }
  }

  /* ---- Телефон (≤760px): панель = выезжающий «лист» поверх сцены ---- */
  @media (max-width: 760px) {
    .story-context {
      position: fixed;
      z-index: var(--z-controls);
      /* Держим лист между кнопкой звука и Read/Back. */
      top: calc(4.5rem + env(safe-area-inset-top, 0));
      right: 0.8rem;
      bottom: auto;
      left: 0.8rem;
      box-sizing: border-box;
      display: block;
      width: auto;
      min-height: 0;
      height: calc(100dvh - 14.75rem - env(safe-area-inset-top, 0) - env(safe-area-inset-bottom, 0));
      max-width: none;
      max-height: calc(100dvh - 14.75rem - env(safe-area-inset-top, 0) - env(safe-area-inset-bottom, 0));
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 18px;
      background: rgba(8, 11, 16, 0.74);
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      opacity: 0;
      pointer-events: none;
      transform: translateY(1.2rem) scale(0.98);
      transition:
        transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.2s ease;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      animation: none;
    }

    :global(.story-player.is-reading) .story-context,
    :global(.story-player.is-discussing) .story-context {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }

    :global(.story-player.is-discussing) .story-panel--discussion {
      display: flex;
      height: 100%;
      padding: 0;
    }

    :global(.story-player.is-discussing) .story-discussion-frame {
      height: 100%;
      padding-right: 0;
    }

    .story-category-wrap {
      margin-top: 0.25rem;
    }

    .story-title {
      font-size: clamp(1.7rem, 8vw, 2.35rem);
      line-height: 1.05;
    }

    .story-meta {
      flex-wrap: wrap;
      margin-bottom: 0.9rem;
    }

    .story-panel {
      min-height: 0;
      height: 100%;
      padding: 1.15rem 1rem 1.25rem;
      overflow: hidden;
    }

    /* На мобильном заголовок уже показан на сцене — в листе прячем. */
    .story-context [data-story-title],
    .story-context .story-actions {
      display: none;
    }

    .story-copy {
      flex: 1 1 auto;
      min-width: 0;
      overflow-y: auto;
      overflow-wrap: anywhere;
      word-break: break-word;
      padding-right: 0;
      font-size: 1.02rem;
      line-height: 1.42;
    }

    /* Кнопки скрыты на мобильном (см. display:none выше), но геометрия
       сохранена как в исходном CSS на случай возврата. */
    .story-actions {
      position: sticky;
      z-index: var(--z-sticky);
      bottom: calc(0.8rem + env(safe-area-inset-bottom, 0));
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.55rem;
      margin-top: 1.1rem;
      padding: 0;
      border: 0;
      pointer-events: auto;
    }

    .story-copy p {
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
  }
</style>
