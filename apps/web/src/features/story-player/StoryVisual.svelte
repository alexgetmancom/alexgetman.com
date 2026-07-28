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
import { readTapIntent } from "../../scripts/story-player/gestures";
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
  soundPrompt,
  overlayTick,
  shareCopied,
  readingVisible,
  discussionVisible,
  gallerySubIndex = 0,
  video = $bindable(null),
  audio = $bindable(null),
  progressFill = $bindable(null),
  onwheel,
  ontoggleplay,
  ongrantsound,
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
  soundPrompt: boolean;
  overlayTick: number;
  shareCopied: boolean;
  readingVisible: boolean;
  discussionVisible: boolean;
  gallerySubIndex?: number;
  video?: HTMLVideoElement | null;
  audio?: HTMLAudioElement | null;
  progressFill?: HTMLElement | null;
  onwheel: (event: WheelEvent) => void;
  ontoggleplay: () => void;
  ongrantsound: () => void;
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
/* A video carries its own soundtrack; a still only has sound if the post ships
 * an audio track. Anything else has nothing to mute. */
const hasAudio = $derived(isVideo ? !videoFailed : Boolean(post.audioUrl));
/* Ask for sound while it is off and the visitor has not answered yet — either
 * because the browser refused an unmuted autoplay, or simply because muted is
 * the default nobody has overridden. Both look identical from here. */
const showSoundPrompt = $derived(soundPrompt && (muted || autoplayMuted));

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

/* How much of each side pages the gallery. Wide enough to hit with a thumb
   without looking, narrow enough to leave the picture itself a play/pause
   target — the same proportion the stories apps use. */
const TAP_EDGE_RATIO = 0.28;

function onStageClick(event: MouseEvent & { currentTarget: HTMLElement }): void {
  /* detail is 0 for a click the keyboard synthesised on the focused link, and
     such an event carries clientX 0 — which the zones would read as a tap on
     the far left. Enter on the stage means play/pause, as it always did. */
  const rect = event.currentTarget.getBoundingClientRect();
  const intent =
    event.detail > 0 && rect.width > 0
      ? readTapIntent((event.clientX - rect.left) / rect.width, hasGallerySequence, TAP_EDGE_RATIO)
      : "toggle-play";
  if (intent === "toggle-play") {
    ontoggleplay();
    return;
  }
  /* Clamped, not wrapped: paging past either end of the gallery does nothing
     rather than jumping to a neighbouring post. The edges of the stage answer
     for the pictures inside this post; moving between posts is the swipe. */
  onselectgallery?.(gallerySubIndex + (intent === "next-image" ? 1 : -1));
}
</script>

<div class="story-visual-wrap">
  <article class="story-visual" class:story-visual--no-image={!post.image} data-story-visual {onwheel}>
    <!-- A soft darkening band under the top overlay. The progress bar is white,
         which is right over most photos and invisible over a light one — and
         plenty of posts are screenshots of white pages. A scrim fixes it for
         every image at once, instead of trying to pick a bar colour that works
         on all of them. -->
    <span class="story-visual__top-scrim" aria-hidden="true"></span>
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
        onStageClick(event);
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
    <!-- Only rendered when this post can actually make a sound. A video always
         can; a still needs its own audio track. Without the guard every plain
         image story showed a mute control that toggled silence. -->
    <!-- Autoplay policy: browsers refuse to start a video with sound until the
         user has interacted with the page, so the clip always begins muted and
         the state machine flags it (videoAutoplayMuted). That flag is a call to
         action, not a status — the voice-over is the story. It gets a plate on
         the stage until sound is granted; after that the quiet corner chip is
         enough, and the choice is remembered for the session. -->
    {#if hasAudio && showSoundPrompt}
      <button class="sound-cta" type="button" onclick={ongrantsound}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z"></path>
          <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
          <path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
        </svg>
        <span>{ui.tapForSound}</span>
      </button>
    {/if}
    {#if hasAudio && !showSoundPrompt}
      <button
        class="audio-chip"
        class:is-on={!muted && !autoplayMuted}
        type="button"
        aria-pressed={muted}
        aria-label={audioLabel}
        onclick={onaudiotoggle}
      >
        <svg class="audio-chip__icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z"></path>
          {#if muted || autoplayMuted}
            <line x1="17" y1="9" x2="22" y2="15"></line>
            <line x1="22" y1="9" x2="17" y2="15"></line>
          {:else}
            <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
            <path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
          {/if}
        </svg>
        <span>{audioLabel}</span>
      </button>
    {/if}
    <div class="story-mobile-caption" aria-hidden="true">
      <span>{post.category}</span>
      <strong>{post.title}</strong>
    </div>
    <!-- Three equal items in one floating bar. Nothing is lit until a panel is
         actually open — see story-actions.css. -->
    <div class="story-action-bar" aria-label={ui.storyLabel}>
      <button
        class="story-action"
        class:is-open={readingVisible}
        type="button"
        aria-expanded={readingVisible}
        onclick={ontoggleread}
      >
        <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <path d="M14 2v6h6"></path>
          <path d="M8 13h8"></path>
          <path d="M8 17h6"></path>
        </svg>
        <span class="story-action__label">{readingVisible ? ui.back : ui.read}</span>
      </button>
      <button
        class="story-action"
        class:is-open={discussionVisible}
        type="button"
        aria-expanded={discussionVisible}
        onclick={onopendiscussion}
      >
        <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="story-action__label">{ui.discuss}</span>
      </button>
      <button class="story-action" type="button" onclick={onshare}>
        {#if shareCopied}
          <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5"></path>
          </svg>
        {:else}
          <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
        {/if}
        <span class="story-action__label">{shareCopied ? ui.copied : ui.share}</span>
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
    /* Neutral hairline. --border-hover is crimson-tinted, so the stage wore a
       red outline on both themes — glaring on the light one, and it framed the
       media as if it were an alert. */
    border: 1px solid var(--border);
    border-radius: 10px;
    /* The base layer is opaque on purpose. It used to be rgba(0, 0, 0, 0.58),
     * which looked black only because the page behind it was black; on the
     * light theme the same value composites to grey and the stage stops
     * reading as a media frame. The sheen gradient stays on top. */
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.012)), var(--bg-deep);
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

  .story-visual__top-scrim {
    position: absolute;
    z-index: var(--z-above);
    inset: 0 0 auto;
    height: 4.5rem;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0));
    pointer-events: none;
  }

  /* Sits just above the action bar, centred: the one thing to tap before the
   * story makes sense. It disappears for good once sound is granted. */
  .sound-cta {
    position: absolute;
    z-index: 13;
    left: 50%;
    bottom: calc(4.2rem + env(safe-area-inset-bottom, 0));
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 44px;
    padding: 0.5rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: #f3f6fa;
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }

  .sound-cta:hover {
    background: rgba(0, 0, 0, 0.75);
    border-color: rgba(255, 255, 255, 0.34);
  }

  /* ------------------------------ Sound control ----------------------------- */
  /* Same pill language as the action bar (story-actions.css): translucent dark
   * fill, hairline border, icon plus label. It is a stage overlay rather than a
   * bar item, so the geometry lives here while the vocabulary is shared. */
  .audio-chip {
    position: absolute;
    z-index: 4;
    right: 0.8rem;
    top: 2.05rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 34px;
    padding: 0.25rem 0.62rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--text-main);
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 0.18s ease,
      border-color 0.18s ease,
      color 0.18s ease;
  }

  .audio-chip__icon {
    flex: 0 0 auto;
    opacity: 0.85;
  }

  /* Sound is on: the control is the only cue for that, so it brightens instead
   * of staying uniform with its muted state. */
  .audio-chip.is-on {
    border-color: rgba(255, 255, 255, 0.24);
    color: #f3f6fa;
  }

  .audio-chip.is-on .audio-chip__icon {
    opacity: 1;
  }

  .audio-chip:hover {
    background: rgba(0, 0, 0, 0.65);
    border-color: rgba(255, 255, 255, 0.24);
    color: #f3f6fa;
  }

  /* Sound on is a lighter chip, not a red one. Everything over the stage uses
     the un-themed --overlay-* palette; crimson here read as a warning. */
  .audio-chip.is-on {
    border-color: var(--overlay-border);
    color: var(--overlay-text-strong);
    background: var(--overlay-fill);
  }

  /* Мобильные элементы: на десктопе скрыты. */
  .story-mobile-caption {
    display: none;
  }

  /* The bar is the phone layout's bottom strip. On desktop the same three
   * actions live at the foot of the context panel (StoryContext), styled by the
   * same .story-action rules, so there is one button language rather than two. */
  .story-action-bar {
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
      /* The bottom strip belongs to the controls, not to the picture, and its
         height is --stage-actions-strip in tokens.css — the reading sheet has
         to hang off the same number. Reserved rather than left over: a phone
         screen is taller than 9:16, so contain-fitting a 9:16 story leaves a
         margin, but on a narrow handset (an SE is 375x667, almost exactly 9:16)
         that margin is nearly zero and the bar would land back on the image.
         Reserving it keeps one layout on every phone; only the picture's height
         changes. */
    }

    /* The media box stops above the strip, and the picture sits at the top of
       it. The stage used to centre the media, which split the leftover height
       into two bands — one of them between the progress bar and the story, so
       the story appeared to start well down the screen. All of the slack now
       collects underneath, where the controls are. */
    /* Sized, not inset. An absolutely positioned replaced element resolves
       `height: auto` from its intrinsic size, not from a bottom offset, so
       `inset: 0 0 <strip>` left the picture at its own height and ignored the
       strip entirely — measured 375px tall in a 738px box. An explicit height
       is the only form that holds for <img> and <video> alike. */
    .story-visual__link img,
    .story-visual__link video,
    .story-visual__fallback {
      inset: 0 0 auto;
      height: calc(100% - var(--stage-actions-strip));
    }

    .story-visual__link img,
    .story-visual__link video {
      object-position: top center;
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

    /* Geometry only — the bar's surface, blur and items are in
     * story-actions.css, shared with the desktop panel. It floats clear of the
     * screen edges instead of spanning them, which is what makes it read as a
     * control layer sitting on the story rather than a strip cut out of it.
     *
     * The read action used to be a separate 4.25rem crimson circle above this
     * row, with its own radius, shadow and font: a fourth visual language on a
     * screen that already had three. */
    .story-action-bar {
      /* Scoped, so it beats the display:flex in story-actions.css — the base
         rule up top hides the bar on desktop and this is what brings it back. */
      display: flex;
      position: absolute;
      z-index: 12;
      left: 0.7rem;
      right: 0.7rem;
      bottom: calc(0.7rem + env(safe-area-inset-bottom, 0));
      pointer-events: auto;
      /* It now sits below the picture rather than on top of it, so it no longer
         needs to hold its own against a photo: the blur and the translucent
         fill from story-actions.css would just be a smudge over a flat dark
         strip. */
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      background: transparent;
      border-color: transparent;
    }
  }

  /* The buttons themselves are styled by the shared story-actions.css, loaded
     once from StoryPlayer.svelte, so the bar and the desktop context panel
     cannot drift apart. */

  /* Same cut-off as the action bar's labels: with a real speaker icon the state
     is readable without the word, but only drop it once the row is genuinely
     out of room. */
  @media (max-width: 359px) {
    .audio-chip span:last-child {
      display: none;
    }
  }
</style>
