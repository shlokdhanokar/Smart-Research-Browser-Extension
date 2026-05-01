// ============================================
// HindSite - Background Service Worker
// Handles keyboard commands and messaging
// ============================================

const API_BASE = 'http://localhost:8000';
// Keep pre-captured thumbnails for a short window until the page is actually saved.
const THUMB_TTL_MS = 20 * 60 * 1000;

function normUrl(u) {
  if (!u) return '';
  try {
    return u.split('#')[0].replace(/\/$/, '') || u;
  } catch (_) {
    return u;
  }
}

function thumbKeys(url) {
  const n = normUrl(url);
  if (!n) return [n];
  try {
    const u = new URL(n);
    const h = u.hostname.toLowerCase();
    const alt = h.startsWith('www.') ? h.slice(4) : 'www.' + h;
    return [n, n.replace(u.hostname, alt)];
  } catch (_) {
    return [n];
  }
}

function cleanupTemp(temp) {
  const now = Date.now();
  Object.keys(temp).forEach((k) => {
    if (temp[k] && temp[k].ts && now - temp[k].ts > THUMB_TTL_MS) delete temp[k];
  });
}

/**
 * Capture visible tab, resize in page, store under thumbKeys(tabUrl).
 * Returns a diagnostic object for content-script console logging.
 */
function runThumbnailCapture(tabId, winId, tabUrl) {
  const keys = thumbKeys(tabUrl);
  return chrome.tabs
    .captureVisibleTab(winId, { format: 'jpeg', quality: 80 })
    .then((dataUrl) => {
      if (!dataUrl) {
        return { ok: false, reason: 'capture_empty', keys };
      }
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'RESIZE_THUMBNAIL', dataUrl }, (r) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              reason: 'resize_message_failed',
              detail: chrome.runtime.lastError.message,
              keys
            });
            return;
          }
          const out = r && r.dataUrl ? r.dataUrl : null;
          if (!out) {
            resolve({ ok: false, reason: 'resize_no_dataUrl', keys });
            return;
          }
          chrome.storage.local.get(['thumbTemp'], (st) => {
            const temp = st.thumbTemp || {};
            const entry = { dataUrl: out, ts: Date.now() };
            keys.forEach((k) => {
              if (k) temp[k] = entry;
            });
            cleanupTemp(temp);
            chrome.storage.local.set({ thumbTemp: temp }, () =>
              resolve({
                ok: true,
                reason: 'stored',
                keys,
                jpegChars: out.length
              })
            );
          });
        });
      });
    })
    .catch((e) => ({
      ok: false,
      reason: 'capture_failed',
      detail: String(e && e.message ? e.message : e),
      keys
    }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PREPARE_THUMBNAIL_FOR_SAVE' && sender.tab) {
    if (!sender.tab.active) {
      sendResponse({ ok: false, reason: 'tab_not_active' });
      return false;
    }
    runThumbnailCapture(sender.tab.id, sender.tab.windowId, sender.tab.url).then((result) =>
      sendResponse(result)
    );
    return true;
  }

  if (message.type === 'SYNC_THUMBNAIL_TO_BACKEND' && message.url) {
    const targetUrl = message.url;
    chrome.storage.local.get(['thumbTemp'], (st) => {
      const temp = st.thumbTemp || {};
      const keys = thumbKeys(targetUrl);
      let raw = null;
      let matchedKey = null;
      for (const k of keys) {
        if (temp[k] && temp[k].dataUrl) {
          raw = temp[k].dataUrl;
          matchedKey = k;
          break;
        }
      }
      if (!raw) {
        sendResponse({
          ok: false,
          reason: 'no_temp_for_url',
          keysTried: keys,
          url: targetUrl
        });
        return;
      }
      const b64 = raw.replace(/^data:image\/\w+;base64,/, '');
      fetch(`${API_BASE}/pages/thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, thumbnail: b64 })
      })
        .then(async (res) => {
          const text = await res.text();
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch (_) {
            body = { raw: text };
          }
          sendResponse({
            ok: res.ok,
            reason: res.ok ? 'thumbnail_upserted' : 'http_error',
            httpStatus: res.status,
            b64Len: b64.length,
            matchedKey,
            body
          });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            reason: 'fetch_failed',
            detail: String(err.message || err)
          });
        });
    });
    return true;
  }

  if (message.type === 'PAGE_LOADED_FOR_THUMBNAIL' && sender.tab) {
    if (!sender.tab.active) {
      sendResponse({ ok: false, reason: 'tab_not_active' });
      return false;
    }
    runThumbnailCapture(sender.tab.id, sender.tab.windowId, sender.tab.url).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === 'SEND_TO_BACKEND' && message.pageData) {
    chrome.storage.local.get(['thumbTemp'], (st) => {
      const temp = st.thumbTemp || {};
      const keys = thumbKeys(message.pageData.url);
      let found = null;
      for (const k of keys) {
        if (temp[k] && temp[k].dataUrl) {
          found = temp[k];
          break;
        }
      }
      const pageData = { ...message.pageData };
      if (found && found.dataUrl) {
        pageData.thumbnail = found.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        keys.forEach((k) => delete temp[k]);
        chrome.storage.local.set({ thumbTemp: temp });
      }
      fetch(`${API_BASE}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: pageData.url,
          content: pageData.content,
          title: pageData.title,
          domain: pageData.domain,
          summary: pageData.summary,
          timestamp: pageData.timestamp,
          metadata: pageData.metadata,
          thumbnail: pageData.thumbnail || undefined
        })
      })
      .then((res) => {
        if (res.ok) return res.json();
        return res.text().then((t) => Promise.reject(new Error(`${res.status} ${t}`)));
      })
      .then((result) => {
        console.log('HindSite: Page sent to backend:', result?.status);
        sendResponse({
          ok: true,
          thumbAttached: !!pageData.thumbnail,
          b64Len: pageData.thumbnail ? pageData.thumbnail.length : 0,
          apiStatus: result?.status,
          keysTried: keys
        });
      })
      .catch((err) => {
        console.log('HindSite: Backend unavailable, saved locally only', err.message);
        sendResponse({
          ok: false,
          reason: 'fetch_failed',
          detail: err.message,
          thumbAttached: !!pageData.thumbnail,
          b64Len: pageData.thumbnail ? pageData.thumbnail.length : 0,
          keysTried: keys
        });
      });
    });
    return true;
  }

  if (message.type === 'SEARCH' && typeof message.query === 'string') {
    const query = message.query.trim();
    if (!query) {
      sendResponse({ error: 'empty_query' });
      return false;
    }
    chrome.tabs.query({}, (tabs) => {
      const openTabs = (tabs || []).map((t) => ({
        tab_id: t.id,
        window_id: t.windowId,
        url: t.url || '',
        title: t.title || ''
      }));
      fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          limit: 3,
          open_tabs: openTabs
        })
      })
        .then(async (res) => {
          const contentType = res.headers.get('content-type') || '';
          const isJson = contentType.includes('application/json');
          const text = await res.text();
          if (!res.ok) {
            let msg = text;
            if (isJson) {
              try {
                const body = JSON.parse(text);
                msg = body.detail || body.message || text;
              } catch (_) {
                msg = text || `Server error (${res.status})`;
              }
            }
            throw new Error(typeof msg === 'string' ? msg : `Server error (${res.status})`);
          }
          if (!isJson) throw new Error(text || 'Invalid response');
          return JSON.parse(text);
        })
        .then((data) => {
          if (data.query_type === 'tab_switch' && data.matched_tab) {
            chrome.tabs.update(data.matched_tab.tab_id, { active: true }).then(() => {
              return chrome.windows.update(data.matched_tab.window_id, { focused: true });
            }).then(() => {
              sendResponse({ action: 'tab_switch' });
            }).catch((err) => {
              console.error('HindSite: tab switch failed', err);
              sendResponse({ action: 'error', error: err.message });
            });
          } else if (data.query_type === 'semantic_search' && data.results) {
            sendResponse({ action: 'semantic_search', results: data.results });
          } else {
            sendResponse({ action: 'no_results' });
          }
        })
        .catch((err) => {
          console.error('HindSite: search failed', err);
          sendResponse({ action: 'error', error: err.message });
        });
    });
    return true; // async sendResponse
  }

  if (message.type === 'OPEN_URL' && message.url) {
    chrome.tabs.create({ url: message.url }, () => sendResponse({ ok: true }));
    return true;
  }
});

function openQuickSearchWindow() {
  const width = 560;
  const height = 160;

  chrome.windows.getCurrent({}, (currentWin) => {
    const createData = {
      url: chrome.runtime.getURL('src/quicksearch/index.html'),
      type: 'popup',
      width,
      height,
      focused: true
    };

    if (
      currentWin &&
      typeof currentWin.left === 'number' &&
      typeof currentWin.top === 'number' &&
      typeof currentWin.width === 'number' &&
      typeof currentWin.height === 'number'
    ) {
      const left = Math.round(currentWin.left + (currentWin.width - width) / 2);
      const top = Math.round(currentWin.top + currentWin.height - height - 40);
      createData.left = left;
      createData.top = top;
    }

    chrome.windows.create(createData);
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle_overlay') {
    return;
  }

  // Find the active tab in the current window
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      openQuickSearchWindow();
      return;
    }

    const url = tab.url || '';
    const isRestricted =
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('devtools://') ||
      url.startsWith('view-source:') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.includes('chrome.google.com/webstore');

    if (isRestricted) {
      openQuickSearchWindow();
      return;
    }

    // Non-restricted page: only toggle in-page overlay
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' });
  });
});

