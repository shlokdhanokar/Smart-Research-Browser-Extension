// ============================================
// HindSite - Popup Script
// Displays saved pages and handles user actions
// ============================================

// ============================================
// LOAD AND DISPLAY SAVED PAGES
// ============================================

let currentPages = [];

document.addEventListener('DOMContentLoaded', () => {
    loadSavedPages();
    
    // Attach event listeners to buttons
    document.getElementById('clearBtn').addEventListener('click', clearAllPages);
    const quickBtn = document.getElementById('quickSearchBtn');
    if (quickBtn) {
      quickBtn.addEventListener('click', openQuickSearchOverlay);
    }
  });
  
  function loadSavedPages() {
    chrome.storage.local.get(['savedPages'], (result) => {
      const savedPages = result.savedPages || [];
      currentPages = savedPages;
      
      if (savedPages.length === 0) {
        showEmptyState();
      } else {
        displayPages(savedPages);
        updateStatistics(savedPages);
      }
    });
  }
  
  // ============================================
  // DISPLAY PAGES
  // ============================================
  
  function displayPages(pages) {
    const pagesList = document.getElementById('pagesList');
    pagesList.innerHTML = ''; // Clear existing content
    
    // Show most recent first
    const sortedPages = [...pages].reverse();
    
    sortedPages.forEach((page, index) => {
      const pageCard = createPageCard(page, pages.length - 1 - index);
      pagesList.appendChild(pageCard);
    });
  }
  
  function createPageCard(page, originalIndex) {
    const card = document.createElement('div');
    card.className = 'page-item';
    
    // Extract domain from URL
    const domain = extractDomain(page.url);
    
    // Format timestamp
    const date = new Date(page.metadata.timestamp);
    const formattedDate = formatDate(date);
    
    // Create content preview (first 150 characters)
    const preview = page.content.substring(0, 150).trim() + '...';
    
    // Build card HTML
    card.innerHTML = `
      <div class="page-header">
        <div class="page-url" title="${page.url}">${domain}</div>
        <button class="icon-btn delete-btn" type="button" aria-label="Remove saved page" title="Remove">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 4h6a1 1 0 0 1 .96.73L16.8 7H19a.75.75 0 0 1 0 1.5h-1.02l-.7 11.02A2.25 2.25 0 0 1 15.04 22H8.96a2.25 2.25 0 0 1-2.24-2.48L7.02 8.5H6A.75.75 0 0 1 6 7h2.2l.84-2.27A1 1 0 0 1 9 4Zm1.75 5.75a.75.75 0 0 0-1.5.03l.25 8a.75.75 0 1 0 1.5-.05l-.25-7.98Zm4 0a.75.75 0 0 0-1.5.03l-.25 8a.75.75 0 1 0 1.5-.05l.25-7.98Z" stroke="currentColor" stroke-width="0.6" />
          </svg>
        </button>
      </div>
      <div class="page-preview">${preview}</div>
      <div class="page-meta">
        <div class="meta-item">⏱️ ${page.metadata.timeSpent}s</div>
        <div class="meta-item">📜 ${page.metadata.scrollPercent}%</div>
        <div class="meta-item">📝 ${page.metadata.wordCount.toLocaleString()} words</div>
        <div class="meta-item">📅 ${formattedDate}</div>
      </div>
    `;

    // Delete button should not trigger card click
    const deleteBtn = card.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSavedPage(page.url);
    });
    
    // Click to open URL (focus existing tab if already open)
    card.addEventListener('click', () => {
      openPageUrl(page.url);
    });
    
    return card;
  }
  
  // ============================================
  // UPDATE STATISTICS
  // ============================================
  
  function updateStatistics(pages) {
    // Total pages
    const totalPages = pages.length;
    document.getElementById('totalPages').textContent = totalPages;
    
    // Average time spent
    const totalTime = pages.reduce((sum, page) => sum + page.metadata.timeSpent, 0);
    const avgTime = Math.round(totalTime / Math.max(totalPages, 1));
    document.getElementById('avgTime').textContent = avgTime + 's';
  }
  
  // ============================================
  // EMPTY STATE
  // ============================================
  
  function showEmptyState() {
    const pagesList = document.getElementById('pagesList');
    pagesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-title">No pages saved yet</div>
        <div class="empty-state-text">
          Browse the web normally and pages will be saved automatically when you:<br>
          • Spend 60+ seconds on a page<br>
          • Scroll through 40%+ of the content<br>
          • Read gradually (not jumping around)
        </div>
      </div>
    `;
    
    // Update stats to 0
    document.getElementById('totalPages').textContent = '0';
    document.getElementById('avgTime').textContent = '0s';
  }
  
  // ============================================
  // CLEAR ALL FUNCTIONALITY
  // ============================================
  
  function clearAllPages() {
    const confirmed = confirm(
      'Are you sure you want to delete all saved pages?\n\nThis action cannot be undone!'
    );
    
    if (confirmed) {
      chrome.storage.local.set({ savedPages: [] }, () => {
        currentPages = [];
        console.log('🗑️ All pages cleared');
        showEmptyState();
      });
    }
  }

  // ============================================
  // DELETE SINGLE PAGE
  // ============================================

  function deleteSavedPage(url) {
    const confirmed = confirm(
      'Remove this saved page?\n\nThis will delete it from your HindSite list.'
    );

    if (!confirmed) {
      return;
    }

    const nextPages = currentPages.filter((p) => p.url !== url);

    chrome.storage.local.set({ savedPages: nextPages }, () => {
      currentPages = nextPages;

      if (currentPages.length === 0) {
        showEmptyState();
        return;
      }

      displayPages(currentPages);
      updateStatistics(currentPages);
    });
  }
  
  // ============================================
  // OPEN URL (focus existing tab if already open)
  // ============================================
  
  function openPageUrl(url) {
    // Normalize target URL for exact comparison
    const targetUrl = normalizeUrl(url);
    
    // Get base URL (without fragment) for efficient querying
    // Chrome's query ignores fragments, so this will return all tabs with same base URL
    const baseUrl = getBaseUrlWithoutFragment(url);
    
    // Query tabs matching the base URL (Chrome ignores fragments in query)
    chrome.tabs.query({ url: baseUrl }, (tabs) => {
      if (tabs && tabs.length > 0) {
        // Find exact URL match (including fragment) by comparing normalized URLs
        const exactMatch = tabs.find(tab => normalizeUrl(tab.url) === targetUrl);
        
        if (exactMatch) {
          // Focus the exact matching tab
          chrome.tabs.update(exactMatch.id, { active: true });
          chrome.windows.update(exactMatch.windowId, { focused: true });
          return;
        }
      }
      
      // No exact match found, create new tab
      chrome.tabs.create({ url });
    });
  }

  // ============================================
  // QUICK SEARCH OVERLAY TRIGGER (FROM POPUP)
  // ============================================

  function openQuickSearchOverlay() {
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
  }

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
  
  // Normalize URL for exact comparison (preserves fragments)
  function normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      // Return full href including fragment for exact matching
      return urlObj.href;
    } catch (e) {
      return url;
    }
  }
  
  // Get base URL without fragment for querying
  // Chrome's tabs.query ignores fragments, so this efficiently gets candidate tabs
  function getBaseUrlWithoutFragment(url) {
    try {
      const urlObj = new URL(url);
      // Return URL without fragment - Chrome will match tabs with this base regardless of fragment
      return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
    } catch (e) {
      // Fallback: try to remove fragment manually
      const hashIndex = url.indexOf('#');
      return hashIndex !== -1 ? url.substring(0, hashIndex) : url;
    }
  }
  
  // ============================================
  // UTILITY FUNCTIONS
  // ============================================
  
  function extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (e) {
      return url;
    }
  }
  
  function formatDate(date) {
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString();
    }
  }