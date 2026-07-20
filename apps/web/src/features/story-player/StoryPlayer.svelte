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
  import {
    applyMutePreference,
    autoplayRejected,
    beginAutoplay,
    clearAutoplayMute,
    confirmFirstFrame,
    initialVideoAudioState,
    resetForNewStory,
  } from "../../scripts/story-player/audio-state";
  import { createStoryViewTracker } from "../../scripts/story-player/analytics";
  import { loadGiscusDiscussion } from "../../scripts/story-player/discussion";
  import { setDiscussionVisibility } from "../../scripts/story-player/discussion-state";
  import { preloadAdjacentMedia } from "../../scripts/story-player/media";
  import { readMutedPreference } from "../../scripts/story-player/preferences";
  import { createStoryProgressController } from "../../scripts/story-player/progress";
  import type { StoryPost } from "../../scripts/story-player/types";
  import { desktopMediaQuery, giscusConfig, storyIntervalMs, swipeThresholdPx, wheelCooldownMs } from "./config";
  import type { StoryUi } from "./i18n";
  import type { PlayerPost } from "./payload";
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
  let active = $state(0);
  let manualPaused = $state(initialPaused);
  let manualPausedBeforeDiscussion = $state(initialPaused);
  let manualPausedBeforeReading = $state(initialPaused);
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

  const activePost = $derived(posts[active] ?? posts[0]);
  const paused = $derived(manualPaused);
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

  const isDesktopViewport = () => window.matchMedia(desktopMediaQuery).matches;
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
    audioState = resetForNewStory(audioState);
    if (readingVisible) setReading(false);
    setDiscussion(false);
    updating = true;
    progress?.resetForStory(options);
    viewTracker?.scheduleStoryView(activePost as unknown as StoryPost);
    preloadAdjacentMedia({ active, posts: posts as unknown as StoryPost[], toPublicSrc: (value) => value ?? "" });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => (updating = false));
    });
  }

  function navigate(direction: number): void {
    goTo(nextVisibleIndex(direction), { keepProgressIdle: true });
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
    if (persist) {
      try {
        localStorage.setItem("story-player-muted", String(audioState.muted));
      } catch {}
    }
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
      const intent = beginAutoplay(audioState, isDesktopViewport());
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
    const confirmation = confirmFirstFrame(audioState, { isManualPaused: manualPaused, isDesktopViewport: isDesktopViewport() });
    audioState = confirmation.state;
    if (!confirmation.shouldRestoreSound) return;
    window.requestAnimationFrame(() => {
      if (!video || audioState.muted || manualPaused || activePost?.mediaType !== "video") return;
      video.muted = false;
      audioState = clearAutoplayMute(audioState);
    });
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
      post: activePost as unknown as StoryPost,
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
    } catch {
      await navigator.clipboard?.writeText(url).catch(() => {});
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
      video,
      currentProgressFill: progressFill,
      posts: posts as unknown as StoryPost[],
      activeIndex: () => active,
      isPaused: () => paused,
      onAdvance: () => goTo(nextVisibleIndex(1)),
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
      <div class="rail-control" aria-label={ui.feedMode}>
        <div class="rail-avatar-menu">
          <button class="rail-avatar-menu__button" type="button" aria-label={ui.menu}>
            <img src="/brand-avatar-small-20260629.webp" alt="" width="34" height="34" />
          </button>
          <div class="rail-avatar-menu__panel">
            <a href={locale === "ru" ? "/ru/" : "/"}>Alex Getman</a>
            <a class="notranslate" href={locale === "ru" ? "/" : "/ru/"}>{ui.language}</a>
            <a href="https://t.me/alexgetmancom" target="_blank" rel="noopener noreferrer">{ui.telegram}</a>
          </div>
        </div>
        <div class="feed-mode-menu">
          <button
            class="feed-mode-menu__button is-active"
            type="button"
            aria-haspopup="true"
            aria-expanded={feedMenuOpen}
            onclick={(event) => {
              event.stopPropagation();
              feedMenuOpen = !feedMenuOpen;
            }}
          >
            <span>{feedMode === "deep" ? ui.feedDeep : feedMode === "watched" ? ui.feedWatched : ui.feedLatest}</span>
            <span aria-hidden="true">▾</span>
          </button>
          <div class="feed-mode-menu__panel" class:is-open={feedMenuOpen}>
            <button class:is-active={feedMode === "latest"} type="button" onclick={() => selectFeedMode("latest")}>{ui.feedLatest}</button>
            <button class:is-active={feedMode === "deep"} type="button" onclick={() => selectFeedMode("deep")}>{ui.feedDeep}</button>
            <button class:is-active={feedMode === "watched"} type="button" onclick={() => selectFeedMode("watched")}>{ui.feedWatched}</button>
          </div>
        </div>
      </div>
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
      bind:video
      bind:audio
      bind:progressFill
      onwheel={handleWheel}
      ontoggleplay={togglePause}
      onaudiotoggle={onAudioToggle}
      ontoggleread={() => setReading(!readingVisible)}
      onopendiscussion={openDiscussion}
      onshare={share}
      onvideoplaying={() => progress?.handleVideoPlaying()}
      onvideotimeupdate={onVideoTimeUpdate}
      onvideoended={() => progress?.handleVideoEnded()}
      onvideowaiting={() => progress?.handleVideoWaiting()}
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
        { active, postId: activePost?.id, paused, manualPaused, mediaType: activePost?.mediaType, url: activePost?.url },
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

  /* --------------- Боковая панель управления (аватар + режимы) -------------- */
  .rail-control {
    position: absolute;
    z-index: var(--z-rail);
    top: var(--rail-active-offset);
    left: 0.05rem;
    width: 50px;
    height: var(--rail-card-height);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.32rem;
    padding: 0.38rem 0.32rem;
    border: 1px solid rgba(220, 38, 38, 0.42);
    border-right: 0;
    border-radius: 8px 0 0 8px;
    background: linear-gradient(180deg, rgba(220, 38, 38, 0.18), rgba(0, 0, 0, 0.64)), rgba(0, 0, 0, 0.78);
    box-shadow:
      inset -1px 0 0 rgba(220, 38, 38, 0.18),
      0 12px 28px rgba(0, 0, 0, 0.36);
    pointer-events: auto;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .rail-avatar-menu,
  .feed-mode-menu {
    position: relative;
  }

  .rail-avatar-menu {
    flex: 0 0 auto;
  }

  .feed-mode-menu {
    flex: 1 1 auto;
    display: flex;
  }

  .rail-avatar-menu__button,
  .feed-mode-menu__button,
  .feed-mode-menu__panel button {
    min-height: 36px;
    border: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.72);
    color: var(--text-header);
    cursor: pointer;
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    transition:
      border-color 0.16s ease,
      background 0.16s ease,
      color 0.16s ease;
  }

  .rail-avatar-menu__button {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: 10px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.42);
  }

  .rail-avatar-menu__button img {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    object-fit: cover;
  }

  .feed-mode-menu__button {
    flex: 1 1 auto;
    min-height: 0;
    width: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.36rem;
    padding: 0.48rem 0.2rem;
    border-radius: 7px;
    font-size: 0.72rem;
    font-weight: 900;
    writing-mode: vertical-rl;
    text-orientation: mixed;
  }

  .rail-avatar-menu__button:hover,
  .feed-mode-menu__button:hover,
  .feed-mode-menu__button.is-active {
    border-color: rgba(220, 38, 38, 0.48);
    background: rgba(220, 38, 38, 0.13);
  }

  .rail-avatar-menu__panel,
  .feed-mode-menu__panel {
    position: absolute;
    left: calc(100% + 0.48rem);
    top: 0;
    min-width: 154px;
    display: grid;
    gap: 0.16rem;
    padding: 0.38rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.88);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.56);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-4px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }

  .rail-avatar-menu:hover .rail-avatar-menu__panel,
  .rail-avatar-menu:focus-within .rail-avatar-menu__panel,
  .feed-mode-menu__panel.is-open,
  .feed-mode-menu:focus-within .feed-mode-menu__panel {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .rail-avatar-menu__panel a,
  .feed-mode-menu__panel button {
    display: block;
    width: 100%;
    padding: 0.48rem 0.55rem;
    border-radius: 6px;
    color: var(--text-main);
    font-size: 0.82rem;
    font-weight: 850;
    text-align: left;
  }

  .feed-mode-menu__panel button {
    min-height: 0;
    border: 0;
    background: transparent;
  }

  .rail-avatar-menu__panel a:hover,
  .feed-mode-menu__panel button:hover,
  .feed-mode-menu__panel button.is-active {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(243, 246, 250, 0.22);
    color: var(--text-header);
  }

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

    .rail-control {
      position: relative;
      top: auto;
      left: auto;
      width: 100%;
      height: auto;
      flex-direction: row;
      order: 1;
      margin-bottom: 0.48rem;
      border-radius: 8px;
    }

    .feed-mode-menu__button {
      width: auto;
      min-height: 36px;
      writing-mode: horizontal-tb;
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

    .rail-control {
      position: relative;
      left: auto;
      top: auto;
      width: 100%;
      height: auto;
      flex-direction: row;
      justify-content: flex-start;
      margin: 0 0 0.55rem;
      padding: 0.42rem;
      border: 1px solid rgba(220, 38, 38, 0.35);
      border-radius: 10px;
    }

    .rail-avatar-menu__panel,
    .feed-mode-menu__panel {
      left: 0;
      top: calc(100% + 0.45rem);
    }

    .feed-mode-menu {
      flex: 0 0 auto;
    }

    .feed-mode-menu__button {
      width: auto;
      min-height: 36px;
      writing-mode: horizontal-tb;
      padding: 0.34rem 0.68rem;
    }
  }
</style>
