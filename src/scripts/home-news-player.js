(() => {
  const root = document.querySelector('[data-story-player]');
  if (!root) return;

  const payloadEl = root.querySelector('[data-story-payload]');
  const payload = payloadEl ? JSON.parse(payloadEl.textContent || '{}') : {};
  const posts = payload.posts || [];
  const ui = payload.ui || {};
  if (!posts.length) return;

  const image = root.querySelector('[data-story-image]');
  const video = root.querySelector('[data-story-video]');
  const fallback = root.querySelector('[data-story-fallback]');
  const cardLink = root.querySelector('[data-story-card-link]');
  const visual = root.querySelector('[data-story-visual]');
  const title = root.querySelector('[data-story-title]');
  const kicker = root.querySelector('[data-story-kicker]');
  const time = root.querySelector('[data-story-time]');
  const views = root.querySelector('[data-story-views]');
  const copy = root.querySelector('[data-story-copy]');
  const readMore = root.querySelector('[data-story-read-more]');
  const rail = root.querySelector('.story-rail');
  const progressBars = Array.from(root.querySelectorAll('[data-story-progress-bar]'));
  const railCards = Array.from(root.querySelectorAll('[data-story-index]'));
  const share = root.querySelector('[data-story-share]');
  const discuss = root.querySelector('[data-story-discuss]');
  const audioToggle = root.querySelector('[data-audio-toggle]');
  const audioLabel = root.querySelector('[data-audio-label]');
  const audio = root.querySelector('[data-story-audio]');

  const playPauseOverlay = document.createElement('div');
  playPauseOverlay.className = 'play-pause-overlay';
  playPauseOverlay.innerHTML = '<div class="play-pause-icon"></div>';
  if (visual) {
    visual.appendChild(playPauseOverlay);
  }

  let active = 0;
  let isManualPaused = false;
  let isHoverPaused = false;
  let paused = false;
  let muted = localStorage.getItem('story-player-muted') !== 'false';
  let expanded = false;
  let animationTimer = null;
  const intervalMs = 8500;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function applyImageFallback(img) {
    const fallbackSrc = img?.dataset?.fallbackSrc;
    if (!fallbackSrc || img.getAttribute('src') === fallbackSrc) {
      img.style.display = 'none';
      return false;
    }
    img.setAttribute('src', fallbackSrc);
    img.removeAttribute('srcset');
    return true;
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
      if (!video.currentSrc.endsWith(post.image)) {
        return;
      }
      const activeBar = progressBars[active];
      const fill = activeBar?.querySelector('i');
      if (fill) {
        if (fill.style.animation && fill.style.animation !== 'none') {
          fill.style.animationPlayState = (isManualPaused || isHoverPaused) ? 'paused' : 'running';
          return;
        }
        const duration = video.duration ? Math.min(15000, video.duration * 1000) : intervalMs;
        fill.style.animation = 'none';
        fill.offsetHeight; // trigger reflow
        fill.style.animation = !reduceMotion ? `storyProgressVertical ${duration}ms linear forwards` : 'none';
        fill.style.animationPlayState = (isManualPaused || isHoverPaused) ? 'paused' : 'running';
      }
    }
  });

  video?.addEventListener('waiting', () => {
    const post = posts[active];
    if (post && post.mediaType === 'video') {
      const activeBar = progressBars[active];
      const fill = activeBar?.querySelector('i');
      if (fill) {
        fill.style.animationPlayState = 'paused';
      }
    }
  });

  function syncReadMore(post) {
    if (!copy || !readMore) return;
    copy.classList.toggle('is-expanded', expanded);
    readMore.textContent = expanded ? (post.collapse || ui.collapse || 'Collapse') : (post.readMore || ui.readMore || 'Read more');
    window.requestAnimationFrame(() => {
      const needsMore = copy.scrollHeight > copy.clientHeight + 4 || expanded;
      readMore.hidden = !needsMore;
    });
  }

  function updatePlayState() {
    paused = isManualPaused || isHoverPaused;

    const activeBar = progressBars[active];
    const fill = activeBar?.querySelector('i');
    if (fill) {
      fill.style.animationPlayState = paused ? 'paused' : 'running';
    }

    if (video && posts[active]?.mediaType === 'video') {
      if (paused) {
        video.pause?.();
      } else {
        video.play?.().catch(() => {});
      }
    }
  }

  function render(index) {
    active = (index + posts.length) % posts.length;
    const post = posts[active];
    if (!post) return;
    expanded = false;

    const panel = root.querySelector('.story-panel');
    if (panel) {
      panel.classList.add('is-updating');
    }

    if (cardLink) cardLink.href = post.url;
    if (visual) visual.classList.toggle('story-visual--no-image', !post.image);
    if (image) {
      image.hidden = !post.image || post.mediaType === 'video';
      if (post.fallbackImage) image.dataset.fallbackSrc = post.fallbackImage;
      else delete image.dataset.fallbackSrc;
      if (post.image && post.mediaType !== 'video') {
        image.setAttribute('src', post.image);
        if (post.imageSrcSet) image.setAttribute('srcset', post.imageSrcSet);
        else image.removeAttribute('srcset');
      } else {
        image.removeAttribute('src');
        image.removeAttribute('srcset');
      }
    }
    if (video) {
      video.hidden = !post.image || post.mediaType !== 'video';
      if (post.fallbackImage) video.dataset.fallbackSrc = post.fallbackImage;
      else delete video.dataset.fallbackSrc;
      if (post.image && post.mediaType === 'video') {
        if (post.fallbackImage) video.setAttribute('poster', post.fallbackImage);
        else video.removeAttribute('poster');
        if (video.getAttribute('src') !== post.image) {
          video.setAttribute('src', post.image);
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
      paragraphs.filter(Boolean).forEach((paragraph) => {
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

    progressBars.forEach((bar, i) => {
      const isActive = i === active;
      bar.classList.toggle('is-active', isActive);
      bar.classList.toggle('is-done', i < active);
      const fill = bar.querySelector('i');
      if (fill) {
        fill.style.animation = 'none';
        fill.style.animationPlayState = 'running';
        fill.offsetHeight; // trigger reflow
        
        if (isActive) {
          const post = posts[active];
          if (post && post.mediaType === 'video') {
            fill.style.transform = 'scaleY(0)';
          } else {
            animationTimer = window.setTimeout(() => {
              if (i === active) {
                fill.style.animation = !reduceMotion ? `storyProgressVertical ${intervalMs}ms linear forwards` : 'none';
                fill.style.animationPlayState = paused ? 'paused' : 'running';
              }
            }, 380);
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
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    if (panel) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          panel.classList.remove('is-updating');
        });
      });
    }
  }

  // Animation end listener for progress bars to switch automatically
  rail?.addEventListener('animationend', (event) => {
    if (event.target && event.target.tagName === 'I') {
      render(active + 1);
    }
  });

  railCards.forEach((card, index) => {
    card.addEventListener('click', (event) => {
      event.preventDefault();
      render(index);
    });
  });

  root.addEventListener('mouseenter', () => {
    isHoverPaused = true;
    updatePlayState();
  });
  root.addEventListener('mouseleave', () => {
    isHoverPaused = false;
    updatePlayState();
  });
  root.addEventListener('focusin', () => {
    isHoverPaused = true;
    updatePlayState();
  });
  root.addEventListener('focusout', () => {
    isHoverPaused = false;
    updatePlayState();
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
  const wheelCooldownMs = 500;

  function handleWheel(event) {
    if (Math.abs(event.deltaY) < 10) return;
    event.preventDefault();

    const now = Date.now();
    if (now - lastWheelTime < wheelCooldownMs) return;
    lastWheelTime = now;

    if (event.deltaY > 0) {
      render(active + 1);
    } else {
      render(active - 1);
    }
  }

  visual?.addEventListener('wheel', handleWheel, { passive: false });
  root.querySelector('.story-rail-container')?.addEventListener('wheel', handleWheel, { passive: false });

  readMore?.addEventListener('click', () => {
    expanded = !expanded;
    syncReadMore(posts[active] || {});
  });

  discuss?.addEventListener('click', () => {
    const post = posts[active];
    if (post?.url) window.location.href = `${post.url}#comments`;
  });

  share?.addEventListener('click', async () => {
    const post = posts[active];
    const url = new URL(post.url, window.location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({ title: post.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        const span = share.querySelector('span');
        if (span) {
          span.textContent = ui.copied || 'Copied';
          window.setTimeout(() => { span.textContent = ui.share || 'Share'; }, 1400);
        }
      }
    } catch (error) {
      await navigator.clipboard?.writeText(url).catch(() => {});
    }
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
      render(active + (delta < 0 ? 1 : -1));
    }
  }, { passive: true });

  // Sync initial button states with stored preference
  audioToggle?.setAttribute('aria-pressed', String(muted));
  audioToggle?.classList.toggle('is-on', !muted);
  if (audioLabel) audioLabel.textContent = muted ? (ui.muted || 'Muted') : (ui.mute || 'Audio');

  render(0);
})();
