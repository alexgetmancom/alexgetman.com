const postPageRoot = document.querySelector('[data-post-page]');
const postPageConfig = {
  copySuccess: postPageRoot?.dataset.copySuccess || 'Copied!',
  copyDefault: postPageRoot?.dataset.copyDefault || 'Link',
  giscusLang: postPageRoot?.dataset.giscusLang || document.documentElement.lang || 'en',
};

  // Share Copy Link Logic
  const copyBtn = document.getElementById('copy-link-btn');
  const copyText = document.getElementById('copy-btn-text');
  if (copyBtn && copyText) {
      copyBtn.addEventListener('click', () => {
          const url = copyBtn.getAttribute('data-url') || window.location.href;
          navigator.clipboard.writeText(url).then(() => {
              copyText.textContent = postPageConfig.copySuccess;
              copyBtn.classList.add('copied');
              setTimeout(() => {
                  copyText.textContent = postPageConfig.copyDefault;
                  copyBtn.classList.remove('copied');
              }, 2000);
          }).catch(err => {
              console.error('Could not copy text: ', err);
          });
      });
  }

  // Lightbox Modal Logic
  const articleImages = document.querySelectorAll('.article-image');
  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.querySelector('.lightbox-close');

  if (lightboxModal && lightboxImg) {
      articleImages.forEach(img => {
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', () => {
              lightboxModal.style.display = 'flex';
              lightboxImg.src = img.src;
              document.body.style.overflow = 'hidden'; // Lock scroll
          });
      });

      const closeLightbox = () => {
          lightboxModal.style.display = 'none';
          document.body.style.overflow = ''; // Unlock scroll
      };

      if (lightboxClose) {
          lightboxClose.addEventListener('click', closeLightbox);
      }
      lightboxModal.addEventListener('click', (e) => {
          if (e.target === lightboxModal) {
              closeLightbox();
          }
      });
      document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
              closeLightbox();
          }
      });
  }

  // --- Likes implementation ---
  const likeBtn = document.getElementById('like-btn');
  const likeCount = document.getElementById('like-count');
  
  if (likeBtn && likeCount) {
      const postId = likeBtn.getAttribute('data-post-id');
      const likesApiUrl = `/api/likes?post_id=${encodeURIComponent(postId || '')}`;
      const isLocalPreview = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

      const fetchLikesJson = async (url, options) => {
          const res = await fetch(url, options);
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok || !contentType.includes('application/json')) {
              return null;
          }
          return res.json();
      };
      
      // Load initial likes count and status
      if (!isLocalPreview) {
          fetchLikesJson(likesApiUrl)
              .then(data => {
                  if (data && typeof data.likes === 'number') {
                      likeCount.textContent = String(data.likes);
                      if (data.user_liked) {
                          likeBtn.classList.add('liked');
                      }
                  }
              })
              .catch(() => {});
      }
          
      // Click handler
      likeBtn.addEventListener('click', () => {
          if (isLocalPreview) {
              return;
          }
          likeBtn.setAttribute('disabled', 'true');
          fetchLikesJson(likesApiUrl, { method: 'POST' })
              .then(data => {
                  if (data && typeof data.likes === 'number') {
                      likeCount.textContent = String(data.likes);
                      if (data.user_liked) {
                          likeBtn.classList.add('liked');
                      } else {
                          likeBtn.classList.remove('liked');
                      }
                  }
              })
              .catch(() => {})
              .finally(() => {
                  likeBtn.removeAttribute('disabled');
              });
      });
  }

  // --- Giscus comments implementation ---
  const giscusContainer = document.getElementById('giscus-container');
  if (giscusContainer) {
      // Configuration object
      const giscusConfig = {
          repo: "alexgetmancom/alexgetman.com",
          repoId: "R_kgDOSJwPnQ",
          category: "Announcements",
          categoryId: "DIC_kwDOSJwPnc4C-S2f",
          mapping: "og:title",
          strict: "1",
          reactionsEnabled: "1",
          emitMetadata: "0",
          inputPosition: "bottom",
          lang: postPageConfig.giscusLang,
          loading: "lazy",
      };

      const loadGiscus = () => {
          if (giscusContainer.dataset.loaded === 'true') return;
          giscusContainer.dataset.loaded = 'true';

          const savedTheme = localStorage.getItem('theme') || 'dark';
          const initialGiscusTheme = savedTheme === 'light' ? 'light' : 'dark';

          const script = document.createElement('script');
          script.src = 'https://giscus.app/client.js';
          script.setAttribute('data-repo', giscusConfig.repo);
          script.setAttribute('data-repo-id', giscusConfig.repoId);
          script.setAttribute('data-category', giscusConfig.category);
          script.setAttribute('data-category-id', giscusConfig.categoryId);
          script.setAttribute('data-mapping', giscusConfig.mapping);
          script.setAttribute('data-strict', giscusConfig.strict);
          script.setAttribute('data-reactions-enabled', giscusConfig.reactionsEnabled);
          script.setAttribute('data-emit-metadata', giscusConfig.emitMetadata);
          script.setAttribute('data-input-position', giscusConfig.inputPosition);
          script.setAttribute('data-theme', initialGiscusTheme);
          script.setAttribute('data-lang', giscusConfig.lang);
          script.setAttribute('data-loading', giscusConfig.loading);
          script.crossOrigin = 'anonymous';
          script.async = true;
          giscusContainer.appendChild(script);
      };

      if ('IntersectionObserver' in window) {
          const giscusLoader = new IntersectionObserver((entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                  loadGiscus();
                  giscusLoader.disconnect();
              }
          }, { rootMargin: '480px 0px' });
          giscusLoader.observe(giscusContainer);
      } else {
          loadGiscus();
      }

      // Sync theme switch with Giscus iframe
      const observer = new MutationObserver(() => {
          const newTheme = document.documentElement.getAttribute('data-theme') || 'dark';
          const iframe = document.querySelector('iframe.giscus-frame');
          if (iframe && iframe.contentWindow) {
              iframe.contentWindow.postMessage(
                  { giscus: { setConfig: { theme: newTheme === 'light' ? 'light' : 'dark' } } },
                  'https://giscus.app'
              );
          }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
