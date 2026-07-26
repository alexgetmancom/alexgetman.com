<!-- =============================================================================
  ЦЕНТРАЛЬНАЯ СЦЕНА: фото/видео активного поста.
  ─────────────────────────────────────────────────────────────────────────────
  Презентационный компонент: своё состояние — только фолбек упавшего видео.
  Что здесь живёт:
    - <img>/<video>/<audio> активного поста (элементы отдаёт корню через bind:)
    - кнопка звука, кнопка «Читать», мобильная подпись и мобильные кнопки
  Полоса прогресса — StoryProgressBar.svelte (её `progressFill` проходит
  насквозь к корню), вспышка play/pause — PlayPauseOverlay.svelte.
  Все клики уходят коллбеками в StoryPlayer.svelte.
  Стили — в <style> внизу (scoped), включая мобильный полноэкранный режим.
============================================================================= -->
<script lang="ts">
import { onStoryImageError } from "../../scripts/story-player/media";
import type { StoryUi } from "./i18n";
import PlayPauseOverlay from "./PlayPauseOverlay.svelte";
import type { PlayerPost } from "./payload";
import StoryProgressBar from "./StoryProgressBar.svelte";

let {
  post,
  ui,
  paused,
  muted,
  autoplayMuted,
  overlayTick,
  shareCopied,
  readingVisible,
  gallerySubIndex = 0,
  video = $bindable(null),
  audio = $bindable(null),
  progressFill = $bindable(null),
  onwheel,
  ontoggleplay,
  onaudiotoggle,
  ontoggleread,
  onopendiscussion,
  onshare,
  onvideoplaying,
  onvideotimeupdate,
  onvideoended,
  onvideowaiting,
  onselectgallery,
}: {
  post: PlayerPost;
  ui: StoryUi;
  paused: boolean;
  muted: boolean;
  autoplayMuted: boolean;
  overlayTick: number;
  shareCopied: boolean;
  readingVisible: boolean;
  gallerySubIndex?: number;
  video?: HTMLVideoElement | null;
  audio?: HTMLAudioElement | null;
  progressFill?: HTMLElement | null;
  onwheel: (event: WheelEvent) => void;
  ontoggleplay: () => void;
  onaudiotoggle: () => void;
  ontoggleread: () => void;
  onopendiscussion: () => void;
  onshare: () => void;
  onvideoplaying: () => void;
  onvideotimeupdate: () => void;
  onvideoended: () => void;
  onvideowaiting: () => void;
  onselectgallery?: (index: number) => void;
} = $props();

const isVideo = $derived(post.mediaType === "video");
const audioLabel = $derived(autoplayMuted ? ui.tapForSound : muted ? ui.muted : ui.mute);
let videoFailed = $state(false);

/* Несколько картинок в посте (пост целиком не видео) → листаем их по очереди,
     как отдельные слайды, прежде чем перейти к следующему посту. */
const gallerySequence = $derived(isVideo ? [] : post.gallery || []);
const hasGallerySequence = $derived(gallerySequence.length >= 2);
const activeGalleryMedia = $derived(hasGallerySequence ? gallerySequence[Math.min(gallerySubIndex, gallerySequence.length - 1)] : null);

/* Видео не загрузилось → показываем постер/фолбек-картинку вместо него. */
function onVideoError(): void {
  if (post.fallbackImage) videoFailed = true;
}
$effect(() => {
  void post.id;
  videoFailed = false;
});

function onImageError(event: Event): void {
  onStoryImageError(event, post.fallbackImage);
}
</script>

<div class="story-visual-wrap">
  <article class="story-visual" class:story-visual--no-image={!post.image} data-story-visual {onwheel}>
    <StoryProgressBar
      title={post.title}
      {gallerySequence}
      {gallerySubIndex}
      bind:progressFill
      {onselectgallery}
    />
    <a
      class="story-visual__link"
      href={post.url}
      aria-label={post.title}
      onclick={(event) => {
        /* href — настоящий адрес поста: modifier-клик и средняя кнопка должны
           открывать его в новой вкладке, а не глотаться паузой. */
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        ontoggleplay();
      }}
    >
      {#if post.image && (!isVideo || videoFailed)}
        <img
          src={activeGalleryMedia ? activeGalleryMedia.path || post.image : videoFailed ? post.fallbackImage : post.image}
          srcset={activeGalleryMedia || videoFailed ? undefined : post.imageSrcSet || undefined}
          alt={`${post.title}${hasGallerySequence ? ` — ${gallerySubIndex + 1}/${gallerySequence.length}` : ""}`}
          loading="eager"
          fetchpriority="high"
          decoding="async"
          sizes="(max-width: 760px) min(100vw - 2rem, 390px), 320px"
          onerror={onImageError}
        />
      {/if}
      {#if post.image && isVideo && !videoFailed}
        <video
          bind:this={video}
          src={post.image}
          poster={post.posterSrc || post.fallbackImage || undefined}
          muted
          autoplay
          playsinline
          preload="metadata"
          onerror={onVideoError}
          onplaying={onvideoplaying}
          ontimeupdate={onvideotimeupdate}
          onended={onvideoended}
          onwaiting={onvideowaiting}
        ></video>
      {/if}
      {#if !post.image}
        <span class="story-visual__fallback">{post.title}</span>
      {/if}
    </a>
    <button
      class="audio-chip"
      class:is-on={!muted && !autoplayMuted}
      type="button"
      aria-pressed={muted}
      aria-label={audioLabel}
      onclick={onaudiotoggle}
    >
      <span aria-hidden="true">♪</span>
      <span>{audioLabel}</span>
    </button>
    <button class="story-read-trigger" class:is-open={readingVisible} type="button" aria-expanded={readingVisible} onclick={ontoggleread}>
      <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <path d="M14 2v6h6"></path>
        <path d="M8 13h8"></path>
        <path d="M8 17h6"></path>
      </svg>
      <span>{readingVisible ? ui.back : ui.read}</span>
    </button>
    <div class="story-mobile-caption" aria-hidden="true">
      <span>{post.category}</span>
      <strong>{post.title}</strong>
    </div>
    <div class="story-mobile-actions" aria-label={ui.storyLabel}>
      <button class="story-action story-action--primary" type="button" onclick={onopendiscussion}>
        <span>{ui.discuss}</span>
      </button>
      <button class="story-action" type="button" onclick={onshare}>
        <span>{shareCopied ? ui.copied : ui.share}</span>
      </button>
    </div>
    <PlayPauseOverlay {paused} {overlayTick} />
    <audio bind:this={audio} src={!isVideo ? post.audioUrl || undefined : undefined} preload="none"></audio>
  </article>
</div>

<style>
  /* ------------------- Обёртка сцены (центр сетки плеера) ------------------- */
  .story-visual-wrap {
    position: relative;
    display: grid;
    place-items: center;
    height: 100%;
    min-width: 0;
    min-height: 0;
    animation: appReveal 0.68s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: 0.22s;
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

  /* -------------------- Портретная «сцена» 9:16 с медиа --------------------- */
  .story-visual {
    position: relative;
    width: min(760px, calc((100dvh - 0.25rem) * 0.5625), 100%);
    height: auto;
    max-height: 100%;
    aspect-ratio: 9 / 16;
    border: 1px solid var(--border-hover);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.012)), rgba(0, 0, 0, 0.58);
    overflow: hidden;
    isolation: isolate;
    box-shadow: 0 22px 70px rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }

  .story-visual__link,
  .story-visual__link img,
  .story-visual__link video,
  .story-visual__fallback {
    position: absolute;
    inset: 0;
  }

  .story-visual__link img,
  .story-visual__link video {
    width: 100%;
    height: 100%;
    display: block;
  }

  .story-visual__link img {
    object-fit: contain;
    background: #000000;
  }

  .story-visual__link video {
    /* Держим видеоповерхность ниже полосы прогресса: некоторые браузеры
       рендерят видео в композитном слое поверх более высокого z-index.
       `contain` сохраняет горизонтальные ролики без обрезки боков. */
    clip-path: inset(8px 0 0);
    object-fit: contain;
    background: #000;
  }

  /* Полоса прогресса (обычная и сегментированная) — в StoryProgressBar.svelte. */

  /* Пост без картинки: крупный заголовок на градиенте. */
  .story-visual__fallback {
    display: grid;
    align-content: end;
    background:
      radial-gradient(circle at 35% 18%, rgba(240, 68, 101, 0.18), transparent 35%),
      linear-gradient(135deg, rgba(240, 68, 101, 0.12), rgba(255, 255, 255, 0.03));
    color: var(--text-header);
    font-weight: 900;
    font-size: clamp(1.6rem, 3.1vw, 2.7rem);
    line-height: 1.04;
    padding: 1.2rem;
    overflow-wrap: anywhere;
  }

  /* ------------------------------ Кнопка звука ------------------------------ */
  .audio-chip {
    position: absolute;
    z-index: 4;
    right: 0.8rem;
    top: 2.05rem;
    display: inline-flex;
    align-items: center;
    gap: 0.32rem;
    min-height: 34px;
    padding: 0.25rem 0.58rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--text-main);
    font-size: 0.76rem;
    font-weight: 800;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .audio-chip:hover {
    background: rgba(0, 0, 0, 0.6);
    border-color: rgba(255, 255, 255, 0.18);
  }

  .audio-chip.is-on {
    border-color: rgba(220, 38, 38, 0.45);
    color: var(--accent);
    background: rgba(220, 38, 38, 0.06);
  }

  /* Мобильные элементы: на десктопе скрыты. */
  .story-mobile-caption {
    display: none;
  }

  .story-mobile-actions {
    display: none;
  }

  .story-read-trigger {
    display: none;
  }

  /* Оверлей play/pause по клику — в PlayPauseOverlay.svelte. */

  /* ---- Планшет (≤1120px): сцена встаёт первой в колонке ---- */
  @media (max-width: 1120px) {
    .story-visual-wrap {
      order: 1;
    }
  }

  /* ---- Телефон (≤760px): полноэкранная сцена ---- */
  @media (max-width: 760px) {
    .story-visual-wrap {
      order: 1;
      width: 100%;
      height: 100svh;
      min-height: 560px;
      max-height: none;
      place-items: stretch;
      background: #000;
      animation: none;
      opacity: 1;
      transform: none;
    }

    .story-visual {
      width: 100%;
      height: 100%;
      max-height: none;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }

    /* Затемнение снизу под подпись/кнопки. */
    .story-visual::after {
      content: "";
      position: absolute;
      inset: auto 0 0;
      height: 42%;
      z-index: 3;
      background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.82));
      pointer-events: none;
    }

    .audio-chip {
      top: calc(env(safe-area-inset-top, 0) + 0.72rem);
      right: 0.72rem;
      z-index: 12;
      background: rgba(0, 0, 0, 0.52);
    }

    .story-mobile-caption {
      display: none;
      pointer-events: none;
    }

    .story-mobile-caption span {
      width: fit-content;
      padding: 0.22rem 0.5rem;
      border: 1px solid rgba(220, 38, 38, 0.35);
      border-radius: 7px;
      background: rgba(220, 38, 38, 0.12);
      color: #f87171;
      font-family: var(--font-mono);
      font-size: 0.7rem;
      font-weight: 900;
      text-transform: uppercase;
    }

    .story-mobile-caption strong {
      max-width: 13ch;
      color: #fff;
      font-size: clamp(2rem, 10.5vw, 3.25rem);
      line-height: 0.95;
      letter-spacing: 0;
      text-shadow: 0 4px 24px rgba(0, 0, 0, 0.75);
    }

    .story-mobile-actions {
      position: absolute;
      z-index: 12;
      left: 0.8rem;
      right: 0.8rem;
      bottom: calc(0.8rem + env(safe-area-inset-bottom, 0));
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.55rem;
      pointer-events: auto;
    }

    /* Круглая кнопка «Читать». */
    .story-read-trigger {
      position: absolute;
      z-index: 14;
      right: 1rem;
      bottom: calc(5.15rem + env(safe-area-inset-bottom, 0));
      width: 4.25rem;
      height: 4.25rem;
      display: grid;
      place-items: center;
      gap: 0.04rem;
      padding: 0.25rem;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      box-shadow: 0 12px 30px rgba(220, 38, 38, 0.42);
      font: 800 0.68rem / 1 var(--font-sans);
      cursor: pointer;
      transition:
        transform 0.18s ease,
        background 0.18s ease;
    }

    .story-read-trigger.is-open {
      background: rgba(220, 38, 38, 0.94);
      transform: scale(1.06);
    }

    .story-read-trigger svg {
      margin-top: 0.12rem;
    }
  }

  /* Кнопки Обсудить/Поделиться (мобильный низ сцены) стилизует общий
     story-actions.css — его подключает StoryPlayer.svelte. */

  @media (max-width: 440px) {
    .audio-chip span:last-child {
      display: none;
    }
  }
</style>
