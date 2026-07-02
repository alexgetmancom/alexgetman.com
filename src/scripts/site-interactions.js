(() => {
    if (window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1")) {
        return;
    }
    const payload = JSON.stringify({ path: window.location.pathname || "/" });
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon("/stats/pageview", new Blob([payload], { type: "application/json" }));
            return;
        }
        fetch("/stats/pageview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
            credentials: "omit",
            cache: "no-store"
        });
    } catch (_) {}
})();

// Expandable Social Bar & Theme Toggle Logic
document.addEventListener('DOMContentLoaded', () => {
    // Navigation Drawer Toggle Logic
    const burgerButtons = [
        document.getElementById('burger-toggle-btn'),
        document.getElementById('immersive-burger-btn')
    ].filter(Boolean);
    const navCloseBtn = document.getElementById('nav-close-btn');
    const navOverlay = document.getElementById('nav-overlay');
    const navDrawer = document.getElementById('nav-drawer');

    function openDrawer() {
        if (navDrawer && navOverlay) {
            navDrawer.classList.add('active');
            navOverlay.classList.add('active');
        }
    }

    function closeDrawer() {
        if (navDrawer && navOverlay) {
            navDrawer.classList.remove('active');
            navOverlay.classList.remove('active');
        }
    }

    burgerButtons.forEach((button) => button.addEventListener('click', openDrawer));

    if (navCloseBtn) {
        navCloseBtn.addEventListener('click', closeDrawer);
    }

    if (navOverlay) {
        navOverlay.addEventListener('click', closeDrawer);
    }

    // Close drawer on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDrawer();
        }
    });

    // Close drawer on link selection
    const drawerLinks = document.querySelectorAll('.nav-drawer__link');
    drawerLinks.forEach(link => {
        link.addEventListener('click', () => {
            closeDrawer();
        });
    });



    // Header search: full local index with a small results panel.
    const headerSearchInput = document.getElementById('header-search-input');
    const headerSearchClear = document.getElementById('header-search-clear');
    const searchResultsPanel = document.getElementById('search-results-panel');
    let searchIndexPromise = null;
    let activeSearchResults = [];
    let activeSearchIndex = 0;

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const normalizeSearchText = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const pageLang = document.documentElement.getAttribute('lang') || 'ru';
    const isEnglishPage = pageLang.toLowerCase().startsWith('en');
    const searchDateLocale = isEnglishPage ? 'en-GB' : 'ru-RU';
    const searchEmptyText = isEnglishPage ? 'No results found' : 'Ничего не найдено';

    function loadSearchIndex() {
        if (!searchIndexPromise) {
            searchIndexPromise = fetch('/search-index.json')
                .then((res) => {
                    if (!res.ok) {
                        throw new Error('Search index unavailable');
                    }
                    return res.json();
                })
                .then((data) => Array.isArray(data.items) ? data.items : [])
                .catch(() => []);
        }
        return searchIndexPromise;
    }

    function scoreSearchItem(item, query) {
        const title = normalizeSearchText(item.title);
        const source = normalizeSearchText(item.source);
        const category = normalizeSearchText(item.category);
        const excerpt = normalizeSearchText(item.excerpt);
        const haystack = `${title} ${source} ${category} ${excerpt}`;
        if (!haystack.includes(query)) return 0;
        let score = 1;
        if (title === query) score += 8;
        if (title.startsWith(query)) score += 5;
        if (title.includes(query)) score += 3;
        if (category.includes(query) || source.includes(query)) score += 2;
        return score;
    }

    function renderSearchResults(results, query) {
        if (!searchResultsPanel) return;
        activeSearchResults = results;
        activeSearchIndex = 0;

        if (!query || query.length < 2) {
            searchResultsPanel.classList.remove('is-open');
            searchResultsPanel.innerHTML = '';
            return;
        }

        searchResultsPanel.classList.add('is-open');
        if (results.length === 0) {
            searchResultsPanel.innerHTML = `<div class="search-result-empty">${searchEmptyText}</div>`;
            return;
        }

        searchResultsPanel.innerHTML = results.map((item, index) => {
            const date = item.date ? new Date(item.date).toLocaleDateString(searchDateLocale, {
                day: 'numeric',
                month: 'short',
                timeZone: 'Europe/Moscow'
            }) : '';
            return `
                <a class="search-result-item ${index === 0 ? 'is-active' : ''}" href="${escapeHtml(item.url)}" role="option" data-search-result-index="${index}">
                    <span class="search-result-title">${escapeHtml(item.title)}</span>
                    <span class="search-result-meta">
                        <span>${escapeHtml(item.source)}</span>
                        ${item.category ? `<span>•</span><span>${escapeHtml(item.category)}</span>` : ''}
                        ${date ? `<span>•</span><span>${escapeHtml(date)}</span>` : ''}
                    </span>
                    ${item.excerpt ? `<span class="search-result-excerpt">${escapeHtml(item.excerpt)}</span>` : ''}
                </a>
            `;
        }).join('');
    }

    async function runHeaderSearch(value) {
        const query = normalizeSearchText(value);
        headerSearchClear?.classList.toggle('is-visible', query.length > 0);
        window.dispatchEvent(new CustomEvent('site-search-query', { detail: { query } }));

        if (query.length < 2) {
            renderSearchResults([], query);
            return;
        }

        const items = await loadSearchIndex();
        const results = items
            .filter((item) => isEnglishPage ? !String(item.url || '').startsWith('/ru/') : String(item.url || '').startsWith('/ru/'))
            .map((item) => ({ item, score: scoreSearchItem(item, query) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score || new Date(b.item.date || 0).getTime() - new Date(a.item.date || 0).getTime())
            .slice(0, 8)
            .map((entry) => entry.item);
        renderSearchResults(results, query);
    }

    function setActiveSearchResult(index) {
        if (!searchResultsPanel || activeSearchResults.length === 0) return;
        activeSearchIndex = Math.max(0, Math.min(index, activeSearchResults.length - 1));
        searchResultsPanel.querySelectorAll('.search-result-item').forEach((item, itemIndex) => {
            item.classList.toggle('is-active', itemIndex === activeSearchIndex);
        });
    }

    if (headerSearchInput) {
        const params = new URLSearchParams(window.location.search);
        const searchParam = params.get('search');
        if (searchParam) {
            headerSearchInput.value = searchParam;
        }

        headerSearchInput.addEventListener('input', (e) => {
            runHeaderSearch(e.target.value);
        });

        headerSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveSearchResult(activeSearchIndex + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveSearchResult(activeSearchIndex - 1);
            } else if (e.key === 'Enter') {
                if (activeSearchResults[activeSearchIndex]) {
                    e.preventDefault();
                    window.location.href = activeSearchResults[activeSearchIndex].url;
                }
            } else if (e.key === 'Escape') {
                searchResultsPanel?.classList.remove('is-open');
                headerSearchInput.blur();
            }
        });

        if (searchParam) {
            runHeaderSearch(searchParam);
            if (window.location.pathname === '/') {
                const newUrl = window.location.protocol + '//' + window.location.host + window.location.pathname;
                window.history.replaceState({ path: newUrl }, '', newUrl);
            }
        }
    }

    if (headerSearchClear && headerSearchInput) {
        headerSearchClear.addEventListener('click', () => {
            headerSearchInput.value = '';
            runHeaderSearch('');
            headerSearchInput.focus();
        });
    }

    searchResultsPanel?.addEventListener('mousemove', (e) => {
        const item = e.target.closest?.('.search-result-item');
        if (!item) return;
        const index = Number(item.getAttribute('data-search-result-index'));
        if (Number.isFinite(index)) {
            setActiveSearchResult(index);
        }
    });

    document.addEventListener('click', (e) => {
        const target = e.target;
        if (
            target instanceof Node &&
            headerSearchInput &&
            searchResultsPanel &&
            !headerSearchInput.contains(target) &&
            !searchResultsPanel.contains(target) &&
            !headerSearchClear?.contains(target)
        ) {
            searchResultsPanel.classList.remove('is-open');
        }
    });

    if (headerSearchInput && headerSearchClear) {
        headerSearchClear.classList.toggle('is-visible', headerSearchInput.value.trim().length > 0);
    }

    // Theme Toggle Logic
    const themeToggleButtons = document.querySelectorAll('.theme-toggle');
    themeToggleButtons.forEach((themeToggleBtn) => {
        themeToggleBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            
            if (newTheme === 'light') {
                document.documentElement.setAttribute('data-theme', 'light');
                localStorage.setItem('theme', 'light');
            } else {
                document.documentElement.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
            }
        });
    });

    // Language Toggle Logic
    const langToggleBtn = document.getElementById('lang-toggle-btn');
    if (langToggleBtn) {
        langToggleBtn.addEventListener('click', () => {
            const currentLang = (document.documentElement.getAttribute('lang') || 'ru').toLowerCase();
            window.location.href = currentLang.startsWith('ru') ? '/' : '/ru/';
        });
    }
});
