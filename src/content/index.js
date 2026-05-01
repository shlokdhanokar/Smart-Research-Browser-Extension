// ============================================
// HindSite - Content Script
// Tracks time, scroll, and extracts content
// ============================================

// ============================================
// INITIALIZATION
// ============================================
let activeTime = 0;
let timerRunning = false;
let timerInterval = null;

let maxScrollPercent = 0;
let scrollHistory = [];
let lastScrollTime = null;

let isShortPage = false;
let hasExtracted = false;

let checkInterval = null;

// Overlay state
let hsOverlayRoot = null;
let hsOverlayPanel = null;
let hsOverlayInput = null;
let hsOverlayVisible = false;
let hsOverlayMicBtn = null;
let hsOverlayHideTimer = null;
let hsOverlayAltVKeyBound = false;

// Speech recognition state (overlay)
let hsRecognition = null;
let hsRecognizing = false;
let hsSpeechBaseText = '';
let hsSpeechSupported = null;

console.log('🔍 HindSite: Monitoring started');

/** Set false to silence `[HindSite debug]` lines in this tab’s DevTools console. */
const HS_THUMB_DEBUG = true;

function hsThumbDebug(label, payload) {
  if (!HS_THUMB_DEBUG) return;
  if (payload !== undefined) {
    console.log('[HindSite debug]', label, payload);
  } else {
    console.log('[HindSite debug]', label);
  }
}

/** Avoid logging full base64 from SEARCH results. */
function summarizeDebugResponse(messageType, response) {
  if (messageType === 'SEARCH' && response && Array.isArray(response.results)) {
    return {
      action: response.action,
      error: response.error,
      resultCount: response.results.length,
      previews: response.results.map((r) => ({
        url: (r.url || '').slice(0, 100),
        hasThumbnailBase64: !!r.thumbnail_base64,
        thumbnailBase64Length: r.thumbnail_base64 ? r.thumbnail_base64.length : 0
      }))
    };
  }
  return response;
}

function extensionContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

/**
 * After reloading the extension on chrome://extensions, old content scripts keep running but
 * chrome.runtime APIs throw "Extension context invalidated". Guard all sends (especially after setTimeout).
 */
function safeSendMessage(message, callback) {
  if (!extensionContextValid()) {
    hsThumbDebug('safeSendMessage: extension context invalid (reload extension → refresh this tab)', {
      type: message.type
    });
    if (callback) queueMicrotask(() => callback());
    return;
  }
  try {
    if (callback) {
      chrome.runtime.sendMessage(message, (response) => {
        hsThumbDebug(`← ${message.type}`, {
          response: summarizeDebugResponse(message.type, response),
          lastError: chrome.runtime.lastError && chrome.runtime.lastError.message
        });
        callback(response);
      });
    } else {
      const ret = chrome.runtime.sendMessage(message);
      if (ret && typeof ret.then === 'function') {
        ret
          .then((response) => {
            hsThumbDebug(`← ${message.type}`, { response });
          })
          .catch((err) => {
            hsThumbDebug(`← ${message.type} (promise rejected)`, { err: String(err) });
          });
      }
    }
  } catch (e) {
    hsThumbDebug('safeSendMessage: thrown', { type: message.type, error: String(e) });
    if (callback) queueMicrotask(() => callback());
  }
}

// ============================================
// PAGE ANALYSIS
// ============================================
function analyzePageHeight() {
  const pageHeight = document.documentElement.scrollHeight;
  const windowHeight = window.innerHeight;
  const scrollableArea = pageHeight - windowHeight;
  
  if (scrollableArea < 100) {
    isShortPage = true;
    console.log('📄 Short page detected - will use time-only criteria');
  } else {
    isShortPage = false;
    console.log('📜 Normal page detected - will use time + scroll criteria');
  }
}

function scheduleThumbnailCapture(delayMs, source) {
  const href = window.location.href;
  if (!href.startsWith('http://') && !href.startsWith('https://')) {
    hsThumbDebug('thumbnail: skip schedule (URL not http/https)', { href, source });
    return;
  }
  hsThumbDebug('thumbnail: schedule delayed PAGE_LOADED_FOR_THUMBNAIL', { delayMs, source, href });
  setTimeout(() => {
    hsThumbDebug('thumbnail: timer fired', {
      source,
      href,
      contextOk: extensionContextValid()
    });
    // Ensure we capture the top of the page (viewport at scroll=0) when the URL is hit.
    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    try {
      if (prevScrollX !== 0 || prevScrollY !== 0) window.scrollTo(0, 0);
    } catch (_) {
      // Ignore scroll restoration failures (some sites block programmatic scroll).
    }

    safeSendMessage({ type: 'PAGE_LOADED_FOR_THUMBNAIL' }, () => {
      requestAnimationFrame(() => {
        try {
          if (prevScrollX !== 0 || prevScrollY !== 0) window.scrollTo(prevScrollX, prevScrollY);
        } catch (_) {
          // ignore
        }
      });
    });
  }, delayMs);
}

window.addEventListener('load', () => {
  analyzePageHeight();
  // Capture soon after URL load (top-of-page viewport) and keep it in temp storage.
  scheduleThumbnailCapture(200, 'window.load');
});

// After the user focuses this tab again, capture (needed because captureVisibleTab only sees the active tab).
let docWasHidden = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') docWasHidden = true;
  else if (document.visibilityState === 'visible' && docWasHidden && document.readyState === 'complete') {
    // When returning focus, refresh the top-of-page thumbnail viewport.
    scheduleThumbnailCapture(200, 'visibilitychange');
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'RESIZE_THUMBNAIL' || !msg.dataUrl) return;
  hsThumbDebug('RESIZE_THUMBNAIL: raw capture received in page', {
    dataUrlLength: msg.dataUrl.length
  });
  const img = new Image();
  img.onload = () => {
    try {
      const sw = img.width;
      const sh = img.height;
      // Preserve full viewport aspect (same as screen capture); scale down only — no edge crop.
      const maxW = 1280;
      const maxH = 900;
      const scale = Math.min(maxW / sw, maxH / sh, 1);
      const tw = Math.max(1, Math.round(sw * scale));
      const th = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, sw, sh, 0, 0, tw, th);
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.88);
      hsThumbDebug('RESIZE_THUMBNAIL: JPEG ready', {
        jpegDataUrlLength: jpegDataUrl.length,
        outSize: `${tw}x${th}`,
        sourceImage: `${sw}x${sh}`
      });
      sendResponse({ dataUrl: jpegDataUrl });
    } catch (err) {
      hsThumbDebug('RESIZE_THUMBNAIL: canvas error', { error: String(err) });
      sendResponse({ dataUrl: null });
    }
  };
  img.onerror = () => {
    hsThumbDebug('RESIZE_THUMBNAIL: image decode failed');
    sendResponse({ dataUrl: null });
  };
  img.src = msg.dataUrl;
  return true;
});

// ============================================
// ACTIVE TIME TRACKING
// ============================================
function startTimer() {
  if (!timerRunning) {
    timerRunning = true;
    
    timerInterval = setInterval(() => {
      if (timerRunning) {
        activeTime++;
        console.log(`⏱️ Active time: ${activeTime}s`);
      }
    }, 1000);
  }
}

function pauseTimer() {
  timerRunning = false;
  console.log('⏸️ Timer paused');
}

function resumeTimer() {
  timerRunning = true;
  console.log('▶️ Timer resumed');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseTimer();
  } else {
    resumeTimer();
  }
});

startTimer();

// ============================================
// SCROLL TRACKING
// ============================================
function calculateScrollPercent() {
  const scrollTop = window.scrollY;
  const windowHeight = window.innerHeight;
  const docHeight = document.documentElement.scrollHeight;
  
  const scrollableDistance = docHeight - windowHeight;
  
  if (scrollableDistance <= 0) {
    return 0;
  }
  
  const scrollPercent = (scrollTop / scrollableDistance) * 100;
  return Math.min(Math.round(scrollPercent), 100);
}

function updateScrollTracking() {
  const currentScroll = calculateScrollPercent();
  const currentTime = Date.now();
  
  if (currentScroll > maxScrollPercent) {
    maxScrollPercent = currentScroll;
    
    scrollHistory.push({
      percent: currentScroll,
      timestamp: currentTime
    });
    
    console.log(`📜 Scroll: ${maxScrollPercent}%`);
  }
  
  lastScrollTime = currentTime;
}

window.addEventListener('scroll', updateScrollTracking);
window.addEventListener('load', updateScrollTracking);

// ============================================
// GRADUAL SCROLL DETECTION
// ============================================
function wasScrollGradual() {
  if (maxScrollPercent < 40) {
    return false;
  }
  
  let timeToReach40 = null;
  
  for (let i = 0; i < scrollHistory.length; i++) {
    if (scrollHistory[i].percent >= 40) {
      const firstTime = scrollHistory[0].timestamp;
      const fortyPercentTime = scrollHistory[i].timestamp;
      timeToReach40 = (fortyPercentTime - firstTime) / 1000;
      break;
    }
  }
  
  if (timeToReach40 !== null && timeToReach40 < 10) {
    console.log(`⚠️ Scroll too fast: ${timeToReach40}s to reach 40%`);
    return false;
  }
  
  console.log(`✅ Gradual scroll detected: ${timeToReach40}s to reach 40%`);
  return true;
}

// ============================================
// THRESHOLD CHECKING
// ============================================
function checkThresholds() {
  if (hasExtracted) {
    return;
  }
  
  console.log('🔍 Checking thresholds...');
  console.log(`   Active time: ${activeTime}s / 60s`);
  console.log(`   Max scroll: ${maxScrollPercent}% / 40%`);
  console.log(`   Is short page: ${isShortPage}`);
  
  if (isShortPage) {
    if (activeTime >= 60) {
      console.log('✅ Short page threshold met: 60s active time');
      extractContent();
    }
  } else {
    if (activeTime >= 60 && maxScrollPercent >= 40 && wasScrollGradual()) {
      console.log('✅ Normal page thresholds met: 60s + 40% scroll + gradual');
      extractContent();
    }
  }
}

checkInterval = setInterval(checkThresholds, 5000);

// ============================================
// CONTENT EXTRACTION (Readability + fallback)
// ============================================
function getMetaDescription() {
  const el = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
  return (el && el.getAttribute('content')) ? el.getAttribute('content').trim() : '';
}

function getFirstParagraphs(maxParagraphs, maxChars) {
  if (!document.body) return '';
  const paras = document.body.querySelectorAll('p');
  const parts = [];
  let total = 0;
  for (let i = 0; i < paras.length && i < maxParagraphs; i++) {
    const t = (paras[i].textContent || '').trim();
    if (t) {
      parts.push(t);
      total += t.length;
      if (total >= maxChars) break;
    }
  }
  return parts.join('\n\n').slice(0, maxChars);
}

function getFullBodyText(maxChars) {
  if (!document.body || !document.body.innerText) return '';
  return document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** Use Readability whenever it returns any content (no minimum word count). */
function extractContentWithReadability() {
  try {
    const docClone = document.cloneNode(true);
    if (typeof Readability === 'undefined') {
      return null;
    }
    const reader = new Readability(docClone);
    const article = reader.parse();
    if (!article || !article.textContent || !article.textContent.trim()) {
      return null;
    }
    return {
      title: (article.title && article.title.trim()) || document.title || '',
      content: article.textContent.trim(),
      summary: (article.excerpt && article.excerpt.trim()) || ''
    };
  } catch (e) {
    console.warn('HindSite Readability failed:', e);
    return null;
  }
}

/** Fallback: title, meta, then as much body as we can (multiple paragraphs or full body truncated). */
function extractContentFallback() {
  const title = document.title || '';
  const metaDesc = getMetaDescription();
  const metaAndTitle = [title, metaDesc].filter(Boolean).join('\n\n');
  // Take first 8 paragraphs or 5000 chars of body text so we don't lose context
  const bodyChunk = getFirstParagraphs(8, 5000) || getFullBodyText(5000);
  const content = [metaAndTitle, bodyChunk].filter(Boolean).join('\n\n') || getFullBodyText(8000);
  return {
    title,
    content: content || (document.body && document.body.innerText) || '',
    summary: metaDesc || bodyChunk.slice(0, 300) || ''
  };
}

/** Append extra context from full page so we don't over-filter; cap total size. */
function appendExtraContext(primaryContent, maxExtraChars, maxTotalChars) {
  const fullBody = getFullBodyText(maxExtraChars + 1000);
  if (!fullBody) return primaryContent;
  // Avoid huge duplication: if primary is already most of body, add only a tail
  const primaryLen = primaryContent.length;
  const toAdd = fullBody.length > primaryLen ? fullBody.slice(primaryLen) : fullBody;
  const extra = toAdd.replace(/\s+/g, ' ').trim().slice(0, maxExtraChars);
  if (!extra) return primaryContent;
  const combined = primaryContent + '\n\n' + extra;
  return combined.length <= maxTotalChars ? combined : primaryContent + '\n\n' + extra.slice(0, maxTotalChars - primaryContent.length - 2);
}

function extractContent() {
  console.log('📥 Extracting content...');

  hasExtracted = true;
  clearInterval(timerInterval);
  clearInterval(checkInterval);
  pauseTimer();

  let title = '';
  let content = '';
  let summary = '';

  const readResult = extractContentWithReadability();
  if (readResult) {
    title = readResult.title;
    content = readResult.content;
    summary = readResult.summary;
    console.log('📥 Used Readability (main article, any length)');
  } else {
    const fallback = extractContentFallback();
    title = fallback.title;
    content = fallback.content;
    summary = fallback.summary;
    console.log('📥 Used fallback (title + meta + first 8 paragraphs / body)');
  }

  // Bake in extra context from full page so we don't over-filter (backend embeds up to 8k chars)
  const beforeLen = content.length;
  content = appendExtraContext(content, 3500, 11000);
  if (content.length > beforeLen) {
    console.log('📥 Appended extra page context: +' + (content.length - beforeLen) + ' chars');
  }

  const url = window.location.href;
  const domain = (function () {
    try {
      return new URL(url).hostname || url;
    } catch (_) {
      return url;
    }
  })();
  const timestamp = new Date().toISOString();
  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

  const pageData = {
    url,
    title,
    domain,
    summary,
    content,
    timestamp,
    metadata: {
      timeSpent: activeTime,
      scrollPercent: maxScrollPercent,
      timestamp,
      wordCount,
      isShortPage: isShortPage
    }
  };

  console.log('📦 Content extracted:', { url, title, domain, wordCount });
  hsThumbDebug('extractContent: thresholds met → saveToStorage next', {
    url,
    wordCount
  });
  saveToStorage(pageData);
}

// ============================================
// STORAGE
// ============================================
function saveToStorage(pageData) {
  chrome.storage.local.get(['savedPages'], (result) => {
    const savedPages = result.savedPages || [];
    const urlExists = savedPages.some((page) => page.url === pageData.url);

    hsThumbDebug('saveToStorage: start', {
      url: pageData.url,
      urlExistsInLocalStorage: urlExists
    });

    // IMPORTANT: Do not capture here anymore.
    // Thumbnail is captured when the URL is hit (PAGE_LOADED_FOR_THUMBNAIL) and cached in thumbTemp.
    if (urlExists) {
      console.log('⚠️ Page already saved locally — syncing thumbnail to backend only');
      safeSendMessage({ type: 'SYNC_THUMBNAIL_TO_BACKEND', url: pageData.url }, () => {});
      return;
    }

    savedPages.push(pageData);

    chrome.storage.local.set({ savedPages: savedPages }, () => {
      console.log('✅ Page saved to storage!');
      console.log(`   Total pages saved: ${savedPages.length}`);
      showNotification();

      safeSendMessage({ type: 'SEND_TO_BACKEND', pageData }, () => {});
    });
  });
}

function showNotification() {
  const notification = document.createElement('div');
  notification.textContent = 'Page saved to HindSite';
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4CAF50;
    color: white;
    padding: 15px 20px;
    border-radius: 5px;
    z-index: 10000;
    font-family: Arial, sans-serif;
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// ============================================
// OVERLAY SEARCH BAR (TOGGLED BY SHORTCUT)
// ============================================

function createOverlayIfNeeded() {
  if (hsOverlayRoot) return;

  hsOverlayRoot = document.createElement('div');
  hsOverlayRoot.id = 'hindsite-overlay-root';
  hsOverlayRoot.className = 'hs-root';
  hsOverlayRoot.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    pointer-events: none;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    box-sizing: border-box;
  `;

  // Inject lightweight CSS once (for animations / mic pulse)
  if (!document.getElementById('hindsite-overlay-style')) {
    const style = document.createElement('style');
    style.id = 'hindsite-overlay-style';
    style.textContent = `
      #hindsite-overlay-root .hs-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, 0.58);
        backdrop-filter: blur(8px);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity 0.22s ease, visibility 0.22s ease;
        z-index: 0;
      }
      #hindsite-overlay-root.hs-results-focus .hs-backdrop {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
      }
      #hindsite-overlay-root .hs-main {
        position: relative;
        z-index: 1;
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 0;
        width: 100%;
        pointer-events: none;
      }
      #hindsite-overlay-root.hs-results-focus .hs-main {
        justify-content: flex-end;
        padding-bottom: 10px;
      }
      #hindsite-overlay-root .hs-overlay-results {
        display: none;
        flex-direction: row;
        align-items: flex-start;
        justify-content: center;
        gap: clamp(12px, 2vw, 24px);
        width: min(96vw, 1800px);
        height: min(75vh, calc(100vh - 160px));
        min-height: 240px;
        max-height: 75vh;
        padding: 0 clamp(8px, 2vw, 24px);
        box-sizing: border-box;
        pointer-events: auto;
      }
      #hindsite-overlay-root.hs-results-focus .hs-overlay-results {
        display: flex;
        height: auto;
        min-height: 0;
        max-height: none;
        align-items: flex-start;
      }
      #hindsite-overlay-root .hs-result-card {
        flex: 1 1 0;
        min-width: 0;
        max-width: calc(33.333% - 12px);
        display: flex;
        flex-direction: column;
        background: rgba(255,255,255,0.06);
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.1);
        overflow: hidden;
        cursor: pointer;
        transition: background 0.2s, box-shadow 0.2s, transform 0.2s;
        box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      }
      #hindsite-overlay-root .hs-result-card:hover {
        background: rgba(255,255,255,0.1);
        box-shadow: 0 16px 48px rgba(0,0,0,0.45);
        transform: translateY(-2px);
      }
      #hindsite-overlay-root .hs-result-thumb {
        flex: 0 0 auto;
        width: 100%;
        line-height: 0;
        background: rgba(0,0,0,0.28);
      }
      #hindsite-overlay-root .hs-result-thumb img {
        width: 100%;
        height: auto;
        display: block;
      }
      #hindsite-overlay-root .hs-result-thumb-empty {
        min-height: 100px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #64748b;
        font-size: 12px;
        line-height: normal;
      }
      #hindsite-overlay-root .hs-result-body {
        flex: 0 0 auto;
        padding: 6px 10px 8px;
        overflow: hidden;
      }
      #hindsite-overlay-root .hs-result-head {
        color: #e2e8f0;
        font-weight: 600;
        font-size: 13px;
        line-height: 1.2;
        margin-bottom: 2px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      }
      #hindsite-overlay-root .hs-result-url-preview {
        color: #94a3b8;
        font-size: 11px;
        line-height: 1.3;
        word-break: break-all;
        margin-bottom: 0;
      }
      #hindsite-overlay-root .hs-search-loading-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        padding: 40px 24px;
        width: 100%;
        box-sizing: border-box;
        color: #94a3b8;
        font-size: 14px;
        letter-spacing: 0.02em;
      }
      #hindsite-overlay-root .hs-search-loading-spinner {
        width: 36px;
        height: 36px;
        border: 3px solid rgba(148,163,184,0.22);
        border-top-color: #94a3b8;
        border-radius: 50%;
        animation: hsSearchSpin 0.7s linear infinite;
      }
      @keyframes hsSearchSpin {
        to { transform: rotate(360deg); }
      }
      #hindsite-overlay-root .hs-panel {
        position: relative;
        z-index: 2;
        flex-shrink: 0;
        align-self: center;
        margin-bottom: 32px;
        opacity: 0;
        transform: translateY(18px) scale(0.985);
        transition: transform 180ms cubic-bezier(.2,.9,.2,1.15), opacity 180ms ease-out;
        will-change: transform, opacity;
      }
      #hindsite-overlay-root.hs-visible .hs-panel {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      @keyframes hsMicPulse {
        0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.22); }
        70% { box-shadow: 0 0 0 10px rgba(255,255,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
      }
      #hindsite-overlay-root .hs-mic.listening {
        border-color: rgba(255,255,255,0.6) !important;
        animation: hsMicPulse 1.1s ease-in-out infinite;
      }
      #hindsite-overlay-root .hs-mic,
      #hindsite-overlay-root .hs-send-chip {
        transition: transform 0.18s ease-out;
      }
      #hindsite-overlay-root .hs-mic:hover,
      #hindsite-overlay-root .hs-send-chip:hover {
        transform: scale(1.15);
      }
      #hindsite-overlay-root .hs-mic:active,
      #hindsite-overlay-root .hs-send-chip:active {
        transform: scale(0.92);
      }
      #hindsite-overlay-root .hs-send-chip.hs-press {
        transform: scale(0.88);
      }
    `;
    document.documentElement.appendChild(style);
  }

  const panel = document.createElement('div');
  panel.className = 'hs-panel';
  panel.style.cssText = `
    pointer-events: auto;
    min-width: 420px;
    max-width: 560px;
    width: 46vw;
    box-sizing: border-box;
    padding: 12px 14px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(26,50,82,0.96) 0%, rgba(38,62,94,0.94) 50%, rgba(44,56,74,0.92) 100%);
    box-shadow: 0 20px 48px rgba(26,50,82,0.45), 0 0 0 1px rgba(148,163,184,0.35);
    border: 1px solid rgba(148,163,184,0.5);
    backdrop-filter: blur(22px);
    display: flex;
    align-items: center;
    gap: 10px;
    color: #e2e8f0;
    font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
  `;
  hsOverlayPanel = panel;

  const hint = document.createElement('div');
  hint.textContent = 'HindSite quick search';
  hint.style.cssText = `
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #94a3b8;
    margin-right: 4px;
    flex: 0 0 auto;
    white-space: nowrap;
  `;

  const input = document.createElement('textarea');
  input.placeholder = 'Type to search...';
  input.rows = 1;
  input.style.cssText = `
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    color: #f1f5f9;
    font-size: 14px;
    font-weight: 400;
    padding: 3px 0;
    resize: none;
    overflow: hidden;
    min-height: 20px;
    max-height: 120px;
    line-height: 1.35;
  `;

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.title = 'Voice input (Alt+V)';
  micBtn.className = 'hs-mic';
  micBtn.style.cssText = `
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.5);
    background: rgba(26,50,82,0.9);
    color: #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
  `;
  micBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3a2.5 2.5 0 0 1 2.5 2.5v5A2.5 2.5 0 0 1 12 13a2.5 2.5 0 0 1-2.5-2.5v-5A2.5 2.5 0 0 1 12 3Zm0 14a5 5 0 0 0 5-5 .75.75 0 0 1 1.5 0A6.5 6.5 0 0 1 12.75 18.47V21h-1.5v-2.53A6.5 6.5 0 0 1 5.5 12a.75.75 0 0 1 1.5 0 5 5 0 0 0 5 5Z" fill="currentColor"/></svg>';

  const sendChip = document.createElement('div');
  sendChip.className = 'hs-send-chip';
  sendChip.textContent = '➤';
  sendChip.title = 'Send';
  sendChip.style.cssText = `
    flex: 0 0 auto;
    font-size: 12px;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.6);
    background: rgba(26,50,82,0.9);
    color: #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    user-select: none;
  `;

  panel.appendChild(hint);
  panel.appendChild(input);
  panel.appendChild(micBtn);
  panel.appendChild(sendChip);

  const backdrop = document.createElement('div');
  backdrop.className = 'hs-backdrop';

  const main = document.createElement('div');
  main.className = 'hs-main';

  hsOverlayRoot.appendChild(backdrop);
  hsOverlayRoot.appendChild(main);
  hsOverlayRoot.appendChild(panel);
  document.documentElement.appendChild(hsOverlayRoot);

  if (!hsOverlayAltVKeyBound) {
    hsOverlayAltVKeyBound = true;
    document.addEventListener(
      'keydown',
      (e) => {
        if (!hsOverlayVisible) return;
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.code !== 'KeyV') return;
        e.preventDefault();
        toggleOverlaySpeech();
      },
      true
    );
  }

  hsOverlayInput = input;
  hsOverlayMicBtn = micBtn;

  // ESC closes overlay
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideOverlay();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      performOverlaySearch(input.value);
    }
  });

  input.addEventListener('input', () => {
    autoResizeOverlayInput();
  });

  micBtn.addEventListener('click', () => {
    toggleOverlaySpeech();
  });

  sendChip.addEventListener('click', () => {
    performOverlaySearch(hsOverlayInput ? hsOverlayInput.value : '');
  });

  // Enter always sends (even when focus is on mic or send chip)
  hsOverlayRoot.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || !hsOverlayVisible) return;
    if (e.target === input) return; // input has its own handler
    e.preventDefault();
    performOverlaySearch(hsOverlayInput ? hsOverlayInput.value : '');
  });
}

function showOverlay() {
  createOverlayIfNeeded();
  if (!hsOverlayRoot) return;

  hsOverlayRoot.style.display = 'flex';
  hsOverlayRoot.classList.remove('hs-results-focus');
  hsOverlayVisible = true;
  if (hsOverlayHideTimer) {
    clearTimeout(hsOverlayHideTimer);
    hsOverlayHideTimer = null;
  }

  // Trigger pop-in animation
  requestAnimationFrame(() => {
    hsOverlayRoot && hsOverlayRoot.classList.add('hs-visible');
  });

  // Focus input with minimal delay to avoid layout races
  setTimeout(() => {
    hsOverlayInput && hsOverlayInput.focus();
    autoResizeOverlayInput();
  }, 0);
}

function hideOverlay() {
  if (!hsOverlayRoot) return;
  hsOverlayRoot.classList.remove('hs-visible', 'hs-results-focus');
  hsOverlayVisible = false;
  stopOverlaySpeech();
  if (hsOverlayInput) hsOverlayInput.value = '';
  const resultsEl = hsOverlayRoot.querySelector('.hs-overlay-results');
  if (resultsEl) {
    resultsEl.innerHTML = '';
  }

  // Let the exit transition finish, then hide
  hsOverlayHideTimer = setTimeout(() => {
    if (hsOverlayRoot) hsOverlayRoot.style.display = 'none';
  }, 190);
}

function ensureOverlayResultsContainer() {
  if (!hsOverlayRoot) return null;
  const main = hsOverlayRoot.querySelector('.hs-main');
  if (!main) return null;
  let container = main.querySelector('.hs-overlay-results');
  if (!container) {
    container = document.createElement('div');
    container.className = 'hs-overlay-results';
    main.appendChild(container);
  }
  return container;
}

function performOverlaySearch(query) {
  const q = (query || (hsOverlayInput && hsOverlayInput.value) || '').trim();
  if (!q) return;

  // In-out press animation on send button (from Enter or click)
  const sendChip = hsOverlayRoot && hsOverlayRoot.querySelector('.hs-send-chip');
  if (sendChip) {
    sendChip.classList.add('hs-press');
    setTimeout(() => sendChip.classList.remove('hs-press'), 180);
  }

  if (!extensionContextValid()) {
    const resultsEl = ensureOverlayResultsContainer();
    if (resultsEl && hsOverlayRoot) {
      resultsEl.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:24px;width:100%;">Extension was reloaded — refresh this page (F5)</div>';
      hsOverlayRoot.classList.add('hs-results-focus');
    }
    return;
  }

  const loadingEl = ensureOverlayResultsContainer();
  if (loadingEl && hsOverlayRoot) {
    loadingEl.innerHTML =
      '<div class="hs-search-loading-wrap" role="status" aria-live="polite"><div class="hs-search-loading-spinner" aria-hidden="true"></div><span>Searching…</span></div>';
    hsOverlayRoot.classList.add('hs-results-focus');
  }

  safeSendMessage({ type: 'SEARCH', query: q }, (response) => {
    if (chrome.runtime.lastError) {
      const resultsEl = ensureOverlayResultsContainer();
      if (resultsEl && hsOverlayRoot) {
        resultsEl.innerHTML =
          '<div style="color:#f87171;text-align:center;padding:24px;width:100%;">Search failed</div>';
        hsOverlayRoot.classList.add('hs-results-focus');
      }
      return;
    }
    if (response && response.action === 'tab_switch') {
      hideOverlay();
      return;
    }
    if (response && response.action === 'semantic_search' && response.results && response.results.length) {
      showOverlayResults(response.results);
      return;
    }
    const resultsEl = ensureOverlayResultsContainer();
    if (resultsEl && hsOverlayRoot) {
      resultsEl.innerHTML =
        '<div style="color:#94a3b8;text-align:center;padding:24px;width:100%;">No matching pages found</div>';
      hsOverlayRoot.classList.add('hs-results-focus');
    }
  });
}

function hsEscapeHtmlAttr(value) {
  if (value == null || value === '') return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hsEscapeHtmlText(value) {
  if (value == null || value === '') return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hsTruncateUrlHtml(url, maxLen) {
  if (url == null || url === '') return '';
  const s = String(url).trim();
  if (s.length <= maxLen) return hsEscapeHtmlText(s);
  return hsEscapeHtmlText(s.slice(0, maxLen - 3)) + '...';
}

function showOverlayResults(results) {
  const container = ensureOverlayResultsContainer();
  if (!container || !hsOverlayRoot) return;

  if (!results.length) {
    container.innerHTML =
      '<div style="color:#94a3b8;text-align:center;padding:24px;width:100%;">No matching pages found</div>';
    hsOverlayRoot.classList.add('hs-results-focus');
    return;
  }

  hsOverlayRoot.classList.add('hs-results-focus');
  container.innerHTML = results
    .map((r) => {
      const rawUrl = r.url || '';
      const domainRaw = r.domain || rawUrl.replace(/^https?:\/\//, '').split('/')[0] || '';
      const thumbB64 = r.thumbnail_base64 || '';
      const imgBlock = thumbB64
        ? `<img src="data:image/jpeg;base64,${thumbB64.replace(/"/g, '&quot;')}" alt="" />`
        : '<div class="hs-result-thumb-empty">No preview</div>';
      return `<div class="hs-result-card" data-url="${hsEscapeHtmlAttr(rawUrl)}" title="${hsEscapeHtmlAttr(rawUrl)}">
        <div class="hs-result-thumb">${imgBlock}</div>
        <div class="hs-result-body">
          <div class="hs-result-head">${hsEscapeHtmlText(domainRaw || 'URL')}</div>
          <div class="hs-result-url-preview">${hsTruncateUrlHtml(rawUrl, 72)}</div>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.hs-result-card').forEach((el) => {
    el.addEventListener('click', () => {
      const url = el.getAttribute('data-url');
      if (url) safeSendMessage({ type: 'OPEN_URL', url });
      hideOverlay();
    });
  });
}

function toggleOverlay() {
  if (hsOverlayVisible) {
    hideOverlay();
  } else {
    showOverlay();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'TOGGLE_OVERLAY') {
    toggleOverlay();
  }
});

// ============================================
// SPEECH RECOGNITION (OVERLAY)
// ============================================

function ensureSpeechSupport() {
  if (hsSpeechSupported !== null) return hsSpeechSupported;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  hsSpeechSupported = !!SpeechRecognition;
  if (hsSpeechSupported && !hsRecognition) {
    const SR = SpeechRecognition;
    hsRecognition = new SR();
    hsRecognition.lang = navigator.language || 'en-US';
    hsRecognition.continuous = false;
    hsRecognition.interimResults = true;

    hsRecognition.onstart = () => {
      hsRecognizing = true;
      if (hsOverlayMicBtn) hsOverlayMicBtn.classList.add('listening');
      if (hsOverlayInput) {
        hsSpeechBaseText = hsOverlayInput.value || '';
      }
    };

    hsRecognition.onresult = (event) => {
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
      if (hsOverlayInput) {
        const base = hsSpeechBaseText ? hsSpeechBaseText + ' ' : '';
        const combined = (base + finalText + ' ' + interimText).trim();
        hsOverlayInput.value = combined;
        autoResizeOverlayInput();
      }
    };

    hsRecognition.onerror = () => {
      hsRecognizing = false;
      if (hsOverlayMicBtn) hsOverlayMicBtn.classList.remove('listening');
    };

    hsRecognition.onend = () => {
      hsRecognizing = false;
      if (hsOverlayMicBtn) hsOverlayMicBtn.classList.remove('listening');
    };
  }
  return hsSpeechSupported;
}

function startOverlaySpeech() {
  if (!ensureSpeechSupport()) return;
  if (!hsRecognition || hsRecognizing) return;
  try {
    hsRecognition.start();
  } catch (e) {
    // ignore repeated start errors
  }
}

function stopOverlaySpeech() {
  if (hsRecognition && hsRecognizing) {
    try {
      hsRecognition.stop();
    } catch (e) {
      // ignore
    }
  }
}

function toggleOverlaySpeech() {
  if (hsRecognizing) {
    stopOverlaySpeech();
  } else {
    startOverlaySpeech();
  }
}

function autoResizeOverlayInput() {
  if (!hsOverlayInput) return;
  hsOverlayInput.style.height = 'auto';
  const maxHeight = 120;
  const nextHeight = Math.min(hsOverlayInput.scrollHeight, maxHeight);
  hsOverlayInput.style.height = `${nextHeight}px`;
  hsOverlayInput.style.overflowY = hsOverlayInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
}