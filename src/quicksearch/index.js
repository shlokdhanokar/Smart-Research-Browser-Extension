// HindSite Quick Search Window
// Focus input, ESC closes window, voice input, and backend search (tab switch / semantic).

const API_BASE = 'http://localhost:8000';

/** Match content script: set false to hide `[HindSite debug]` in this popup’s DevTools console. */
const HS_THUMB_DEBUG = true;

let qsRecognition = null;
let qsRecognizing = false;
let qsSpeechBaseText = '';
let qsSpeechSupported = null;

(function () {
  if (window.self === window.top) document.body.classList.add('standalone');
})();

let qsSavedWindowBounds = null;

function clearQuickSearchResultState() {
  document.body.classList.remove('qs-has-results', 'qs-results-visible', 'qs-search-loading');
  const c = document.getElementById('resultsContainer');
  if (c) c.innerHTML = '';
  restoreQuickSearchWindowBounds();
}

function showQuickSearchLoading() {
  const container = document.getElementById('resultsContainer');
  if (!container) return;
  document.body.classList.add('qs-results-visible', 'qs-search-loading');
  document.body.classList.remove('qs-has-results');
  expandQuickSearchWindowBounds();
  container.innerHTML = `
    <div class="qs-loading-wrap" role="status" aria-live="polite">
      <div class="qs-loading-spinner" aria-hidden="true"></div>
      <span class="qs-loading-label">Searching…</span>
    </div>`;
}

function expandQuickSearchWindowBounds() {
  chrome.windows.getCurrent((win) => {
    if (!win || win.id == null) return;
    if (!qsSavedWindowBounds) {
      qsSavedWindowBounds = {
        width: win.width,
        height: win.height,
        left: win.left,
        top: win.top
      };
    }
    const sw = screen.availWidth;
    const sh = screen.availHeight;
    const w = Math.round(sw * 0.92);
    const h = Math.round(sh * 0.9);
    const left = Math.max(0, Math.round((sw - w) / 2));
    const top = Math.max(0, Math.round((sh - h) / 2));
    chrome.windows.update(win.id, { width: w, height: h, left, top, state: 'normal' });
  });
}

function restoreQuickSearchWindowBounds() {
  if (!qsSavedWindowBounds) return;
  chrome.windows.getCurrent((win) => {
    if (!win || win.id == null) return;
    const b = qsSavedWindowBounds;
    chrome.windows.update(win.id, {
      width: b.width,
      height: b.height,
      left: b.left,
      top: b.top,
      state: 'normal'
    });
    qsSavedWindowBounds = null;
  });
}

async function performSearch(query) {
  if (!query.trim()) return;

  clearQuickSearchResultState();
  showQuickSearchLoading();

  // In-out press animation on send button (Enter or click)
  const sendChip = document.querySelector('.send-chip');
  if (sendChip) {
    sendChip.classList.add('press');
    setTimeout(() => sendChip.classList.remove('press'), 180);
  }

  const tabs = await chrome.tabs.query({});
  const openTabs = tabs.map((t) => ({
    tab_id: t.id,
    window_id: t.windowId,
    url: t.url || '',
    title: t.title || ''
  }));

  try {
    const response = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.trim(),
        limit: 3,
        open_tabs: openTabs
      })
    });

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const text = await response.text();

    if (!response.ok) {
      let msg = text;
      if (isJson) {
        try {
          const body = JSON.parse(text);
          msg = body.detail ?? body.message ?? text;
        } catch (_) {
          msg = text || `Server error (${response.status})`;
        }
      }
      displayError(typeof msg === 'string' ? msg : `Server error (${response.status})`);
      return;
    }
    if (!isJson) {
      displayError('Invalid response from server.');
      return;
    }

    const data = JSON.parse(text);

    if (data.query_type === 'tab_switch' && data.matched_tab) {
      await chrome.tabs.update(data.matched_tab.tab_id, { active: true });
      await chrome.windows.update(data.matched_tab.window_id, { focused: true });
      window.close();
    } else if (data.query_type === 'semantic_search' && data.results) {
      if (HS_THUMB_DEBUG) {
        const previews = (data.results || []).map((r, i) => ({
          i,
          url: (r.url || '').slice(0, 100),
          hasThumbnailBase64: !!r.thumbnail_base64,
          thumbnailBase64Length: r.thumbnail_base64 ? r.thumbnail_base64.length : 0
        }));
        console.log('[HindSite debug] quicksearch POST /search', {
          resultCount: data.results.length,
          previews
        });
      }
      displaySearchResults(data.results);
    } else {
      displayNoResults();
    }
  } catch (error) {
    console.error('Search failed:', error);
    displayError(error.message || 'Search failed. Is the backend running?');
  }
}

function displaySearchResults(results) {
  const container = document.getElementById('resultsContainer');
  if (!container) return;

  document.body.classList.remove('qs-search-loading');

  if (results.length === 0) {
    container.innerHTML =
      '<div style="color:#94a3b8;text-align:center;padding:24px;width:100%;">No matching pages found</div>';
    document.body.classList.add('qs-results-visible');
    document.body.classList.remove('qs-has-results');
    restoreQuickSearchWindowBounds();
    return;
  }

  document.body.classList.add('qs-results-visible', 'qs-has-results');
  expandQuickSearchWindowBounds();

  container.innerHTML = results
    .map((r) => {
      const domainDisplay = escapeHtml(
        r.domain || (r.url || '').replace(/^https?:\/\//, '').split('/')[0] || ''
      );
      const urlAttr = escapeHtml(r.url || '');
      const imgSrc = r.thumbnail_base64
        ? `data:image/jpeg;base64,${escapeHtml(r.thumbnail_base64)}`
        : '';
      const thumb = imgSrc
        ? `<img src="${imgSrc}" alt="" />`
        : '<div class="result-thumb-empty">No preview</div>';
      return `
    <div class="result-card" data-url="${urlAttr}">
      <div class="result-thumb">${thumb}</div>
      <div class="result-body">
        <div class="result-head">${domainDisplay || 'URL'}</div>
        <div class="result-url-preview" title="${urlAttr}">${truncateUrlForCard(r.url, 72)}</div>
      </div>
    </div>`;
    })
    .join('');

  container.querySelectorAll('.result-card').forEach((card) => {
    card.addEventListener('click', () => {
      const url = card.getAttribute('data-url');
      if (url) chrome.tabs.create({ url });
      window.close();
    });
  });
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Full URL for display, truncated with … to fit the card (no duplicate domain line). */
function truncateUrlForCard(url, maxLen) {
  if (url == null || url === '') return '';
  const s = String(url).trim();
  if (s.length <= maxLen) return escapeHtml(s);
  return escapeHtml(s.slice(0, maxLen - 3)) + '...';
}

function displayNoResults() {
  displaySearchResults([]);
}

function displayError(message) {
  clearQuickSearchResultState();
  const container = document.getElementById('resultsContainer');
  if (container) {
    container.innerHTML = `
      <div style="color:#f87171;text-align:center;padding:24px;width:100%;">${escapeHtml(message)}</div>`;
    document.body.classList.add('qs-results-visible');
    document.body.classList.remove('qs-has-results', 'qs-search-loading');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('quickSearchInput');
  const micBtn = document.getElementById('quickSearchMicBtn');
  const shell = document.querySelector('.shell');

  if (shell) {
    requestAnimationFrame(() => shell.classList.add('is-open'));
  }

  if (input) {
    input.focus();
    autoResizeQuickInput();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        window.close();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        performSearch(input.value);
      }
    });

    input.addEventListener('input', () => {
      autoResizeQuickInput();
    });
  }

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      toggleQuickSearchSpeech();
    });
  }

  const sendChip = document.querySelector('.send-chip');
  if (sendChip) {
    sendChip.addEventListener('click', () => {
      performSearch(input ? input.value : '');
    });
    sendChip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        performSearch(input ? input.value : '');
      }
    });
  }

  // Enter always sends (e.g. when focus is on mic after speaking)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const inp = document.getElementById('quickSearchInput');
    if (inp && e.target === inp) return;
    e.preventDefault();
    performSearch(inp ? inp.value : '');
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'KeyV') return;
      e.preventDefault();
      toggleQuickSearchSpeech();
    },
    true
  );
});

function ensureQuickSearchSpeechSupport() {
  if (qsSpeechSupported !== null) return qsSpeechSupported;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  qsSpeechSupported = !!SpeechRecognition;
  if (qsSpeechSupported && !qsRecognition) {
    const SR = SpeechRecognition;
    qsRecognition = new SR();
    qsRecognition.lang = navigator.language || 'en-US';
    qsRecognition.continuous = false;
    qsRecognition.interimResults = true;

    qsRecognition.onstart = () => {
      qsRecognizing = true;
      const micBtn = document.getElementById('quickSearchMicBtn');
      if (micBtn) micBtn.classList.add('listening');
      const input = document.getElementById('quickSearchInput');
      qsSpeechBaseText = input && input.value ? input.value : '';
    };

    qsRecognition.onresult = (event) => {
      const input = document.getElementById('quickSearchInput');
      if (!input) return;

      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          finalText += res[0].transcript;
        } else {
          interimText += res[0].transcript;
        }
      }

      const base = qsSpeechBaseText ? qsSpeechBaseText + ' ' : '';
      const combined = (base + finalText + ' ' + interimText).trim();
      input.value = combined;
      autoResizeQuickInput();
    };

    qsRecognition.onerror = () => {
      qsRecognizing = false;
      const micBtn = document.getElementById('quickSearchMicBtn');
      if (micBtn) micBtn.classList.remove('listening');
    };

    qsRecognition.onend = () => {
      qsRecognizing = false;
      const micBtn = document.getElementById('quickSearchMicBtn');
      if (micBtn) micBtn.classList.remove('listening');
    };
  }
  return qsSpeechSupported;
}

function startQuickSearchSpeech() {
  if (!ensureQuickSearchSpeechSupport()) return;
  if (!qsRecognition || qsRecognizing) return;
  try {
    qsRecognition.start();
  } catch (e) {
    // ignore repeated start errors
  }
}

function stopQuickSearchSpeech() {
  if (qsRecognition && qsRecognizing) {
    try {
      qsRecognition.stop();
    } catch (_) {}
  }
}

function toggleQuickSearchSpeech() {
  if (qsRecognizing) {
    stopQuickSearchSpeech();
  } else {
    startQuickSearchSpeech();
  }
}

function autoResizeQuickInput() {
  const input = document.getElementById('quickSearchInput');
  if (!input) return;

  input.style.height = 'auto';
  const maxHeight = 120;
  const nextHeight = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

