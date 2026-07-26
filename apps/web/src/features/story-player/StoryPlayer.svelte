<!-- =============================================================================
  КОРЕНЬ ПЛЕЕРА. Единственный владелец состояния.
  ─────────────────────────────────────────────────────────────────────────────
  Всё состояние плеера объявлено здесь ($state ниже):
    active            — индекс активного поста
    manualPaused      — пользователь нажал паузу (пробел / клик по видео)
    readingVisible    — открыт режим «Читать» (текстовая панель на мобильном)
    discussionVisible — открыта вкладка обсуждения (giscus)
    expanded          — «Читать дальше» развёрнут
    feedMode          — режим ленты: latest / deep / watched
    audioState        — звук + обходы autoplay (чистая машина audio-state.ts)

  Дочерние компоненты (Rail / Visual / Context) НЕ имеют своего состояния —
  только props + коллбеки сюда. Хочешь новое поведение: state здесь,
  разметка в дочернем, сложные переходы — чистой функцией с тестом.

  Здесь же: клавиатура, свайпы, колесо мыши, автопереход (progress.ts),
  аналитика просмотров. Медиа-API (play/pause/load) — в $effect'ах внизу.

  СЮДА НЕЛЬЗЯ: SEO-разметку (h1/canonical/JSON-LD — слой Astro), запросы к БД.
============================================================================= -->
<script lang="ts">
import { onMount, tick } from "svelte";
import { createStoryViewTracker } from "../../scripts/story-player/analytics";
import {
  applyMutePreference,
  autoplayRejected,
  beginAutoplay,
  clearAutoplayMute,
  confirmFirstFrame,
  initialVideoAudioState,
  resetForNewStory,
} from "../../scripts/story-player/audio-state";
import { loadGiscusDiscussion } from "../../scripts/story-player/discussion";
import { setDiscussionVisibility } from "../../scripts/story-player/discussion-state";
import { advanceGallerySequence } from "../../scripts/story-player/gallery-state";
import { preloadAdjacentMedia } from "../../scripts/story-player/media";
import { readMutedPreference, writeMutedPreference } from "../../scripts/story-player/preferences";
import { createStoryProgressController } from "../../scripts/story-player/progress";
import { giscusConfig, storyIntervalMs, swipeThresholdPx, wheelCooldownMs } from "./config";
/* Общие стили пары кнопок «Обсудить»/«Поделиться»: их рисуют и сцена, и правая
   панель, поэтому блок вынесен из обоих scoped-блоков сюда (см. сам файл). */
import "./story-actions.css";
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";
import RailControl from "./RailControl.svelte";
import StoryContext from "./StoryContext.svelte";
import StoryRail from "./StoryRail.svelte";
import StoryVisual from "./StoryVisual.svelte";

let {
  posts,
  ui,
  locale,
  initialPaused = false,
}: { posts: PlayerPost[]; ui: StoryUi; locale: "en" | "ru"; initialPaused?: boolean } = $props();

/* ------------------------------- Состояние ------------------------------- */
/* Проп initialPaused читается ровно один раз — это стартовое значение,
     дальше паузой управляет пользователь, реактивность пропа не нужна. */
// svelte-ignore state_referenced_locally
const startPaused = initialPaused;
let active = $state(0);
let manualPaused = $state(startPaused);
let manualPausedBeforeDiscussion = $state(startPaused);
let manualPausedBeforeReading = $state(startPaused);
let readingVisible = $state(false);
let discussionVisible = $state(false);
let expanded = $state(false);
let feedMode = $state("latest");
let audioState = $state(initialVideoAudioState(true));
let updating = $state(false); // короткая анимация смены поста (.is-updating)
let readMoreVisible = $state(false);
let feedMenuOpen = $state(false);
let shareCopied = $state(false);
let overlayTick = $state(0); // перезапускает анимацию play/pause-оверлея
let debugEnabled = $state(false);
let gallerySubIndex = $state(0); // текущий слайд, если у поста несколько картинок

const activePost = $derived(posts[active] ?? posts[0]);
const paused = $derived(manualPaused);
/* Несколько картинок у поста-не-видео → листаем их по очереди перед
     переходом к следующему посту (см. advanceStory). */
const gallerySequence = $derived(activePost?.mediaType === "video" ? [] : activePost?.gallery || []);
const visibleIndexes = $derived.by(() => {
  const visible = posts
    .map((post, index) => ({ post, index }))
    .filter(({ post }) => feedMode === "latest" || post.feedModes.includes(feedMode))
    .map(({ index }) => index);
  return visible.length ? visible : posts.map((_, index) => index);
});

/* Элементы, которыми управляем императивно (media API, прогресс, giscus). */
let root = $state<HTMLElement | null>(null);
let video = $state<HTMLVideoElement | null>(null);
let audio = $state<HTMLAudioElement | null>(null);
let progressFill = $state<HTMLElement | null>(null);
let discussionFrame = $state<HTMLElement | null>(null);
let copyEl = $state<HTMLElement | null>(null);

let progress: ReturnType<typeof createStoryProgressController> | null = null;
let viewTracker: ReturnType<typeof createStoryViewTracker> | null = null;
let discussionTerm = "";
let mounted = false;

const normalizedPath = (value: string) => {
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  } catch {
    return "/";
  }
};

/* ------------------------- Навигация между постами ------------------------ */
function nextVisibleIndex(direction: number): number {
  const currentPosition = visibleIndexes.indexOf(active);
  if (currentPosition === -1) return visibleIndexes[0] ?? active;
  return visibleIndexes[(currentPosition + direction + visibleIndexes.length) % visibleIndexes.length] ?? active;
}

/** Аналог старого render(): смена активного поста + все сопутствующие сбросы. */
function goTo(index: number, options: { keepProgressIdle?: boolean } = {}): void {
  active = ((index % posts.length) + posts.length) % posts.length;
  expanded = false;
  gallerySubIndex = 0;
  audioState = resetForNewStory(audioState);
  if (readingVisible) setReading(false);
  setDiscussion(false);
  updating = true;
  progress?.resetForStory(options);
  viewTracker?.scheduleStoryView(activePost);
  preloadAdjacentMedia({ active, posts, toPublicSrc: (value) => value ?? "" });
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => (updating = false));
  });
}

function navigate(direction: number): void {
  goTo(nextVisibleIndex(direction), { keepProgressIdle: true });
  progress?.resumeAfterManualNavigation();
}

/** Таймер прогресса истёк: если у поста ещё есть непоказанные картинки —
      листаем на следующую и просто перезапускаем полосу прогресса, иначе —
      обычный переход к следующему посту. */
function advanceStory(): void {
  const next = advanceGallerySequence(gallerySubIndex, gallerySequence.length);
  if (next.advancePost) {
    goTo(nextVisibleIndex(1));
    return;
  }
  gallerySubIndex = next.subIndex;
  progress?.resetForSlide();
}

function selectGalleryImage(index: number): void {
  if (index === gallerySubIndex || index < 0 || index >= gallerySequence.length) return;
  gallerySubIndex = index;
  progress?.resumeAfterManualNavigation();
}

/* ------------------------------ Пауза и звук ------------------------------ */
function togglePause(): void {
  manualPaused = !manualPaused;
  overlayTick += 1;
  syncPlayback();
}

function syncPlayback(): void {
  progress?.update(paused);
  if (video && activePost?.mediaType === "video") {
    if (paused) video.pause?.();
    else playActiveVideo();
  }
}

function setMuted(nextMuted: boolean, persist = true): void {
  audioState = applyMutePreference(nextMuted);
  if (persist) writeMutedPreference(audioState.muted);
  if (audio) {
    audio.muted = audioState.muted;
    if (!audioState.muted && audio.getAttribute("src") && activePost?.mediaType !== "video") audio.play?.().catch(() => {});
    else audio.pause?.();
  }
  if (video) video.muted = audioState.muted;
}

function onAudioToggle(): void {
  if (audioState.videoAutoplayMuted && video) {
    audioState = clearAutoplayMute(audioState);
    video.muted = false;
    video.play?.().catch(() => {});
    return;
  }
  setMuted(!audioState.muted);
}

/* Autoplay-политики браузеров: вся логика переходов — в audio-state.ts. */
function playActiveVideo(): void {
  if (!video || activePost?.mediaType !== "video") return;
  const el = video;
  const play = () => {
    const intent = beginAutoplay(audioState);
    audioState = intent.state;
    if (intent.muteBeforePlay) el.muted = true;
    const mutedBeforePlay = el.muted;
    el.play?.().catch(() => {
      const rejection = autoplayRejected(audioState, mutedBeforePlay);
      audioState = rejection.state;
      if (rejection.retryMuted) {
        el.muted = true;
        el.play?.().catch(() => {});
      }
    });
  };
  if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) el.addEventListener("canplay", play, { once: true });
  else play();
}

function onVideoTimeUpdate(): void {
  progress?.handleVideoTimeUpdate();
}

function onVideoPlaying(): void {
  progress?.handleVideoPlaying();
  const confirmation = confirmFirstFrame(audioState, { isManualPaused: manualPaused });
  audioState = confirmation.state;
  if (!confirmation.shouldRestoreSound) return;
  const el = video;
  if (!el || audioState.muted || manualPaused || activePost?.mediaType !== "video") return;
  el.muted = false;
  audioState = clearAutoplayMute(audioState);
  // Some browsers silently pause playback when script unmutes without a
  // fresh user gesture; retry once so the story doesn't freeze mid-video.
  if (el.paused) el.play?.().catch(() => {});
}

/* -------------------------- Чтение и обсуждение --------------------------- */
function setReading(visible: boolean): void {
  readingVisible = visible;
  if (visible) {
    manualPausedBeforeReading = manualPaused;
    manualPaused = true;
  } else {
    manualPaused = manualPausedBeforeReading;
  }
  syncPlayback();
}

function setDiscussion(visible: boolean): void {
  const nextState = setDiscussionVisibility(
    { visible: discussionVisible, isManualPaused: manualPaused, manualPausedBeforeDiscussion },
    visible,
  );
  discussionVisible = nextState.visible;
  manualPaused = nextState.isManualPaused;
  manualPausedBeforeDiscussion = nextState.manualPausedBeforeDiscussion;
  syncPlayback();
}

function openDiscussion(): void {
  if (discussionVisible) {
    setDiscussion(false);
    return;
  }
  const discussionUrl = new URL(activePost.url, window.location.origin);
  discussionUrl.searchParams.set("discussion", "1");
  window.history.replaceState(window.history.state, "", `${discussionUrl.pathname}${discussionUrl.search}${discussionUrl.hash}`);
  discussionTerm = loadGiscusDiscussion({
    post: activePost,
    discussionFrame,
    giscusConfig: { ...giscusConfig, lang: locale },
    ui: ui as unknown as Record<string, string>,
    currentTerm: discussionTerm,
  });
  setDiscussion(true);
}

async function share(): Promise<void> {
  const url = new URL(activePost.url, window.location.origin).href;
  try {
    if (navigator.share) await navigator.share({ title: activePost.title, url });
    else {
      await navigator.clipboard.writeText(url);
      shareCopied = true;
      window.setTimeout(() => (shareCopied = false), 1400);
    }
  } catch (error) {
    /* Закрыл системный лист — это отказ, а не сбой: копировать ссылку в буфер
       за спиной пользователя нельзя. Копируем только если сам share сломался. */
    if (error instanceof Error && error.name === "AbortError") return;
    await navigator.clipboard?.writeText(url).catch(() => {});
    shareCopied = true;
    window.setTimeout(() => (shareCopied = false), 1400);
  }
}

/* ------------------------------ Режим ленты ------------------------------- */
function selectFeedMode(mode: string): void {
  feedMenuOpen = false;
  if (mode === feedMode) return;
  feedMode = mode;
  goTo(visibleIndexes.includes(active) ? active : (visibleIndexes[0] ?? 0), { keepProgressIdle: true });
  progress?.resumeAfterManualNavigation();
}

/* ------------------------- Жесты: колесо и свайпы ------------------------- */
let lastWheelTime = 0;
let wheelGestureLocked = false;
let wheelUnlockTimer: number | null = null;
function handleWheel(event: WheelEvent): void {
  if (Math.abs(event.deltaY) < 10) return;
  event.preventDefault();
  const now = Date.now();
  if (wheelGestureLocked || now - lastWheelTime < wheelCooldownMs) return;
  lastWheelTime = now;
  wheelGestureLocked = true;
  if (wheelUnlockTimer) window.clearTimeout(wheelUnlockTimer);
  wheelUnlockTimer = window.setTimeout(() => {
    wheelGestureLocked = false;
    wheelUnlockTimer = null;
  }, wheelCooldownMs);
  navigate(event.deltaY > 0 ? 1 : -1);
}

let touchStartX = 0;
function onTouchStart(event: TouchEvent): void {
  touchStartX = event.touches[0]?.clientX || 0;
}
function onTouchEnd(event: TouchEvent): void {
  const delta = (event.changedTouches[0]?.clientX || 0) - touchStartX;
  if (Math.abs(delta) > swipeThresholdPx) navigate(delta < 0 ? 1 : -1);
}

const isTypingTarget = (element: Element | null) => {
  const tagName = element?.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
};
function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || isTypingTarget(document.activeElement)) return;
  if (event.key === "Escape" && readingVisible) {
    event.preventDefault();
    setReading(false);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "PageDown") {
    event.preventDefault();
    navigate(1);
  } else if (event.key === "ArrowUp" || event.key === "PageUp") {
    event.preventDefault();
    navigate(-1);
  } else if (event.key === " ") {
    event.preventDefault();
    togglePause();
  }
}

/* --------------------------- Эффекты и mount ------------------------------ */
/* Смена поста или паузы → синхронизировать <video>/<audio> с состоянием.
     Единственное место, где дозволен «ручной» DOM: media API и измерения. */
$effect(() => {
  void active;
  if (!mounted) return;
  tick().then(() => {
    if (video && activePost?.mediaType === "video") {
      video.muted = audioState.muted;
      video.load();
      if (!paused) playActiveVideo();
    }
    if (audio) {
      audio.pause?.();
      if (activePost?.audioUrl && activePost.mediaType !== "video") {
        audio.muted = audioState.muted;
        if (!audioState.muted && !paused) audio.play?.().catch(() => {});
      }
    }
    measureReadMore();
  });
});

/* Влезает ли текст — зависит от высоты колонки, а она меняется и без смены
   поста: поворот экрана, ресайз окна, схлопывание адресной строки на мобильном.
   Без этого «Читать дальше» показывал состояние прошлого размера. */
$effect(() => {
  const element = copyEl;
  if (!element) return;
  const observer = new ResizeObserver(() => measureReadMore());
  observer.observe(element);
  return () => observer.disconnect();
});

/* «Читать дальше» показывается, только если текст реально не влез. */
function measureReadMore(): void {
  window.requestAnimationFrame(() => {
    if (!copyEl) return;
    readMoreVisible = copyEl.scrollHeight > copyEl.clientHeight + 4 || expanded;
  });
}

onMount(() => {
  debugEnabled = new URLSearchParams(window.location.search).has("debug");
  audioState = initialVideoAudioState(readMutedPreference());
  progress = createStoryProgressController({
    getVideo: () => video,
    getProgressFill: () => progressFill,
    posts,
    activeIndex: () => active,
    isPaused: () => paused,
    onAdvance: () => advanceStory(),
    intervalMs: storyIntervalMs,
  });
  viewTracker = createStoryViewTracker({ activeIndex: () => active, normalizedPath });
  mounted = true;
  goTo(0);
  if (new URLSearchParams(window.location.search).get("discussion") === "1") {
    window.setTimeout(() => openDiscussion(), 0);
  }
  return () => {
    if (wheelUnlockTimer) window.clearTimeout(wheelUnlockTimer);
  };
});
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document
  onclick={() => {
    feedMenuOpen = false;
  }}
/>

<section
  bind:this={root}
  class="story-player"
  class:is-discussing={discussionVisible}
  class:is-reading={readingVisible}
  aria-label={ui.storyLabel}
  data-story-player
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
>
  <div class="story-player__main">
    <div class="story-rail-container" onwheel={handleWheel}>
      <RailControl
        {ui}
        {locale}
        {feedMode}
        {feedMenuOpen}
        ontogglemenu={() => (feedMenuOpen = !feedMenuOpen)}
        onselectmode={selectFeedMode}
      />
      <StoryRail {posts} {ui} {active} {visibleIndexes} onselect={(index) => {
        if (!visibleIndexes.includes(index)) return;
        goTo(index, { keepProgressIdle: true });
        progress?.resumeAfterManualNavigation();
      }} />
    </div>
    <StoryVisual
      post={activePost}
      {ui}
      {paused}
      muted={audioState.muted}
      autoplayMuted={audioState.videoAutoplayMuted}
      {overlayTick}
      {shareCopied}
      readingVisible={readingVisible}
      {gallerySubIndex}
      bind:video
      bind:audio
      bind:progressFill
      onwheel={handleWheel}
      ontoggleplay={togglePause}
      onaudiotoggle={onAudioToggle}
      ontoggleread={() => setReading(!readingVisible)}
      onopendiscussion={openDiscussion}
      onshare={share}
      onvideoplaying={onVideoPlaying}
      onvideotimeupdate={onVideoTimeUpdate}
      onvideoended={() => progress?.handleVideoEnded()}
      onvideowaiting={() => progress?.handleVideoWaiting()}
      onselectgallery={selectGalleryImage}
    />
    <StoryContext
      post={activePost}
      {ui}
      {updating}
      {expanded}
      {readMoreVisible}
      {discussionVisible}
      {readingVisible}
      {shareCopied}
      bind:copyEl
      bind:discussionFrame
      ontogglereadmore={() => {
        expanded = !expanded;
        measureReadMore();
      }}
      onopendiscussion={openDiscussion}
      onshare={share}
    />
  </div>
  {#if debugEnabled}
    <pre class="story-debug-panel">{JSON.stringify(
        {
          active,
          postId: activePost?.id,
          paused,
          manualPaused,
          mediaType: activePost?.mediaType,
          url: activePost?.url,
          gallerySubIndex,
          gallerySequenceLength: gallerySequence.length,
        },
        null,
        2,
      )}</pre>
  {/if}
</section>

<style>
  /* -------------------- Сетка плеера (rail | сцена | текст) ----------------- */
  .story-player {
    position: relative;
    display: grid;
    gap: 0;
  }

  .story-player__main {
    display: grid;
    grid-template-columns:
      minmax(250px, 370px)
      minmax(520px, calc((100dvh - 0.25rem) * 0.5625))
      minmax(360px, 560px);
    gap: clamp(0.5rem, 0.72vw, 0.85rem);
    align-items: center;
    justify-content: center;
    height: calc(100dvh - 0.25rem);
    min-height: 700px;
    max-height: calc(100dvh - 0.25rem);
  }

  /* ------------------- Контейнер ленты + геометрия карточек ----------------- */
  .story-rail-container {
    /* Геометрия ленты: фиксированное число видимых карточек, активная
       по центру (индекс 2). Всё ниже выводится из этих двух значений —
       меняешь количество карточек или зазор только здесь. Переменные
       наследуются в StoryRail.svelte. */
    --rail-cards: 5;
    --rail-gap: 0.55rem;
    --rail-card-height: calc((100% - (var(--rail-cards) - 1) * var(--rail-gap)) / var(--rail-cards));
    --rail-active-offset: calc(2 * (var(--rail-card-height) + var(--rail-gap)));
    position: relative;
    grid-column: 1;
    height: 100%;
    min-height: 0;
    width: 100%;
    padding-left: 50px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Панель управления (аватар + режимы ленты) — в RailControl.svelte;
     её геометрия выведена из --rail-* выше и наследуется туда. */

  /* ------------------------ Дебаг-панель (?debug=1) -------------------------- */
  .story-debug-panel {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: var(--z-debug);
    max-width: min(360px, calc(100vw - 24px));
    max-height: 48vh;
    overflow: auto;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.82);
    color: #e5e7eb;
    font: 12px / 1.45 var(--font-mono);
    white-space: pre-wrap;
  }

  /* ---- Компактный десктоп (низкие окна) ---- */
  @media (max-height: 800px) and (min-width: 1121px) {
    .story-player__main {
      height: calc(100vh - 0.75rem);
      min-height: 0;
    }
  }

  /* ---- Планшет (≤1120px): одна колонка, лента снизу горизонтально ---- */
  @media (max-width: 1120px) {
    .story-player__main {
      grid-template-columns: 1fr;
      height: auto;
      min-height: 0;
      max-height: none;
      gap: 1rem;
    }

    .story-rail-container {
      order: 3;
      width: min(100%, 720px);
      justify-self: center;
      height: auto;
      min-height: 0;
      flex-direction: row;
      flex-wrap: wrap;
      padding-left: 0;
    }
  }

  /* ---- Телефон (≤760px): плеер во весь экран, лента скрыта ---- */
  @media (max-width: 760px) {
    .story-player {
      display: block;
    }

    .story-player__main {
      display: flex;
      flex-direction: column;
      gap: 0;
      width: 100%;
      min-height: 0;
      height: auto;
      max-height: none;
    }

    .story-rail-container {
      display: none;
    }
  }
</style>
