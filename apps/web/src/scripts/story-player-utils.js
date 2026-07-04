(() => {
  function normalizedPath(value) {
    try {
      const url = new URL(value, window.location.origin);
      return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    } catch (_) {
      return '/';
    }
  }

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

  function isTypingTarget(element) {
    const tagName = element?.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  }

  window.StoryPlayerUtils = {
    normalizedPath,
    applyImageFallback,
    isTypingTarget,
  };
})();
