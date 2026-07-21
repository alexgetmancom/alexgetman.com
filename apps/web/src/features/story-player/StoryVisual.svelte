<!-- =============================================================================
  ЦЕНТРАЛЬНАЯ СЦЕНА: фото/видео активного поста.
  ─────────────────────────────────────────────────────────────────────────────
  Презентационный компонент: своего состояния нет (кроме локального
  play/pause-оверлея). Что здесь живёт:
    - <img>/<video>/<audio> активного поста (элементы отдаёт корню через bind:)
    - горизонтальный прогресс-бар (заполнением управляет progress.ts из корня)
    - кнопка звука, кнопка «Читать», мобильная подпись и мобильные кнопки
    - галерея-миниатюры, если у поста больше одного медиа
  Все клики уходят коллбеками в StoryPlayer.svelte.
  Стили — в <style> внизу (scoped), включая мобильный полноэкранный режим.
  Особый случай: @keyframes storyProgressHorizontal объявлен глобальным
  (-global-), потому что его имя подставляет progress.ts из JS.
============================================================================= -->
<script lang="ts">
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";

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
  const img = event.currentTarget as HTMLImageElement;
  if (post.fallbackImage && img.getAttribute("src") !== post.fallbackImage) {
    img.setAttribute("src", post.fallbackImage);
    img.removeAttribute("srcset");
  } else {
    img.style.display = "none";
  }
}
</script>

<div class="story-visual-wrap">
  <article class="story-visual" class:story-visual--no-image={!post.image} data-story-visual {onwheel}>
    <span class="story-visual-progress" aria-hidden="true">
      <i bind:this={progressFill}></i>
    </span>
    <a
      class="story-visual__link"
      href={post.url}
      aria-label={post.title}
      onclick={(event) => {
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
    {#if post.gallery.length >= 2}
      <div class="story-media-gallery" aria-label="Post media">
        {#each post.gallery as media, index}
          <a
            href={media.path}
            target="_blank"
            rel="noopener noreferrer"
            class:is-active={hasGallerySequence && index === gallerySubIndex}
            onclick={(event) => {
              if (!hasGallerySequence || media.type !== "image") return;
              event.preventDefault();
              onselectgallery?.(index);
            }}
          >
            <img
              src={media.type === "video" ? media.poster || media.path : media.path}
              alt={`${post.title} — ${index + 1}`}
              loading="lazy"
            />
          </a>
        {/each}
      </div>
    {/if}
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
    {#key overlayTick}
      {#if overlayTick > 0}
        <div class="play-pause-overlay is-visible">
          <div class={`play-pause-icon ${paused ? "is-paused" : "is-playing"}`}></div>
        </div>
      {/if}
    {/key}
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

  /* -------------------- Полоса прогресса текущего поста --------------------- */
  .story-visual-progress {
    position: absolute;
    z-index: var(--z-overlay);
    top: 2px;
    left: 6px;
    right: 6px;
    height: 4px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.32);
    pointer-events: none;
  }

  .story-visual-progress i {
    display: block;
    width: 100%;
    height: 100%;
    transform: scaleX(0);
    transform-origin: left center;
    background: var(--accent);
    box-shadow: 0 0 12px rgba(220, 38, 38, 0.62);
  }

  /* Имя keyframes глобальное (-global-): его подставляет progress.ts из JS. */
  @keyframes -global-storyProgressHorizontal {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }

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

  /* --------------------- Галерея миниатюр (2+ медиа) ------------------------ */
  .story-media-gallery {
    position: absolute;
    z-index: 8;
    right: 0.55rem;
    bottom: 0.55rem;
    left: 0.55rem;
    display: flex;
    gap: 0.38rem;
    overflow-x: auto;
    padding: 0.3rem;
    border-radius: 0.5rem;
    background: rgba(0, 0, 0, 0.48);
    scrollbar-width: thin;
  }

  .story-media-gallery a {
    display: block;
    flex: 0 0 3.2rem;
    height: 3.2rem;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.6);
    border-radius: 0.32rem;
    background: #000;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }

  .story-media-gallery a.is-active {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.35);
  }

  .story-media-gallery img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
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

  /* -------------------- Оверлей play/pause по клику ------------------------- */
  .play-pause-overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.12);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }

  .play-pause-overlay.is-visible {
    animation: playPauseFlash 0.65s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  .play-pause-icon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: grid;
    place-items: center;
    position: relative;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /* Пауза: две вертикальные полосы. */
  .play-pause-icon.is-paused::before,
  .play-pause-icon.is-paused::after {
    content: "";
    width: 6px;
    height: 20px;
    background: #ffffff;
    border-radius: 2px;
    position: absolute;
    top: 22px;
  }
  .play-pause-icon.is-paused::before {
    left: 23px;
  }
  .play-pause-icon.is-paused::after {
    right: 23px;
  }

  /* Плей: треугольник. */
  .play-pause-icon.is-playing::before {
    content: "";
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 10px 0 10px 18px;
    border-color: transparent transparent transparent #ffffff;
    position: absolute;
    left: 25px;
    top: 22px;
  }

  @keyframes playPauseFlash {
    0% {
      opacity: 0;
      transform: scale(0.85);
    }
    15% {
      opacity: 1;
      transform: scale(1);
    }
    85% {
      opacity: 1;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(1.08);
    }
  }

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

    .story-visual-progress {
      height: 4px;
      top: calc(env(safe-area-inset-top, 0) + 2px);
      left: 0.55rem;
      right: 0.55rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.24);
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

  /* Кнопки Обсудить/Поделиться (мобильный низ сцены). Базовые стили
     продублированы в StoryContext.svelte — там своя пара кнопок. */
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

  @media (max-width: 760px) {
    .story-action {
      min-height: 48px;
      border-radius: 11px;
      background: rgba(0, 0, 0, 0.58);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }

    .story-action--primary {
      background: var(--accent);
    }
  }

  @media (max-width: 440px) {
    .audio-chip span:last-child {
      display: none;
    }
  }
</style>
