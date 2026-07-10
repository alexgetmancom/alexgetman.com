export {};

type StoryPost = {
  id?: string | number;
  url: string;
  image?: string;
  fallbackImage?: string;
  imageSrcSet?: string;
  mediaType: "image" | "video";
  title: string;
  category: string;
  relativeDate: string;
  views?: string;
  audioUrl?: string;
  body?: string | string[];
  excerpt?: string;
  collapse?: string;
  readMore?: string;
  feedModes?: string[];
  __preloaded?: boolean;
};

type StoryPayload = {
  posts?: StoryPost[];
  ui?: Record<string, string>;
  giscus?: Record<string, string>;
  initialPaused?: boolean;
};

(() => {
  const rootCandidate = document.querySelector<HTMLElement>('[data-story-player]');
  if (!rootCandidate) return;
  const root = rootCandidate;

  const payloadEl = root.querySelector<HTMLElement>('[data-story-payload]');
  const payload = (payloadEl ? JSON.parse(payloadEl.textContent || '{}') : {}) as StoryPayload;
  const posts = payload.posts || [];
  const ui = payload.ui || {};
  const giscusConfig = payload.giscus || {};
  if (!posts.length) return;
  const normalizedPath = window.StoryPlayerUtils?.normalizedPath ?? ((value: string) => {
    try {
      const url = new URL(value, window.location.origin);
      return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    } catch (_) {
      return '/';
    }
  });
  const applyImageFallback = window.StoryPlayerUtils?.applyImageFallback ?? ((img: HTMLImageElement) => {
    const fallbackSrc = img.dataset.fallbackSrc;
    if (!fallbackSrc || img.getAttribute('src') === fallbackSrc) {
      img.style.display = 'none';
      return false;
    }
    img.setAttribute('src', fallbackSrc);
    img.removeAttribute('srcset');
    return true;
  });
  const isTypingTarget = window.StoryPlayerUtils?.isTypingTarget ?? ((element: Element | null) => {
    const tagName = element?.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  });
  const toPublicSrc = (value: string | undefined): string => {
    if (!value) return '';
    const src = String(value);
    if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
    return `/${src.replace(/^\/+/, '')}`;
  };

  const image = root.querySelector<HTMLImageElement>('[data-story-image]');
  const video = root.querySelector<HTMLVideoElement>('[data-story-video]');
  const fallback = root.querySelector<HTMLElement>('[data-story-fallback]');
  const cardLink = root.querySelector<HTMLAnchorElement>('[data-story-card-link]');
  const visual = root.querySelector<HTMLElement>('[data-story-visual]');
  const title = root.querySelector<HTMLElement>('[data-story-title]');
  const categoryWrap = root.querySelector<HTMLElement>('.story-category-wrap');
  const meta = root.querySelector<HTMLElement>('.story-meta');
  const kicker = root.querySelector<HTMLElement>('[data-story-kicker]');
  const mobileKicker = root.querySelector<HTMLElement>('[data-story-mobile-kicker]');
  const mobileTitle = root.querySelector<HTMLElement>('[data-story-mobile-title]');
  const time = root.querySelector<HTMLElement>('[data-story-time]');
  const views = root.querySelector<HTMLElement>('[data-story-views]');
  const copy = root.querySelector<HTMLElement>('[data-story-copy]');
  const readMore = root.querySelector<HTMLButtonElement>('[data-story-read-more]');
  const rail = root.querySelector<HTMLElement>('.story-rail');
  const progressBars = Array.from(root.querySelectorAll<HTMLElement>('[data-story-progress-bar]'));
  const currentProgressFill = root.querySelector<HTMLElement>('[data-story-current-progress]');
  const railCards = Array.from(root.querySelectorAll<HTMLElement>('[data-story-index]'));
  const feedModeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-feed-mode]'));
  const feedModeTrigger = root.querySelector<HTMLButtonElement>('[data-feed-mode-trigger]');
  const feedModeLabel = root.querySelector<HTMLElement>('[data-feed-mode-label]');
  const feedModeMenu = root.querySelector<HTMLElement>('.feed-mode-menu');
  const shareButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-story-share]'));
  const discussButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-story-discuss]'));
  const discussLabels = discussButtons
    .map((button) => button.querySelector('span'))
    .filter((label): label is HTMLSpanElement => label != null);
  const postPanel = root.querySelector<HTMLElement>('[data-panel="post"]');
  const discussionPanel = root.querySelector<HTMLElement>('[data-panel="discussion"]');
  const discussionFrame = root.querySelector<HTMLElement>('[data-story-discussion-frame]');
  const audioToggle = root.querySelector<HTMLButtonElement>('[data-audio-toggle]');
  const audioLabel = root.querySelector<HTMLElement>('[data-audio-label]');
  const audio = root.querySelector<HTMLAudioElement>('[data-story-audio]');

  const playPauseOverlay = document.createElement('div');
  playPauseOverlay.className = 'play-pause-overlay';
  playPauseOverlay.innerHTML = '<div class="play-pause-icon"></div>';
  if (visual) {
    visual.appendChild(playPauseOverlay);
  }

  let active = 0;
  let isManualPaused = payload.initialPaused === true || root.dataset.initialPaused === 'true';
  let isHoverPaused = false;
  let isInteractionPaused = false;
  let paused = isManualPaused;
  let muted = localStorage.getItem('story-player-muted') !== 'false';
  let expanded = false;
  let animationTimer: number | null = null;
  let videoProgressFallbackTimer: number | null = null;
  let storyViewTimer: number | null = null;
  const intervalMs = 8500;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let advanceTimer: number | null = null;
  let progressStartedAt = 0;
  let progressRemainingMs = intervalMs;
  let progressActive = false;
  let wheelGestureLocked = false;
  let wheelUnlockTimer: number | null = null;
  let manualProgressTimer: number | null = null;
  let interactionPauseTimer: number | null = null;
  let progressRestartBlocked = false;
  let discussionTerm = '';
  let discussionVisible = false;
  let activeFeedMode = 'latest';
  const debugEnabled = new URLSearchParams(window.location.search).has('debug');
  const debugPanel = debugEnabled ? document.createElement('pre') : null;

  function recordStoryView(post: StoryPost): void {
    if (!post?.url) return;
    if (window.location.hostname.includes('localhost') || window.location.hostname.includes('127.0.0.1')) return;
    const path = normalizedPath(post.url);
    if (normalizedPath(window.location.pathname) === path) return;
    const key = `story-view:${path}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch (_) {}

    const payload = JSON.stringify({ path, source: 'home_story', post_id: post.id });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/stats/pageview', new Blob([payload], { type: 'application/json' }));
        return;
      }
      fetch('/stats/pageview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (_) {}
  }

  function scheduleStoryView(post: StoryPost): void {
    if (storyViewTimer) window.clearTimeout(storyViewTimer);
    const scheduledIndex = active;
    storyViewTimer = window.setTimeout(() => {
      if (scheduledIndex === active) {
        recordStoryView(post);
      }
    }, 2000);
  }

  function clearVideoProgressFallback() {
    if (videoProgressFallbackTimer) {
      window.clearTimeout(videoProgressFallbackTimer);
      videoProgressFallbackTimer = null;
    }
  }

  function clearAdvanceTimer() {
    if (advanceTimer) {
      window.clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  }

  function resetProgressFills() {
    progressBars.forEach((bar) => {
      const fill = bar.querySelector<HTMLElement>('i');
      if (!fill) return;
      fill.style.animation = 'none';
      fill.style.animationPlayState = 'running';
      fill.style.transform = 'scaleY(0)';
    });
    if (currentProgressFill) {
      currentProgressFill.style.animation = 'none';
      currentProgressFill.style.animationPlayState = 'running';
      currentProgressFill.style.transform = 'scaleX(0)';
    }
  }

  function resumeProgressAfterManualNavigation() {
    if (manualProgressTimer) {
      window.clearTimeout(manualProgressTimer);
    }
    root.classList.add('is-manual-navigating');
    progressRestartBlocked = true;
    clearAdvanceTimer();
    if (animationTimer) {
      window.clearTimeout(animationTimer);
      animationTimer = null;
    }
    clearVideoProgressFallback();
    progressActive = false;
    resetProgressFills();

    manualProgressTimer = window.setTimeout(() => {
      manualProgressTimer = null;
      root.classList.remove('is-manual-navigating');
      progressRestartBlocked = false;
      resetProgressFills();
      if (!paused) {
        scheduleCurrentProgress(260);
      }
    }, 850);
  }

  function visibleStoryIndexes(): number[] {
    const visible = posts
      .map((post, index) => ({ post, index }))
      .filter(({ post }) => activeFeedMode === 'latest' || post.feedModes?.includes(activeFeedMode))
      .map(({ index }) => index);
    return visible.length ? visible : posts.map((_, index) => index);
  }

  function isStoryVisible(index: number): boolean {
    return visibleStoryIndexes().includes(index);
  }

  function nextVisibleStoryIndex(direction: number): number {
    const visible = visibleStoryIndexes();
    const currentPosition = visible.indexOf(active);
    if (currentPosition === -1) return visible[0] ?? active;
    return visible[(currentPosition + direction + visible.length) % visible.length];
  }

  function syncFeedModeControls() {
    let activeLabel = ui.feedLatest || 'Latest';
    feedModeButtons.forEach((button) => {
      const isActive = button.dataset.feedMode === activeFeedMode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
      if (isActive) activeLabel = button.textContent?.trim() || activeLabel;
    });
    if (feedModeLabel) feedModeLabel.textContent = activeLabel;
    const visible = new Set(visibleStoryIndexes());
    railCards.forEach((card, index) => {
      card.classList.toggle('is-filtered-out', !visible.has(index));
    });
  }

  function scheduleAdvance(duration: number): void {
    clearAdvanceTimer();
    if (paused || !progressActive) return;
    progressRemainingMs = Math.max(250, duration);
    progressStartedAt = Date.now();
    advanceTimer = window.setTimeout(() => {
      advanceTimer = null;
      if (!paused) {
        render(nextVisibleStoryIndex(1));
      }
    }, progressRemainingMs + 80);
  }

  function pauseAdvanceTimer() {
    if (!advanceTimer) return;
    const elapsed = Date.now() - progressStartedAt;
    progressRemainingMs = Math.max(250, progressRemainingMs - elapsed);
    clearAdvanceTimer();
  }

  function startProgressAnimation(fill: HTMLElement, duration: number): void {
    if (!fill) return;
    progressActive = true;
    progressRemainingMs = duration;
    fill.style.animation = 'none';
    fill.offsetHeight; // trigger reflow
    fill.style.animation = !reduceMotion ? `storyProgressVertical ${duration}ms linear forwards` : 'none';
    fill.style.animationPlayState = paused ? 'paused' : 'running';
    if (currentProgressFill) {
      currentProgressFill.style.animation = 'none';
      currentProgressFill.style.transform = 'scaleX(0)';
      currentProgressFill.offsetHeight; // trigger reflow
      currentProgressFill.style.animation = !reduceMotion ? `storyProgressHorizontal ${duration}ms linear forwards` : 'none';
      currentProgressFill.style.animationPlayState = paused ? 'paused' : 'running';
    }
    if (reduceMotion) {
      scheduleAdvance(intervalMs);
    } else {
      scheduleAdvance(duration);
    }
  }

  function scheduleCurrentProgress(delay = 380) {
    if (progressRestartBlocked) return;
    const post = posts[active];
    const activeBar = progressBars[active];
    const fill = activeBar?.querySelector<HTMLElement>('i');
    if (!post || !fill) return;
    if (post.mediaType === 'video') {
      videoProgressFallbackTimer = window.setTimeout(() => {
        if (posts[active]?.mediaType === 'video') {
          startProgressAnimation(fill, intervalMs);
        }
      }, Math.max(delay, 700));
    } else {
      animationTimer = window.setTimeout(() => {
        startProgressAnimation(fill, intervalMs);
      }, delay);
    }
  }

  root.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      if (!applyImageFallback(img)) {
        img.style.display = 'none';
      }
    });
    if (img.complete && img.naturalWidth === 0) {
      if (!applyImageFallback(img)) {
        img.style.display = 'none';
      }
    }
  });

  video?.addEventListener('error', () => {
    const fallbackSrc = video.dataset?.fallbackSrc;
    if (!fallbackSrc || !image) return;
    video.hidden = true;
    video.pause?.();
    video.removeAttribute('src');
    image.hidden = false;
    image.setAttribute('src', fallbackSrc);
    image.removeAttribute('srcset');
  });

  video?.addEventListener('playing', () => {
    const post = posts[active];
    if (post && post.mediaType === 'video') {
      if (!video.currentSrc.endsWith(post.image ?? '')) {
        return;
      }
      clearVideoProgressFallback();
      const activeBar = progressBars[active];
      const fill = activeBar?.querySelector<HTMLElement>('i');
      if (fill) {
        if (fill.style.animation && fill.style.animation !== 'none') {
          fill.style.animationPlayState = (isManualPaused || isHoverPaused) ? 'paused' : 'running';
          return;
        }
        const duration = video.duration ? Math.min(15000, video.duration * 1000) : intervalMs;
        startProgressAnimation(fill, duration);
      }
    }
  });

  video?.addEventListener('waiting', () => {
    const post = posts[active];
    if (post && post.mediaType === 'video') {
      const activeBar = progressBars[active];
      const fill = activeBar?.querySelector<HTMLElement>('i');
      if (fill) {
        fill.style.animationPlayState = 'paused';
      }
      if (currentProgressFill) {
        currentProgressFill.style.animationPlayState = 'paused';
      }
    }
  });

  function syncReadMore(post: StoryPost): void {
    if (!copy || !readMore) return;
    copy.classList.toggle('is-expanded', expanded);
    readMore.textContent = expanded ? (post.collapse || ui.collapse || 'Collapse') : (post.readMore || ui.readMore || 'Read more');
    window.requestAnimationFrame(() => {
      const needsMore = copy.scrollHeight > copy.clientHeight + 4 || expanded;
      readMore.hidden = !needsMore;
    });
  }

  function updatePlayState() {
    paused = isManualPaused || isHoverPaused || isInteractionPaused;

    const activeBar = progressBars[active];
    const fill = activeBar?.querySelector<HTMLElement>('i');
    if (fill) {
      fill.style.animationPlayState = paused ? 'paused' : 'running';
    }
    if (currentProgressFill) {
      currentProgressFill.style.animationPlayState = paused ? 'paused' : 'running';
    }

    if (progressActive) {
      if (paused) {
        pauseAdvanceTimer();
      } else if (!advanceTimer) {
        scheduleAdvance(progressRemainingMs);
      }
    } else if (!paused && !progressRestartBlocked && !animationTimer && !videoProgressFallbackTimer) {
      scheduleCurrentProgress(0);
    }

    if (video && posts[active]?.mediaType === 'video') {
      if (paused) {
        video.pause?.();
      } else {
        video.play?.().catch(() => {});
      }
    }
    renderDebugState();
  }

  function hydrateRailMedia() {
    railCards.forEach((card, index) => {
      const distance = Math.min(Math.abs(index - active), posts.length - Math.abs(index - active));
      if (distance > 5 || card.dataset.mediaHydrated === 'true') return;
      const media = card.querySelector('.rail-card__media');
      const src = card.dataset.mediaSrc;
      if (!media || !src) return;
      const type = card.dataset.mediaType;
      const fallbackSrc = card.dataset.mediaFallback;
      const srcset = card.dataset.mediaSrcset;
      media.innerHTML = '';
      if (type === 'video' && !fallbackSrc) {
        const thumbVideo = document.createElement('video');
        thumbVideo.src = `${toPublicSrc(src)}#t=0.001`;
        thumbVideo.muted = true;
        thumbVideo.playsInline = true;
        thumbVideo.preload = 'metadata';
        media.appendChild(thumbVideo);
      } else {
        const img = document.createElement('img');
        img.src = toPublicSrc(fallbackSrc || src);
        if (srcset && type !== 'video') img.srcset = srcset;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.sizes = '(max-width: 760px) 38vw, 140px';
        media.appendChild(img);
      }
      card.dataset.mediaHydrated = 'true';
    });
  }

  function centerRailCard(card: HTMLElement): void {
    if (!rail || !card) return;
    const left = card.offsetLeft - (rail.clientWidth - card.offsetWidth) / 2;
    const top = card.offsetTop - (rail.clientHeight - card.offsetHeight) / 2;
    rail.scrollTo({
      left: Math.max(0, left),
      top: Math.max(0, top),
      behavior: 'smooth',
    });
  }

  function preloadAdjacentMedia() {
    [-1, 1, 2].forEach((offset) => {
      const post = posts[(active + offset + posts.length) % posts.length];
      if (!post?.image) return;
      const src = toPublicSrc(post.fallbackImage || post.image);
      if (!src || post.__preloaded) return;
      post.__preloaded = true;
      if (post.mediaType === 'video') {
        const preloadVideo = document.createElement('video');
        preloadVideo.src = post.image;
        preloadVideo.preload = 'metadata';
      } else {
        const preloadImage = new Image();
        preloadImage.src = src;
        if (post.imageSrcSet) preloadImage.srcset = post.imageSrcSet;
      }
    });
  }

  function renderDebugState() {
    if (!debugPanel) return;
    debugPanel.textContent = JSON.stringify({
      active,
      postId: posts[active]?.id,
      paused,
      isManualPaused,
      isInteractionPaused,
      progressActive,
      progressRestartBlocked,
      advanceTimer: Boolean(advanceTimer),
      mediaType: posts[active]?.mediaType || null,
      url: posts[active]?.url || null,
    }, null, 2);
  }

  function setDiscussionVisible(isVisible: boolean): void {
    if (!postPanel || !discussionPanel) return;
    const wasDiscussionVisible = discussionVisible;
    discussionVisible = isVisible;
    discussionPanel.hidden = !isVisible;
    root.classList.toggle('is-discussing', isVisible);
    if (categoryWrap) categoryWrap.hidden = isVisible;
    if (meta) meta.hidden = isVisible;
    if (title) title.hidden = isVisible;
    if (copy) copy.hidden = isVisible;
    if (readMore) readMore.hidden = true;
    discussLabels.forEach((label) => {
      label.textContent = isVisible ? (ui.backToPost || 'Back to post') : (ui.discuss || 'Discuss');
    });
    if (isVisible) {
      isManualPaused = true;
    } else if (wasDiscussionVisible) {
      isManualPaused = false;
    }
    updatePlayState();
  }

  function loadDiscussion(post: StoryPost): void {
    if (!discussionFrame || !post?.url) return;
    const url = new URL(post.url, window.location.origin).href;
    if (discussionTerm === url) return;
    discussionTerm = url;
    discussionFrame.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'story-discussion-loading';
    loading.textContent = ui.discussionTab || 'Discussion';
    discussionFrame.appendChild(loading);
    const script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-repo', giscusConfig.repo || 'alexgetmancom/alexgetman.com');
    script.setAttribute('data-repo-id', giscusConfig.repoId || 'R_kgDOSJwPnQ');
    script.setAttribute('data-category', giscusConfig.category || 'Announcements');
    script.setAttribute('data-category-id', giscusConfig.categoryId || 'DIC_kwDOSJwPnc4C-S2f');
    script.setAttribute('data-mapping', 'specific');
    script.setAttribute('data-term', url);
    script.setAttribute('data-strict', '1');
    script.setAttribute('data-reactions-enabled', '1');
    script.setAttribute('data-emit-metadata', '0');
    script.setAttribute('data-input-position', 'bottom');
    script.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    script.setAttribute('data-lang', giscusConfig.lang || document.documentElement.lang || 'en');
    discussionFrame.appendChild(script);
  }

  function render(index: number, options: { keepProgressIdle?: boolean } = {}): void {
    active = (index + posts.length) % posts.length;
    const post = posts[active];
    if (!post) return;
    expanded = false;
    setDiscussionVisible(false);

    const panel = root.querySelector('.story-panel');
    if (panel) {
      panel.classList.add('is-updating');
    }

    if (cardLink) cardLink.href = post.url;
    if (visual) visual.classList.toggle('story-visual--no-image', !post.image);
    if (image) {
      image.hidden = !post.image || post.mediaType === 'video';
      if (post.fallbackImage) image.dataset.fallbackSrc = toPublicSrc(post.fallbackImage);
      else delete image.dataset.fallbackSrc;
      if (post.image && post.mediaType !== 'video') {
        image.setAttribute('src', toPublicSrc(post.image));
        if (post.imageSrcSet) image.setAttribute('srcset', post.imageSrcSet);
        else image.removeAttribute('srcset');
      } else {
        image.removeAttribute('src');
        image.removeAttribute('srcset');
      }
    }
    if (video) {
      video.hidden = !post.image || post.mediaType !== 'video';
      if (post.fallbackImage) video.dataset.fallbackSrc = toPublicSrc(post.fallbackImage);
      else delete video.dataset.fallbackSrc;
      if (post.image && post.mediaType === 'video') {
        if (post.fallbackImage) video.setAttribute('poster', toPublicSrc(post.fallbackImage));
        else video.removeAttribute('poster');
        const videoSrc = toPublicSrc(post.image);
        if (video.getAttribute('src') !== videoSrc) {
          video.setAttribute('src', videoSrc);
          video.load();
        }
        video.muted = muted;
        if (!paused) {
          video.play?.().catch(() => {});
        }
      } else {
        video.pause?.();
        video.removeAttribute('src');
        video.load?.();
      }
    }
    if (fallback) {
      fallback.hidden = !!post.image;
      fallback.textContent = post.title;
    }
    if (kicker) kicker.textContent = post.category;
    if (mobileKicker) mobileKicker.textContent = post.category;
    if (mobileTitle) mobileTitle.textContent = post.title;
    if (time) time.textContent = post.relativeDate;
    if (title) title.textContent = post.title;
    if (copy) {
      copy.innerHTML = '';
      copy.classList.remove('is-expanded');
      const paragraphs = Array.isArray(post.body)
        ? post.body
        : typeof post.body === 'string'
          ? [post.body]
          : [post.excerpt];
      paragraphs.filter((paragraph): paragraph is string => Boolean(paragraph)).forEach((paragraph) => {
        const p = document.createElement('p');
        p.textContent = paragraph;
        copy.appendChild(p);
      });
    }
    syncReadMore(post);
    if (views) views.textContent = post.views || '0';
    if (audio) {
      audio.pause?.();
      if (post.audioUrl && post.mediaType !== 'video') {
        if (audio.getAttribute('src') !== post.audioUrl) {
          audio.setAttribute('src', post.audioUrl);
          audio.load?.();
        }
        audio.muted = muted;
        if (!muted && !paused) {
          audio.play?.().catch(() => {});
        }
      } else {
        audio.removeAttribute('src');
        audio.load?.();
      }
    }

    if (animationTimer) {
      window.clearTimeout(animationTimer);
    }
    clearVideoProgressFallback();
    clearAdvanceTimer();
    progressActive = false;
    progressRestartBlocked = !!options.keepProgressIdle;

    progressBars.forEach((bar, i) => {
      const fill = bar.querySelector<HTMLElement>('i');
      bar.classList.remove('is-active', 'is-done');
      if (fill) {
        fill.style.animation = 'none';
        fill.style.animationPlayState = 'running';
        fill.style.transform = 'scaleY(0)';
      }
    });
    if (currentProgressFill) {
      currentProgressFill.style.animation = 'none';
      currentProgressFill.style.animationPlayState = 'running';
      currentProgressFill.style.transform = 'scaleX(0)';
    }

    progressBars.forEach((bar, i) => {
      const isActive = i === active;
      bar.classList.toggle('is-active', isActive);
      bar.classList.toggle('is-done', i < active);
      const fill = bar.querySelector<HTMLElement>('i');
      if (fill) {
        fill.offsetHeight; // trigger reflow
        
        if (isActive) {
          fill.style.transform = 'scaleY(0)';
          const post = posts[active];
          if (paused || options.keepProgressIdle) {
            progressRemainingMs = intervalMs;
          } else if (post) {
            scheduleCurrentProgress();
          }
        } else {
          fill.style.transform = i < active ? 'scaleY(1)' : 'scaleY(0)';
        }
      }
    });

    railCards.forEach((card, i) => {
      const isCurrent = i === active;
      card.classList.toggle('is-active', isCurrent);
      if (isCurrent) {
        window.setTimeout(() => {
          centerRailCard(card);
        }, 60);
      }
    });

    const readingTime = root.querySelector('[data-story-reading-time]');
    if (readingTime) {
      const bodyText = Array.isArray(post.body)
        ? post.body.join(' ')
        : (post.body || post.excerpt || '');
      const words = bodyText.split(/\s+/).length;
      const mins = Math.max(1, Math.ceil(words / 180));
      readingTime.textContent = `⏱️ ${mins} min`;
    }

    updatePlayState();
    syncFeedModeControls();
    scheduleStoryView(post);
    hydrateRailMedia();
    preloadAdjacentMedia();

    if (panel) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          panel.classList.remove('is-updating');
        });
      });
    }
  }

  railCards.forEach((card, index) => {
    card.addEventListener('click', (event) => {
      event.preventDefault();
      if (!isStoryVisible(index)) return;
      render(index, { keepProgressIdle: true });
      resumeProgressAfterManualNavigation();
    });
  });

  feedModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextMode = button.dataset.feedMode || 'latest';
      feedModeMenu?.classList.remove('is-open');
      feedModeTrigger?.setAttribute('aria-expanded', 'false');
      if (nextMode === activeFeedMode) return;
      activeFeedMode = nextMode;
      syncFeedModeControls();
      if (!isStoryVisible(active)) {
        render(visibleStoryIndexes()[0] ?? 0, { keepProgressIdle: true });
      } else {
        render(active, { keepProgressIdle: true });
      }
      resumeProgressAfterManualNavigation();
    });
  });

  feedModeTrigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = !feedModeMenu?.classList.contains('is-open');
    feedModeMenu?.classList.toggle('is-open', isOpen);
    feedModeTrigger.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (event) => {
    if (!feedModeMenu || !feedModeTrigger) return;
    if (event.target instanceof Node && feedModeMenu.contains(event.target)) return;
    feedModeMenu.classList.remove('is-open');
    feedModeTrigger.setAttribute('aria-expanded', 'false');
  });

  cardLink?.addEventListener('click', (event) => {
    event.preventDefault();
    isManualPaused = !isManualPaused;

    if (!isManualPaused) {
      isHoverPaused = false;
    }

    const icon = playPauseOverlay.querySelector('.play-pause-icon');
    if (icon) {
      icon.className = `play-pause-icon ${isManualPaused ? 'is-paused' : 'is-playing'}`;
      playPauseOverlay.classList.remove('is-visible');
      void playPauseOverlay.offsetWidth;
      playPauseOverlay.classList.add('is-visible');
    }

    updatePlayState();
  });

  let lastWheelTime = 0;
  const wheelCooldownMs = 140;

  function lockWheelGesture() {
    wheelGestureLocked = true;
    if (wheelUnlockTimer) {
      window.clearTimeout(wheelUnlockTimer);
    }
    wheelUnlockTimer = window.setTimeout(() => {
      wheelGestureLocked = false;
      wheelUnlockTimer = null;
    }, wheelCooldownMs);
  }

  function handleWheel(event: WheelEvent): void {
    if (Math.abs(event.deltaY) < 10) return;
    event.preventDefault();

    const now = Date.now();
    if (wheelGestureLocked || now - lastWheelTime < wheelCooldownMs) {
      lockWheelGesture();
      return;
    }
    lastWheelTime = now;
    lockWheelGesture();

    if (event.deltaY > 0) {
      render(nextVisibleStoryIndex(1), { keepProgressIdle: true });
    } else {
      render(nextVisibleStoryIndex(-1), { keepProgressIdle: true });
    }
    resumeProgressAfterManualNavigation();
  }

  visual?.addEventListener('wheel', handleWheel, { passive: false });
  root.querySelector<HTMLElement>('.story-rail-container')?.addEventListener('wheel', handleWheel, { passive: false });

  readMore?.addEventListener('click', () => {
    expanded = !expanded;
    syncReadMore(posts[active] || {});
  });

  discussButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (discussionVisible) {
        setDiscussionVisible(false);
        return;
      }
      const post = posts[active];
      loadDiscussion(post);
      setDiscussionVisible(true);
      if (window.matchMedia('(max-width: 760px)').matches) {
        discussionPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  async function shareCurrentPost(button: HTMLButtonElement): Promise<void> {
    const post = posts[active];
    const url = new URL(post.url, window.location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({ title: post.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        const span = button.querySelector('span');
        if (span) {
          span.textContent = ui.copied || 'Copied';
          window.setTimeout(() => { span.textContent = ui.share || 'Share'; }, 1400);
        }
      }
    } catch (error) {
      await navigator.clipboard?.writeText(url).catch(() => {});
    }
  }

  shareButtons.forEach((button) => {
    button.addEventListener('click', () => {
      shareCurrentPost(button);
    });
  });

  audioToggle?.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('story-player-muted', String(muted));
    audioToggle.setAttribute('aria-pressed', String(muted));
    audioToggle.classList.toggle('is-on', !muted);
    if (audioLabel) audioLabel.textContent = muted ? (ui.muted || 'Muted') : (ui.mute || 'Audio');
    if (audio) {
      audio.muted = muted;
      const post = posts[active];
      const isVideo = post && post.mediaType === 'video';
      if (!muted && audio.getAttribute('src') && !isVideo) {
        audio.play?.().catch(() => {});
      } else {
        audio.pause?.();
      }
    }
    if (video) {
      video.muted = muted;
    }
  });

  let startX = 0;
  root.addEventListener('touchstart', (event) => {
    startX = event.touches[0]?.clientX || 0;
  }, { passive: true });
  root.addEventListener('touchend', (event) => {
    const endX = event.changedTouches[0]?.clientX || 0;
    const delta = endX - startX;
    if (Math.abs(delta) > 55) {
      render(nextVisibleStoryIndex(delta < 0 ? 1 : -1), { keepProgressIdle: true });
      resumeProgressAfterManualNavigation();
    }
  }, { passive: true });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (isTypingTarget(document.activeElement)) return;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault();
      render(nextVisibleStoryIndex(1), { keepProgressIdle: true });
      resumeProgressAfterManualNavigation();
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      render(nextVisibleStoryIndex(-1), { keepProgressIdle: true });
      resumeProgressAfterManualNavigation();
    } else if (event.key === ' ') {
      event.preventDefault();
      isManualPaused = !isManualPaused;
      isInteractionPaused = false;
      if (interactionPauseTimer) {
        window.clearTimeout(interactionPauseTimer);
        interactionPauseTimer = null;
      }
      updatePlayState();
    }
  });

  // Sync initial button states with stored preference
  audioToggle?.setAttribute('aria-pressed', String(muted));
  audioToggle?.classList.toggle('is-on', !muted);
  if (audioLabel) audioLabel.textContent = muted ? (ui.muted || 'Muted') : (ui.mute || 'Audio');
  syncFeedModeControls();

  if (debugPanel) {
    debugPanel.className = 'story-debug-panel';
    root.appendChild(debugPanel);
  }

  render(0);
})();
