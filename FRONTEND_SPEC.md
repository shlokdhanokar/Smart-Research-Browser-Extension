# HindSite Extension – Frontend Specification (for Backend Integration)

This document describes the **entire frontend structure** of the HindSite Chrome extension so a backend can be designed and APIs can be aligned. It covers the file tree, each file’s role, and every important function with names and behavior.

---

## 1. Project tree

```
Frontend-AI-Extension/
├── .gitattributes
├── LICENSE
├── README.md
├── manifest.json                 # Chrome extension manifest (MV3)
├── FRONTEND_SPEC.md              # This file
└── src/
    ├── assets/
    │   └── icons/
    │       ├── ext-icon-16.png
    │       ├── ext-icon-32.png
    │       ├── ext-icon-48.png
    │       ├── ext-icon-128.png
    │       ├── action-icon-16.png
    │       ├── action-icon-32.png
    │       ├── action-icon-48.png
    │       └── action-icon-128.png
    ├── background/
    │   └── index.js               # Service worker: commands, open quick-search window
    ├── content/
    │   └── index.js               # Injected into web pages: tracking, overlay, speech
    ├── popup/
    │   ├── index.html             # Popup UI (saved pages list, stats, quick search button)
    │   └── index.js               # Popup logic: load/display/delete pages, open URLs, quick search
    └── quicksearch/
        ├── index.html             # Quick-search bar UI (standalone window)
        └── index.js               # Quick-search logic: input, speech, resize
```

---

## 2. Manifest (`manifest.json`)

- **manifest_version**: 3  
- **name**: HindSite  
- **version**: 1.0.0  
- **description**: Automatically saves important webpages based on time and scroll behavior  
- **permissions**: `["storage", "tabs"]`  
  - `storage`: read/write `chrome.storage.local` (saved pages).  
  - `tabs`: query/update/create tabs and get current tab for quick search and opening saved URLs.  
- **background**: service worker at `src/background/index.js`.  
- **commands**:  
  - `toggle_overlay`: suggested key **Alt+C**; toggles the in-page quick-search overlay or opens the quick-search window on restricted pages.  
- **content_scripts**: one entry; `js: ["src/content/index.js"]`, `matches: ["<all_urls>"]`, `run_at: "document_idle"`.  
- **action**:  
  - `default_popup`: `src/popup/index.html`  
  - `default_title`: "View Saved Pages"  
  - Icons: action icons 16/32/48 (and optionally 128).  
- **icons**: extension icons 16/32/48/128 from `src/assets/icons/ext-icon-*.png`.

There is **no** `web_accessible_resources` in the current manifest; the quick-search bar on normal pages is built in the content script, not loaded as an iframe.

---

## 3. Background script (`src/background/index.js`)

Runs as the extension’s service worker. No storage or tab logic here; only command handling and opening the quick-search window.

### 3.1 Functions

- **`openQuickSearchWindow()`**  
  - Opens a small **popup window** (not a tab) that loads `src/quicksearch/index.html`.  
  - Window size: 560×160.  
  - Uses `chrome.windows.getCurrent` to center the window near the bottom of the current window (top = current top + height - 160 - 40).  
  - Uses `chrome.windows.create` with `type: 'popup'`, `url: chrome.runtime.getURL('src/quicksearch/index.html')`.  
  - **When it’s used**: When the user triggers quick search (Alt+C or popup button) on a **restricted** URL (e.g. `chrome://`, new tab, Web Store); content script cannot run there, so the UI is shown in this window instead.

- **`chrome.commands.onCommand.addListener`**  
  - Listens for the command **`toggle_overlay`** (Alt+C).  
  - Calls `chrome.tabs.query({ active: true, currentWindow: true })` to get the active tab.  
  - If no tab: calls **`openQuickSearchWindow()`**.  
  - If tab exists, checks if URL is **restricted**:  
    - `chrome://`, `chrome-extension://`, `devtools://`, `view-source:`, `edge://`, `about:`, or URL containing `chrome.google.com/webstore`.  
  - If restricted → **`openQuickSearchWindow()`**.  
  - Otherwise → **`chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' })`** so the content script toggles the in-page overlay.

**Backend note:** Background does not touch storage or your backend. For a backend, you might add a listener here (e.g. `chrome.runtime.onMessage`) to handle messages from popup/content and call your API.

---

## 4. Content script (`src/content/index.js`)

Injected into every page matching `<all_urls>`. It (1) tracks engagement and saves pages to `chrome.storage.local`, and (2) shows the in-page quick-search overlay and handles its speech.

### 4.1 State (module-level)

- **Engagement:**  
  - `activeTime` – seconds the page has been in foreground.  
  - `timerRunning`, `timerInterval` – for the 1s ticker.  
  - `maxScrollPercent` – max scroll percentage reached (0–100).  
  - `scrollHistory` – array of `{ percent, timestamp }` for scroll events.  
  - `lastScrollTime` – not currently used for logic.  
  - `isShortPage` – true if page height is such that scrollable area &lt; 100px.  
  - `hasExtracted` – true after **`extractContent()`** has run (prevents double save).  
  - `checkInterval` – interval ID for **`checkThresholds()`**.  

- **Overlay:**  
  - `hsOverlayRoot`, `hsOverlayPanel`, `hsOverlayInput`, `hsOverlayMicBtn` – DOM nodes.  
  - `hsOverlayVisible` – boolean.  
  - `hsOverlayHideTimer` – timeout ID for hiding after transition.  

- **Speech:**  
  - `hsRecognition` – `SpeechRecognition` instance.  
  - `hsRecognizing`, `hsSpeechBaseText`, `hsSpeechSupported`.

### 4.2 Page analysis

- **`analyzePageHeight()`**  
  - Sets **`isShortPage`** from `document.documentElement.scrollHeight` and `window.innerHeight`.  
  - If scrollable height &lt; 100px → short page (time-only rule); else normal (time + scroll).  
  - Bound to `window.addEventListener('load', ...)`.

### 4.3 Active time

- **`startTimer()`** – starts 1s interval, increments **`activeTime`**, sets **`timerRunning`** true.  
- **`pauseTimer()`** – sets **`timerRunning`** false.  
- **`resumeTimer()`** – sets **`timerRunning`** true.  
- **`document.addEventListener('visibilitychange', ...)`** – on hide: **`pauseTimer()`**; on show: **`resumeTimer()`**.  
- **`startTimer()`** is called once at script load.

### 4.4 Scroll tracking

- **`calculateScrollPercent()`**  
  - Returns 0–100 (integer) from `window.scrollY`, `scrollHeight`, `innerHeight`.  

- **`updateScrollTracking()`**  
  - Gets current scroll %; if &gt; **`maxScrollPercent`**, updates **`maxScrollPercent`** and pushes **`{ percent, timestamp }`** onto **`scrollHistory`**.  
  - Listened on `scroll` and `load`.

### 4.5 Thresholds and extraction

- **`wasScrollGradual()`**  
  - Returns false if **`maxScrollPercent`** &lt; 40.  
  - Finds first **`scrollHistory`** entry where percent ≥ 40; computes time from first history entry to that point.  
  - If that time &lt; 10 seconds → false (scroll too fast). Otherwise true.  

- **`checkThresholds()`**  
  - No-op if **`hasExtracted`** is true.  
  - **Short page:** if **`activeTime`** ≥ 60 → **`extractContent()`**.  
  - **Normal page:** if **`activeTime`** ≥ 60 and **`maxScrollPercent`** ≥ 40 and **`wasScrollGradual()`** → **`extractContent()`**.  
  - Runs every 5s via **`setInterval(checkThresholds, 5000)`**.

- **`extractContent()`**  
  - Sets **`hasExtracted`** true, clears timer and check intervals, pauses timer.  
  - Reads **`document.body.innerText`**, computes **`wordCount`** (by splitting on whitespace).  
  - Builds **`pageData`**:
    - **`url`**: `window.location.href`
    - **`content`**: full page text
    - **`metadata`**:
      - **`timeSpent`**: **`activeTime`**
      - **`scrollPercent`**: **`maxScrollPercent`**
      - **`timestamp`**: `new Date().toISOString()`
      - **`wordCount`**: number
      - **`isShortPage`**: boolean  
  - Calls **`saveToStorage(pageData)`**.

### 4.6 Storage and notification

- **`saveToStorage(pageData)`**  
  - **`chrome.storage.local.get(['savedPages'], callback)`**.  
  - If a page with same **`pageData.url`** already exists in **`savedPages`**, returns (no duplicate).  
  - Otherwise appends **`pageData`** to **`savedPages`**, then **`chrome.storage.local.set({ savedPages: savedPages }, () => { showNotification(); })`**.  

- **`showNotification()`**  
  - Injects a temporary green toast: “Page saved to HindSite” (top-right, 3s), then removes it.

**Backend note:** Today “save” = write to **`chrome.storage.local.savedPages`**. For a backend, you could replace or complement this in **`saveToStorage`** with an API call (e.g. POST page data). **`pageData`** shape is the natural request body.

### 4.7 Overlay (in-page quick-search bar)

- **`createOverlayIfNeeded()`**  
  - If **`hsOverlayRoot`** already exists, returns.  
  - Creates root div **`#hindsite-overlay-root`** (fixed, bottom center, bottom: 32px, z-index max).  
  - Injects a **`<style id="hindsite-overlay-style">`** for .hs-panel animation and .hs-mic.listening pulse.  
  - Builds **`.hs-panel`** (pill) with: hint “HindSite quick search”, **textarea** (placeholder “Type to search...”), **mic button**, **send chip** “➤”.  
  - Stores references in **`hsOverlayPanel`**, **`hsOverlayInput`**, **`hsOverlayMicBtn`**.  
  - Binds: Escape on input → **`hideOverlay()`**; input → **`autoResizeOverlayInput()`**; mic click → **`toggleOverlaySpeech()`**.  
  - Appends panel to root, root to **`document.documentElement`**.

- **`showOverlay()`**  
  - Calls **`createOverlayIfNeeded()`**, then shows root, sets **`hsOverlayVisible`** true, clears **`hsOverlayHideTimer`**, adds class for animation, focuses input and **`autoResizeOverlayInput()`**, then **`startOverlaySpeech()`**.

- **`hideOverlay()`**  
  - Removes visible class, sets **`hsOverlayVisible`** false, **`stopOverlaySpeech()`**, then after 190ms sets root **display: none**.

- **`toggleOverlay()`**  
  - If **`hsOverlayVisible`** → **`hideOverlay()`**; else **`showOverlay()`**.

- **`chrome.runtime.onMessage.addListener`**  
  - If **`message.type === 'TOGGLE_OVERLAY'`** → **`toggleOverlay()`**.

**Backend note:** Overlay only holds **text** (and speech result) in **`hsOverlayInput.value`**. There is **no** “submit” or “search” API call yet. A backend could add a “search” or “query” endpoint; the frontend would call it from a send action (e.g. when user clicks ➤ or presses Enter) and pass the current query string.

### 4.8 Speech (overlay)

- **`ensureSpeechSupport()`**  
  - Returns cached **`hsSpeechSupported`** (boolean).  
  - If not yet set: detects **`SpeechRecognition`** / **`webkitSpeechRecognition`**, creates **`hsRecognition`**, sets lang, continuous false, interimResults true, and **onstart** / **onresult** / **onerror** / **onend** to update **`hsRecognizing`**, **`hsOverlayMicBtn.listening`**, and **`hsOverlayInput.value`** (prepending **`hsSpeechBaseText`** to final+interim transcript).  
  - **onresult** also calls **`autoResizeOverlayInput()`**.

- **`startOverlaySpeech()`** – if support and not already recognizing, **`hsRecognition.start()`**.  
- **`stopOverlaySpeech()`** – if recognizing, **`hsRecognition.stop()`**.  
- **`toggleOverlaySpeech()`** – if recognizing then stop, else start.  

- **`autoResizeOverlayInput()`**  
  - Sets **`hsOverlayInput`** height from **scrollHeight** capped at 120px, and **overflowY** to **auto** if over 120.

**Backend note:** Speech is client-side only; no backend calls. If you add “search by voice”, the same query string (from **`hsOverlayInput.value`**) would be sent to your API.

---

## 5. Popup (`src/popup/`)

### 5.1 `src/popup/index.html`

- **Structure:**  
  - **Header**: “HindSite”, “Your automatically saved pages” (gradient background).  
  - **Stats bar**: **`#totalPages`** (number), **`#quickSearchBtn`** (magnifying glass), **`#avgTime`** (e.g. “0s”).  
  - **`#pagesList`** – container for saved page cards.  
  - **`#clearBtn`** – “Clear All”.  

- **Page card (created in JS):**  
  - **`.page-header`**: **`.page-url`** (domain from URL), **`.delete-btn`** (trash icon).  
  - **`.page-preview`** – first 150 chars of **`page.content`** + “…”.  
  - **`.page-meta`**: timeSpent, scrollPercent, wordCount, formatted date.  
  - Click on card (except delete) → open that page URL; delete → **`deleteSavedPage(page.url)`**.

- **IDs:**  
  - **`totalPages`**, **`avgTime`**, **`quickSearchBtn`**, **`pagesList`**, **`clearBtn`**.

### 5.2 `src/popup/index.js`

All logic runs in **popup context** (extension origin). Uses **`chrome.storage.local`** and **`chrome.tabs`** only; no content-script messaging except **`TOGGLE_OVERLAY`**.

#### State

- **`currentPages`** – in-memory array of saved page objects (same shape as **`savedPages`** in storage).

#### Load and display

- **`loadSavedPages()`**  
  - **`chrome.storage.local.get(['savedPages'], callback)`**.  
  - **`result.savedPages`** → **`currentPages`**.  
  - If empty → **`showEmptyState()`**; else **`displayPages(savedPages)`** and **`updateStatistics(savedPages)`**.  
  - Called on **DOMContentLoaded**.

- **`displayPages(pages)`**  
  - Clears **`#pagesList`**.  
  - **`sortedPages = [...pages].reverse()`** (newest first).  
  - For each **page** and index, **`createPageCard(page, originalIndex)`** and appends to **`#pagesList`**.

- **`createPageCard(page, originalIndex)`**  
  - **page** shape: **`{ url, content, metadata }`** with **metadata**: **`timeSpent`**, **`scrollPercent`**, **`timestamp`**, **`wordCount`**, **`isShortPage`**.  
  - Builds card DOM; **`.page-url`** shows **`extractDomain(page.url)`**; preview from **`page.content`**; meta from **`page.metadata`**.  
  - Delete button → **`deleteSavedPage(page.url)`** (with confirm).  
  - Card click → **`openPageUrl(page.url)`**.  
  - Returns the card element.

#### Statistics

- **`updateStatistics(pages)`**  
  - **`#totalPages`** = **`pages.length`**.  
  - **`#avgTime`** = round(**totalTime** / max(pages.length, 1)) + `'s'` where **totalTime** = sum of **`page.metadata.timeSpent`**.

#### Empty and clear

- **`showEmptyState()`**  
  - Sets **`#pagesList`** to empty-state HTML (“No pages saved yet”, short explanation).  
  - Sets **`#totalPages`** and **`#avgTime`** to `'0'` and `'0s'`.

- **`clearAllPages()`**  
  - **`confirm(...)`**; if ok: **`chrome.storage.local.set({ savedPages: [] }, () => { currentPages = []; showEmptyState(); })`**.

#### Delete single page

- **`deleteSavedPage(url)`**  
  - **`confirm(...)`**; if not confirmed, return.  
  - **`nextPages = currentPages.filter(p => p.url !== url)`**.  
  - **`chrome.storage.local.set({ savedPages: nextPages }, callback)`**; **`currentPages = nextPages`**; then either **`showEmptyState()`** or **`displayPages(currentPages)`** and **`updateStatistics(currentPages)`**.

**Backend note:** “Delete” and “clear all” only update **`chrome.storage.local.savedPages`**. Backend could expose **DELETE /pages/{id}** or **DELETE /pages** and the frontend could call them and then sync **savedPages** (or refetch list from API).

#### Open URL

- **`openPageUrl(url)`**  
  - **`targetUrl = normalizeUrl(url)`**, **`baseUrl = getBaseUrlWithoutFragment(url)`**.  
  - **`chrome.tabs.query({ url: baseUrl }, callback)`**.  
  - In callback: if any tab’s **`normalizeUrl(tab.url) === targetUrl`**, **`chrome.tabs.update(exactMatch.id, { active: true })`** and **`chrome.windows.update(exactMatch.windowId, { focused: true })`**.  
  - Else **`chrome.tabs.create({ url })`**.

- **`normalizeUrl(url)`** – returns **`new URL(url).href`** (full URL including hash).  
- **`getBaseUrlWithoutFragment(url)`** – returns URL without **#** part (for **tabs.query**).

#### Quick search from popup

- **`openQuickSearchOverlay()`**  
  - **`chrome.tabs.query({ active: true, currentWindow: true }, callback)`**.  
  - If no tab → **`openQuickSearchWindow()`**.  
  - Else same **isRestricted** check as in background (chrome://, edge://, about:, webstore, etc.).  
  - If restricted → **`openQuickSearchWindow()`**; else **`chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' })`**.

- **`openQuickSearchWindow()`**  
  - Same behavior as **background’s `openQuickSearchWindow()`**: **chrome.windows.create** with quicksearch HTML, 560×160, centered near bottom.

#### Utilities

- **`extractDomain(url)`** – **`new URL(url).hostname`**.  
- **`formatDate(date)`** – “Today” / “Yesterday” / “X days ago” / **`date.toLocaleDateString()`**.

**Backend note:** Popup is the main consumer of “saved pages”. If the list comes from an API, you’d replace **`loadSavedPages`** with a fetch, and **displayPages** / **updateStatistics** would use that response. **createPageCard** and **deleteSavedPage** / **clearAllPages** would need to call your DELETE endpoints and then refresh the list.

---

## 6. Quick-search window (`src/quicksearch/`)

Used in two ways: (1) **Standalone window** (opened by background/popup on restricted pages), (2) **Not currently used as iframe** in this codebase (overlay is built in content script). So quicksearch is primarily the “window” UI.

### 6.1 `src/quicksearch/index.html`

- **Layout:**  
  - One **`.shell`** (pill): **`.hint`** (“HindSite quick search”), **`#quickSearchInput`** (textarea, placeholder “Type to search...”), **`#quickSearchMicBtn`** (mic icon), **`.send-chip`** (➤).  
  - **body.standalone** (when not in iframe): pill at bottom center, **padding-bottom: 32px**.  
  - Styling: dark gradient background and shell; input auto-resizes up to 120px in JS.

- **Element IDs:**  
  - **`quickSearchInput`**, **`quickSearchMicBtn`**.

### 6.2 `src/quicksearch/index.js`

Runs in the quicksearch page (extension origin). No storage; only UI and speech.

#### State

- **`qsRecognition`** – **SpeechRecognition** instance.  
- **`qsRecognizing`**, **`qsSpeechBaseText`**, **`qsSpeechSupported`**.

#### Init

- **IIFE:** if **`window.self === window.top`**, **`document.body.classList.add('standalone')`** (so pill is at bottom in window mode).  
- **DOMContentLoaded:**  
  - **`input`** = **`#quickSearchInput`**, **`micBtn`** = **`#quickSearchMicBtn`**, **`shell`** = **`.shell`**.  
  - Adds **`is-open`** to shell for animation.  
  - **input**: focus, **`autoResizeQuickInput()`**, keydown Escape → **`window.close()`**, input → **`autoResizeQuickInput()`**.  
  - **micBtn** click → **`toggleQuickSearchSpeech()`**.  
  - **`startQuickSearchSpeech()`** on open.

#### Speech

- **`ensureQuickSearchSpeechSupport()`**  
  - Same pattern as content script: create **SpeechRecognition**, **onstart** / **onresult** / **onerror** / **onend**; **onresult** updates **`#quickSearchInput`** value (base + final + interim) and **`autoResizeQuickInput()`**.

- **`startQuickSearchSpeech()`**, **`stopQuickSearchSpeech()`**, **`toggleQuickSearchSpeech()`** – same idea as overlay speech.

- **`autoResizeQuickInput()`**  
  - **`#quickSearchInput`** height from **scrollHeight** capped at 120px; **overflowY** auto if over 120.

**Backend note:** Quick-search bar currently only collects **text** (and voice) in **`#quickSearchInput`**. There is **no** submit/send API. A backend “search” or “query” endpoint would be called with **`input.value`** when the user submits (e.g. Enter or ➤); you’d add that handler in this file (and optionally in content script overlay) and keep the same query payload shape.

---

## 7. Data shapes (for API design)

### 7.1 Saved page (current storage)

- **`chrome.storage.local.savedPages`**: array of **page** objects.  
- **Page object** (as produced by **content script** and consumed by **popup**):

```json
{
  "url": "https://example.com/path",
  "content": "Full plain text of document.body.innerText",
  "metadata": {
    "timeSpent": 120,
    "scrollPercent": 85,
    "timestamp": "2025-01-26T12:00:00.000Z",
    "wordCount": 5000,
    "isShortPage": false
  }
}
```

- **Uniqueness:** by **`url`** (content script skips save if **`savedPages.some(page => page.url === pageData.url)`**).

### 7.2 Messages (extension internal)

- **Background → Content (tab):**  
  - **`{ type: 'TOGGLE_OVERLAY' }`** – toggles in-page quick-search overlay.  
- No other **chrome.runtime.sendMessage** / **chrome.tabs.sendMessage** used in the current frontend.

### 7.3 Quick-search query (future backend)

- The **query string** the user would send to a backend is:  
  - **Content overlay:** **`hsOverlayInput.value`** (in **content script**).  
  - **Quicksearch window:** **`document.getElementById('quickSearchInput').value`** (in **quicksearch/index.js**).  
- No “submit” or “search” handler exists yet; both UIs only collect text (and speech). A single **query** or **search** API (e.g. POST **`{ query: string }`**) can be used from both once you add the handlers.

---

## 8. Summary for backend

- **Save page:** Content script builds **`pageData`** and calls **`saveToStorage(pageData)`**, which today only writes to **`chrome.storage.local.savedPages`**. Backend can add an API (e.g. POST **/pages** or **/save**) with the same **pageData** shape and call it from **`saveToStorage`** (and optionally keep syncing to storage for offline).  
- **List / delete / clear:** Popup uses **`loadSavedPages`** (storage get), **`deleteSavedPage(url)`**, **`clearAllPages()`** (storage set). Backend can replace or mirror with GET **/pages**, DELETE **/pages/:id**, DELETE **/pages**, and refill **savedPages** or use API as source of truth.  
- **Quick search:** No API yet. Query string is in **content**: **`hsOverlayInput.value`**; **quicksearch**: **`#quickSearchInput`**. Adding a “submit” (Enter / ➤) that sends **{ query }** to a backend search/query endpoint will align with this frontend.  
- **Function names** you’ll see when wiring APIs:  
  - **Content:** **`saveToStorage`**, **`extractContent`**, **`showOverlay`** / **`hideOverlay`** / **`toggleOverlay`**.  
  - **Popup:** **`loadSavedPages`**, **`displayPages`**, **`createPageCard`**, **`updateStatistics`**, **`deleteSavedPage`**, **`clearAllPages`**, **`openPageUrl`**, **`openQuickSearchOverlay`**, **`openQuickSearchWindow`**.  
  - **Background:** **`openQuickSearchWindow`**, command listener for **`toggle_overlay`**.  
  - **Quicksearch:** **`autoResizeQuickInput`**, **`toggleQuickSearchSpeech`**, **`startQuickSearchSpeech`** (no storage or API calls yet).

This document reflects the frontend as of the last edit; use it to design APIs and wiring without changing the described structure and function names.
