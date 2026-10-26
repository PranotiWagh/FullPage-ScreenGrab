/**
 * Service Worker: background.js
 * Full-Page Web App Crawler & Screenshot Capture
 * Manifest V3 compliant with resilient storage-backed state machine.
 */

// Helper to format ISO timestamp for logs
function getTimestamp() {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

// Window Launcher: opens popup.html in a persistent, standalone window
async function openPopupWindow() {
  try {
    const url = chrome.runtime.getURL('popup.html?standalone=true');
    // Check if an existing window is already open with this URL
    const windows = await chrome.windows.getAll({ populate: true });
    for (const win of windows) {
      const match = win.tabs?.find(t => t.url && t.url.includes('popup.html'));
      if (match) {
        await chrome.windows.update(win.id, { focused: true });
        return;
      }
    }
    await chrome.windows.create({
      url,
      type: 'popup',
      width: 480,
      height: 680,
      focused: true
    });
  } catch (err) {
    console.error('Failed to open popup window:', err);
  }
}

// Context Menu setup & Auto-launch on install/reload
chrome.runtime.onInstalled.addListener(async () => {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'open_crawler_window',
        title: '📸 Open Web App Crawler & Screenshot Window',
        contexts: ['all']
      });
      chrome.contextMenus.create({
        id: 'toggle_crawler_widget',
        title: '📌 Toggle On-Page Widget (Ctrl+Shift+S)',
        contexts: ['all']
      });
    });
  } catch (e) {
    console.warn('Context menu error:', e);
  }

  // Automatically pop up the control window so the user sees it immediately upon loading/reloading
  await openPopupWindow();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open_crawler_window') {
    await openPopupWindow();
  } else if (info.menuItemId === 'toggle_crawler_widget' && tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_ONPAGE_WIDGET' });
    } catch (e) {
      // Fallback to popup window if page blocks content script
      await openPopupWindow();
    }
  }
});

// Keyboard command shortcut listener
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open_window') {
    await openPopupWindow();
  }
});

// Add log entry to state and persist
async function addLog(message, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${message}`);
  const { crawlState } = await chrome.storage.local.get('crawlState');
  if (!crawlState) return;

  if (!crawlState.logs) crawlState.logs = [];
  crawlState.logs.push({
    timestamp: getTimestamp(),
    level,
    message
  });

  // Keep last 150 log entries to prevent storage bloat
  if (crawlState.logs.length > 150) {
    crawlState.logs.shift();
  }

  await chrome.storage.local.set({ crawlState });
}

// Watchdog timeout handle
let watchdogTimeoutId = null;

function clearWatchdog() {
  if (watchdogTimeoutId) {
    clearTimeout(watchdogTimeoutId);
    watchdogTimeoutId = null;
  }
}

function startWatchdog(url, timeoutMs = 45000) {
  clearWatchdog();
  watchdogTimeoutId = setTimeout(async () => {
    console.warn(`Watchdog triggered: operation timed out for ${url}`);
    await addLog(`Timeout waiting for page to load or capture: ${url}`, 'warn');

    const { crawlState } = await chrome.storage.local.get('crawlState');
    if (!crawlState || (crawlState.status !== 'CRAWLING' && crawlState.status !== 'LOGGING_IN')) {
      return;
    }

    if (crawlState.status === 'LOGGING_IN') {
      crawlState.status = 'ERROR';
      crawlState.auth.status = 'failed';
      await addLog('Authentication failed due to timeout. Halting crawl.', 'error');
      await chrome.storage.local.set({ crawlState });
      return;
    }

    // Mark current URL as failed and advance to next
    if (crawlState.currentUrl) {
      crawlState.failed.push({
        url: crawlState.currentUrl,
        reason: 'Timeout (45s)'
      });
    }

    await chrome.storage.local.set({ crawlState });
    await processNextInQueue();
  }, timeoutMs);
}

/**
 * Canonical URL Normalizer (matching content.js)
 */
function normalizeUrl(rawUrl, baseOrigin) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
    return null;
  }

  try {
    const url = new URL(trimmed, baseOrigin || undefined);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');

    // Preserve SPA routing hashes (#/route, #!/route), strip plain scroll anchors
    if (url.hash) {
      if (/^#(\/|!|\?[a-zA-Z0-9_\-]+=|route=|path=)/.test(url.hash)) {
        // SPA hash route — preserve
      } else {
        url.hash = '';
      }
    }

    const trackingKeys = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'fbclid', 'gclid', '_ga', '_gl', 'mc_cid', 'mc_eid'
    ];
    for (const key of trackingKeys) {
      url.searchParams.delete(key);
    }

    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch (e) {
    return null;
  }
}

/**
 * Find or create a valid web browser tab to use for crawling.
 * Never targets extension popup or internal pages.
 */
async function resolveTargetTab(targetTabId, initialUrl) {
  // 1. Check if provided targetTabId is valid and not an extension page
  if (targetTabId) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (tab && tab.url && !tab.url.startsWith('chrome') && !tab.url.includes('popup.html')) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        return tab.id;
      }
    } catch (e) {}
  }

  // 2. Search for an active web page tab in normal browser windows
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    for (const win of windows) {
      const activeWebTab = win.tabs?.find(t => t.active && t.url && t.url.startsWith('http'));
      if (activeWebTab) {
        await chrome.windows.update(win.id, { focused: true }).catch(() => {});
        return activeWebTab.id;
      }
    }

    // Any open web tab
    for (const win of windows) {
      const anyWebTab = win.tabs?.find(t => t.url && t.url.startsWith('http'));
      if (anyWebTab) {
        await chrome.tabs.update(anyWebTab.id, { active: true });
        await chrome.windows.update(win.id, { focused: true }).catch(() => {});
        return anyWebTab.id;
      }
    }
  } catch (e) {}

  // 3. Fallback: Create a new dedicated tab
  const newTab = await chrome.tabs.create({ url: initialUrl || 'about:blank', active: true });
  return newTab.id;
}

/**
 * Initialize and start the crawl process
 */
async function startCrawl(config, sender) {
  clearWatchdog();

  // Normalize all input URLs
  const normalizedTargets = (config.targetUrls || [])
    .map(u => normalizeUrl(u))
    .filter(Boolean);

  if (normalizedTargets.length === 0) {
    throw new Error('No valid HTTP/HTTPS target URLs provided');
  }

  const firstTarget = normalizedTargets[0];
  let baseDomain = '';
  let baseOrigin = '';

  try {
    const parsed = new URL(firstTarget);
    baseDomain = parsed.hostname;
    baseOrigin = parsed.origin;
  } catch (e) {}

  // Determine tab to crawl in
  const senderTabId = (sender?.tab && !sender.tab.url.includes('popup.html')) ? sender.tab.id : null;
  const tabId = await resolveTargetTab(config.targetTabId || senderTabId, firstTarget);

  const newState = {
    status: config.auth?.required ? 'LOGGING_IN' : 'CRAWLING',
    tabId,
    baseDomain,
    baseOrigin,
    queue: [...normalizedTargets],
    visited: [],
    failed: [],
    autoDiscover: Boolean(config.autoDiscover),
    maxPages: parseInt(config.maxPages, 10) || 25,
    scrollDelay: parseInt(config.scrollDelay, 10) || 450,
    auth: {
      ...config.auth,
      attempted: false,
      status: config.auth?.required ? 'pending' : 'idle'
    },
    currentUrl: null,
    isCapturing: false,
    logs: []
  };

  await chrome.storage.local.set({ crawlState: newState });
  await addLog(`Starting crawl session on domain: ${baseDomain || firstTarget}`, 'info');

  if (newState.auth.required) {
    await addLog(`Authentication required. Navigating to login URL: ${newState.auth.loginUrl}`, 'info');
    startWatchdog(newState.auth.loginUrl, 30000);
    await chrome.tabs.update(tabId, { url: newState.auth.loginUrl, active: true });
  } else {
    await processNextInQueue();
  }
}

/**
 * Stop/abort the active crawl
 */
async function stopCrawl() {
  clearWatchdog();
  const { crawlState } = await chrome.storage.local.get('crawlState');
  if (crawlState) {
    crawlState.status = 'PAUSED';
    crawlState.isCapturing = false;
    await chrome.storage.local.set({ crawlState });
    await addLog('Crawl paused/stopped by user.', 'warn');
  }
}

/**
 * Reset crawl state
 */
async function resetState() {
  clearWatchdog();
  const emptyState = {
    status: 'IDLE',
    tabId: null,
    baseDomain: '',
    baseOrigin: '',
    queue: [],
    visited: [],
    failed: [],
    autoDiscover: true,
    maxPages: 25,
    scrollDelay: 450,
    auth: {
      required: false,
      loginUrl: '',
      username: '',
      password: '',
      attempted: false,
      status: 'idle'
    },
    currentUrl: null,
    isCapturing: false,
    logs: []
  };
  await chrome.storage.local.set({ crawlState: emptyState });
  await addLog('State reset successfully.', 'info');
}

/**
 * Navigates to the next URL in the queue
 */
async function processNextInQueue() {
  clearWatchdog();
  const { crawlState } = await chrome.storage.local.get('crawlState');
  if (!crawlState || crawlState.status !== 'CRAWLING') return;

  // Check if max pages reached
  if (crawlState.visited.length >= crawlState.maxPages) {
    crawlState.status = 'COMPLETED';
    crawlState.currentUrl = null;
    crawlState.isCapturing = false;
    await chrome.storage.local.set({ crawlState });
    await addLog(`Reached maximum page limit (${crawlState.maxPages}). Crawl completed! 🎉`, 'success');
    return;
  }

  // Dequeue next unvisited URL
  let nextUrl = null;
  while (crawlState.queue.length > 0) {
    const candidate = normalizeUrl(crawlState.queue.shift());
    if (candidate && !crawlState.visited.includes(candidate)) {
      nextUrl = candidate;
      break;
    }
  }

  // If queue is empty, complete crawl
  if (!nextUrl) {
    crawlState.status = 'COMPLETED';
    crawlState.currentUrl = null;
    crawlState.isCapturing = false;
    await chrome.storage.local.set({ crawlState });
    await addLog(`Crawl completed! Captured ${crawlState.visited.length} pages. (${crawlState.failed.length} failed) 🎉`, 'success');
    return;
  }

  crawlState.currentUrl = nextUrl;
  crawlState.isCapturing = false;
  await chrome.storage.local.set({ crawlState });

  await addLog(`Navigating to: ${nextUrl} (${crawlState.queue.length} remaining in queue)`, 'info');
  startWatchdog(nextUrl, 45000);

  try {
    const tab = await chrome.tabs.get(crawlState.tabId).catch(() => null);
    if (!tab) {
      // If tab was closed, re-open
      const reTab = await chrome.tabs.create({ url: nextUrl, active: true });
      crawlState.tabId = reTab.id;
      await chrome.storage.local.set({ crawlState });
      return;
    }

    // Ensure tab is active
    await chrome.tabs.update(crawlState.tabId, { active: true }).catch(() => {});

    // Check if tab is ALREADY at this exact canonical URL
    const tabCurrentCanonical = normalizeUrl(tab.url);
    if (tabCurrentCanonical === nextUrl) {
      await addLog(`Tab is already at target URL: ${nextUrl}. Initiating capture directly...`, 'info');
      await initiatePageCapture(crawlState.tabId, nextUrl);
    } else {
      await chrome.tabs.update(crawlState.tabId, { url: nextUrl });
    }
  } catch (err) {
    console.error('Error navigating tab:', err);
    await addLog(`Navigation error: ${err.message}`, 'error');
    crawlState.failed.push({ url: nextUrl, reason: err.message });
    crawlState.currentUrl = null;
    crawlState.isCapturing = false;
    await chrome.storage.local.set({ crawlState });
    await processNextInQueue();
  }
}

/**
 * Handshake and initiate page capture on the target tab
 */
async function initiatePageCapture(tabId, expectedUrl) {
  const { crawlState } = await chrome.storage.local.get('crawlState');
  if (!crawlState || crawlState.status !== 'CRAWLING' || !crawlState.currentUrl) return;

  // Prevent multiple simultaneous captures of the same URL
  if (crawlState.isCapturing) return;

  crawlState.isCapturing = true;
  await chrome.storage.local.set({ crawlState });

  await addLog(`Page ready: ${expectedUrl}. Hydrating components and preparing capture...`, 'info');

  // Small delay for SPA routers and client hydration
  await new Promise(r => setTimeout(r, 800));

  let attempts = 0;
  const maxAttempts = 6;
  let success = false;

  while (attempts < maxAttempts && !success) {
    attempts++;
    try {
      // Ensure tab is active for captureVisibleTab
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});

      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'START_PAGE_CAPTURE',
        autoDiscover: crawlState.autoDiscover,
        baseDomain: crawlState.baseDomain,
        scrollDelay: crawlState.scrollDelay
      });

      if (response && response.success) {
        success = true;
        break;
      }
    } catch (msgErr) {
      // Content script may still be injecting or page reloading
      console.warn(`[Crawler] Attempt ${attempts}/${maxAttempts} communication failed:`, msgErr.message);

      if (attempts === 2) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          });
        } catch (e) {}
      }

      await new Promise(r => setTimeout(r, 600));
    }
  }

  if (!success) {
    await addLog(`Could not start capture on ${expectedUrl} after ${maxAttempts} attempts.`, 'error');
    const { crawlState: latestState } = await chrome.storage.local.get('crawlState');
    if (latestState && latestState.status === 'CRAWLING') {
      latestState.failed.push({ url: expectedUrl, reason: 'Failed to communicate with content script' });
      latestState.currentUrl = null;
      latestState.isCapturing = false;
      await chrome.storage.local.set({ crawlState: latestState });
      await processNextInQueue();
    }
  }
}

/**
 * Tab listener for BOTH full document loads (MPA) and client-side route changes (SPA)
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const { crawlState } = await chrome.storage.local.get('crawlState');
  if (!crawlState || crawlState.tabId !== tabId) return;

  const isComplete = changeInfo.status === 'complete';
  const isUrlChange = Boolean(changeInfo.url);

  // If neither status is complete nor URL changed, ignore
  if (!isComplete && !isUrlChange) return;

  // 1. Handling Authentication Flow
  if (crawlState.status === 'LOGGING_IN') {
    if (!isComplete) return;

    const isLoginUrl = tab.url && tab.url.includes(new URL(crawlState.auth.loginUrl).pathname);

    if (isLoginUrl && !crawlState.auth.attempted) {
      await addLog('Login page loaded. Injecting credentials...', 'info');
      crawlState.auth.attempted = true;
      await chrome.storage.local.set({ crawlState });

      setTimeout(async () => {
        try {
          const response = await chrome.tabs.sendMessage(tabId, {
            action: 'PERFORM_LOGIN',
            credentials: {
              username: crawlState.auth.username,
              password: crawlState.auth.password
            }
          });

          if (response && response.success) {
            await addLog('Credentials injected and submitted. Waiting for session redirect...', 'info');
          } else {
            await addLog(`Login injection warning: ${response?.error || 'Form not submitted'}`, 'warn');
          }
        } catch (err) {
          console.warn('Failed to communicate with content script during login:', err);
        }
      }, 1000);
      return;
    }

    if (crawlState.auth.attempted && !isLoginUrl) {
      await addLog('Authentication successful! Transitioning to crawl queue...', 'success');
      crawlState.auth.status = 'success';
      crawlState.status = 'CRAWLING';
      await chrome.storage.local.set({ crawlState });
      await processNextInQueue();
      return;
    }
  }

  // 2. Handling Page Crawl and Screenshot Capture
  if (crawlState.status === 'CRAWLING' && crawlState.currentUrl && !crawlState.isCapturing) {
    const canonicalCurrent = normalizeUrl(crawlState.currentUrl);
    const canonicalTab = normalizeUrl(tab.url);

    // Trigger on full page load completion, or SPA URL change matching our target
    if (isComplete || (isUrlChange && canonicalTab === canonicalCurrent)) {
      await initiatePageCapture(tabId, crawlState.currentUrl);
    }
  }
});

/**
 * Handle incoming messages from popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'START_CRAWL': {
          await startCrawl(message.config, sender);
          sendResponse({ success: true });
          break;
        }

        case 'STOP_CRAWL': {
          await stopCrawl();
          sendResponse({ success: true });
          break;
        }

        case 'RESET_STATE': {
          await resetState();
          sendResponse({ success: true });
          break;
        }

        case 'OPEN_POPUP_WINDOW': {
          await openPopupWindow();
          sendResponse({ success: true });
          break;
        }

        // Viewport capture request from content.js
        case 'CAPTURE_VISIBLE_TAB': {
          const targetTabId = sender.tab ? sender.tab.id : null;
          const targetWindowId = sender.tab ? sender.tab.windowId : null;

          if (targetTabId) {
            await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});
          }

          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'png' });
            sendResponse({ success: true, dataUrl });
          } catch (err) {
            // Retry once after brief delay if tab was just focused
            await new Promise(r => setTimeout(r, 150));
            try {
              const retryDataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'png' });
              sendResponse({ success: true, dataUrl: retryDataUrl });
            } catch (retryErr) {
              console.error('captureVisibleTab error:', retryErr);
              sendResponse({ success: false, error: retryErr.message });
            }
          }
          break;
        }

        // Final screenshot stitched by content.js ready to save
        case 'SAVE_SCREENSHOT': {
          const { dataUrl, filename, pageUrl, discoveredLinks } = message;
          clearWatchdog();

          const { crawlState } = await chrome.storage.local.get('crawlState');
          if (!crawlState) {
            sendResponse({ success: false, error: 'No active state' });
            return;
          }

          // Trigger browser download for the captured full-page screenshot into GUI folder
          try {
            await chrome.downloads.download({
              url: dataUrl,
              filename: `GUI/${filename}`,
              conflictAction: 'uniquify',
              saveAs: false
            });
            await addLog(`Captured & saved screenshot: GUI/${filename}`, 'success');
          } catch (dlErr) {
            console.warn('Download error via chrome.downloads:', dlErr);
            await addLog(`Captured page screenshot: GUI/${filename}`, 'info');
          }

          // Mark current page as visited (canonicalized)
          const canonicalPage = normalizeUrl(pageUrl) || pageUrl;
          if (canonicalPage && !crawlState.visited.includes(canonicalPage)) {
            crawlState.visited.push(canonicalPage);
          }

          // Also mark currentUrl as visited to avoid re-crawling
          if (crawlState.currentUrl && !crawlState.visited.includes(crawlState.currentUrl)) {
            crawlState.visited.push(crawlState.currentUrl);
          }

          // Enqueue newly discovered links (if auto-discovery enabled)
          if (crawlState.autoDiscover && Array.isArray(discoveredLinks) && discoveredLinks.length > 0) {
            let newlyAddedCount = 0;
            for (const link of discoveredLinks) {
              const normLink = normalizeUrl(link);
              if (
                normLink &&
                !crawlState.visited.includes(normLink) &&
                !crawlState.queue.includes(normLink) &&
                !crawlState.failed.some(f => f.url === normLink)
              ) {
                crawlState.queue.push(normLink);
                newlyAddedCount++;
              }
            }
            if (newlyAddedCount > 0) {
              await addLog(`Discovered ${newlyAddedCount} new unique internal links (Queue size: ${crawlState.queue.length})`, 'info');
            }
          }

          crawlState.currentUrl = null;
          crawlState.isCapturing = false;
          await chrome.storage.local.set({ crawlState });

          sendResponse({ success: true });

          // Proceed to next page in queue
          await processNextInQueue();
          break;
        }

        case 'CAPTURE_FAILED': {
          clearWatchdog();
          const { pageUrl, error } = message;
          const canonicalPage = normalizeUrl(pageUrl) || pageUrl;
          await addLog(`Capture failed on ${canonicalPage}: ${error}`, 'error');

          const { crawlState } = await chrome.storage.local.get('crawlState');
          if (crawlState) {
            crawlState.failed.push({ url: canonicalPage, reason: error });
            crawlState.currentUrl = null;
            crawlState.isCapturing = false;
            await chrome.storage.local.set({ crawlState });
            await processNextInQueue();
          }
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      }
    } catch (err) {
      console.error('background.js message handler error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});
