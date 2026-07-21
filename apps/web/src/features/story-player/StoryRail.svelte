<!-- =============================================================================
  ЛЕНТА КАРТОЧЕК (левая колонка / низ на мобильном).
  ─────────────────────────────────────────────────────────────────────────────
  Презентационный компонент: своего состояния НЕТ.
  Получает: posts, active (какая карточка подсвечена), visibleIndexes
  (фильтр режима ленты), onselect — сообщает корню, что кликнули карточку.
  Сам умеет только: отрисовать карточки + плавно доскроллить к активной.
  Стили — в <style> внизу (scoped): лента и карточки, включая мобильные
  переопределения. Геометрия ленты (высота карточки, отступы) задаётся CSS-
  переменными --rail-* на .story-rail-container в StoryPlayer.svelte.
============================================================================= -->
<script lang="ts">
import { truncateText } from "../../utils/text";
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";

let {
  posts,
  ui,
  active,
  visibleIndexes,
  onselect,
}: {
  posts: PlayerPost[];
  ui: StoryUi;
  active: number;
  visibleIndexes: number[];
  onselect: (index: number) => void;
} = $props();

let rail = $state<HTMLElement | null>(null);
let cards: HTMLElement[] = [];

/* Активная карточка всегда докручивается в центр ленты. */
$effect(() => {
  const card = cards[active];
  if (!rail || !card) return;
  const railEl = rail;
  window.setTimeout(() => {
    const left = card.offsetLeft - (railEl.clientWidth - card.offsetWidth) / 2;
    const top = card.offsetTop - (railEl.clientHeight - card.offsetHeight) / 2;
    railEl.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: "smooth" });
  }, 60);
});

function onImageError(event: Event, post: PlayerPost): void {
  const img = event.currentTarget as HTMLImageElement;
  if (post.fallbackImage && img.getAttribute("src") !== post.fallbackImage) {
    img.setAttribute("src", post.fallbackImage);
    img.removeAttribute("srcset");
  } else {
    img.style.display = "none";
  }
}
</script>

<nav class="story-rail" aria-label={ui.storyRail} bind:this={rail}>
  {#each posts as post, index (post.id)}
    <a
      href={post.url}
      class="rail-card"
      class:is-active={index === active}
      class:rail-card--no-image={!post.image}
      class:is-filtered-out={!visibleIndexes.includes(index)}
      bind:this={cards[index]}
      onclick={(event) => {
        event.preventDefault();
        onselect(index);
      }}
    >
      <span class="rail-card__media" aria-hidden="true">
        {#if post.image}
          {#if post.mediaType === "video"}
            {#if post.fallbackImage}
              <img
                src={post.fallbackImage}
                srcset={post.imageSrcSet || undefined}
                alt={post.title}
                loading={index < 4 ? "eager" : "lazy"}
                decoding="async"
                sizes="(max-width: 760px) 38vw, 140px"
              />
            {:else}
              <video src={`${post.image}#t=0.001`} muted playsinline preload="metadata"></video>
            {/if}
          {:else}
            <img
              src={post.image}
              srcset={post.imageSrcSet || undefined}
              alt={post.title}
              loading={index < 4 ? "eager" : "lazy"}
              decoding="async"
              sizes="(max-width: 760px) 38vw, 140px"
              onerror={(event) => onImageError(event, post)}
            />
          {/if}
        {:else}
          <span>{post.category}</span>
        {/if}
      </span>
      <span class="rail-card__shade"></span>
      <span class="rail-card__text">
        <strong>{truncateText(post.title, 62)}</strong>
      </span>
    </a>
  {/each}
</nav>

<style>
  /* ---- Лента (desktop: вертикальная колонка; активная карточка в центре) ---- */
  .story-rail {
    align-self: center;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    gap: var(--rail-gap);
    overflow-y: hidden;
    overflow-x: hidden;
    overscroll-behavior-y: contain;
    padding: 0.05rem;
    scrollbar-width: none;
    /* Появление при загрузке */
    animation: appReveal 0.68s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: 0.08s;
    opacity: 0;
  }

  /* Пустые «прокладки», чтобы активная карточка вставала по центру. */
  .story-rail::before,
  .story-rail::after {
    content: "";
    display: block;
    height: var(--rail-active-offset);
    flex-shrink: 0;
  }

  .story-rail::-webkit-scrollbar {
    display: none;
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

  /* ------------------------------- Карточка -------------------------------- */
  .rail-card {
    position: relative;
    min-height: 0;
    height: var(--rail-card-height);
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.65);
    color: var(--text-header);
    isolation: isolate;
    padding: 0;
    transition:
      filter 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.3s ease,
      box-shadow 0.3s ease;
  }

  .rail-card:not(.is-active) {
    filter: grayscale(100%);
    opacity: 0.38;
  }

  .rail-card:not(.is-active):hover {
    filter: grayscale(35%);
    opacity: 0.75;
    border-color: rgba(255, 255, 255, 0.2);
  }

  .rail-card.is-active {
    border-color: rgba(220, 38, 38, 0.5);
    box-shadow:
      0 0 0 1px rgba(220, 38, 38, 0.18),
      0 18px 42px rgba(0, 0, 0, 0.32);
    filter: none;
    opacity: 1;
    background: linear-gradient(90deg, rgba(220, 38, 38, 0.07), rgba(0, 0, 0, 0.7) 36%, rgba(220, 38, 38, 0.045)), rgba(0, 0, 0, 0.74);
  }

  /* Пост скрыт текущим режимом ленты (Deep/Watched). */
  .rail-card.is-filtered-out {
    display: none;
  }

  .rail-card__media {
    position: relative;
    height: 100%;
    order: 2;
    width: clamp(92px, 30%, 148px);
    max-width: 42%;
    flex-shrink: 0;
    overflow: hidden;
    background: #000;
    border-left: 1px solid var(--border);
  }

  .rail-card.is-active .rail-card__media {
    order: 2;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
  }

  .rail-card__media img,
  .rail-card__media video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
    display: block;
  }

  /* Карточка без картинки: бейдж категории на градиенте. */
  .rail-card__media > span {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 0.35rem;
    font-size: 0.56rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-weight: 800;
    text-align: center;
    background:
      radial-gradient(circle at 35% 18%, rgba(240, 68, 101, 0.16), transparent 34%),
      linear-gradient(135deg, rgba(240, 68, 101, 0.1), rgba(255, 255, 255, 0.03));
  }

  .rail-card__shade {
    position: absolute;
    inset: 0;
    z-index: var(--z-base);
    background: linear-gradient(90deg, rgba(0, 0, 0, 0), rgba(240, 68, 101, 0.035));
    pointer-events: none;
  }

  .rail-card.is-active .rail-card__shade {
    background: linear-gradient(90deg, rgba(220, 38, 38, 0.035), transparent 42%, rgba(220, 38, 38, 0.055));
  }

  .rail-card__text {
    position: relative;
    order: 1;
    z-index: var(--z-above);
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    flex-grow: 1;
    padding: clamp(0.48rem, 0.72vw, 0.68rem) clamp(0.6rem, 0.8vw, 0.95rem);
  }

  .rail-card.is-active .rail-card__text {
    order: 1;
    padding-left: clamp(0.82rem, 1vw, 1.15rem);
    padding-right: clamp(0.82rem, 1vw, 1.15rem);
  }

  .rail-card__text strong {
    font-size: clamp(1.08rem, 1.18vw, 1.35rem);
    line-height: 1.04;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Планшет (≤1120px): лента становится горизонтальной под плеером ---- */
  @media (max-width: 1120px) {
    .story-rail {
      order: 2;
      width: 100%;
      height: auto;
      max-height: none;
      display: flex;
      flex-direction: row;
      gap: 0.55rem;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      padding: 0.05rem 0.05rem 0.48rem;
    }

    .story-rail::before,
    .story-rail::after {
      display: none;
    }

    .rail-card {
      min-height: 0;
      width: clamp(104px, 12vw, 124px);
      height: 140px;
      flex-shrink: 0;
      position: relative;
      display: block;
      padding: 0;
    }

    .rail-card.is-active {
      padding-left: 0;
    }

    .rail-card__media,
    .rail-card__shade,
    .rail-card__text {
      position: absolute;
      inset: 0;
    }

    .rail-card__media {
      width: auto;
      aspect-ratio: auto;
      border: 0;
      border-radius: 0;
    }

    .rail-card__shade {
      background: linear-gradient(180deg, transparent 32%, rgba(8, 11, 16, 0.94) 100%);
    }

    .rail-card__text {
      justify-content: flex-end;
      padding: 0.72rem;
    }
  }

  /* ---- Телефон (≤760px): сам rail скрыт контейнером в StoryPlayer, но
     карточки крупнее — на случай показа (например, режим ленты). ---- */
  @media (max-width: 760px) {
    .story-rail {
      width: 100%;
      gap: 0.65rem;
      animation: none;
      opacity: 1;
      transform: none;
    }

    .rail-card {
      width: clamp(118px, 34vw, 148px);
      height: 168px;
      border-radius: 10px;
    }

    .rail-card.is-active {
      padding-left: 0;
      border-color: rgba(220, 38, 38, 0.5);
    }

    .rail-card.is-active .rail-card__media {
      order: initial;
      border: 0;
    }

    .rail-card.is-active .rail-card__text {
      order: initial;
      padding: 0.72rem;
    }
  }
</style>
