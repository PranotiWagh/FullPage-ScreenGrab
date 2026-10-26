/**
 * Popup script for Full-Page Web App Crawler & Screenshot Extension
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const detectedTabUrl = document.getElementById('detectedTabUrl');
  const useCurrentTabBtn = document.getElementById('useCurrentTabBtn');
  
  const targetUrlsEl = document.getElementById('targetUrls');
  const autoDiscoverEl = document.getElementById('autoDiscover');
  const maxPagesEl = document.getElementById('maxPages');
  const scrollDelayEl = document.getElementById('scrollDelay');
  
  const authToggleBtn = document.getElementById('authToggleBtn');
  const authChevron = document.getElementById('authChevron');
  const authContent = document.getElementById('authContent');
  const loginUrlEl = document.getElementById('loginUrl');
  const authUsernameEl = document.getElementById('authUsername');
  const authPasswordEl = document.getElementById('authPassword');
  
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const clearLogsBtn = document.getElementById('clearLogsBtn');

  const progressBar = document.getElementById('progressBar');
  const statQueue = document.getElementById('statQueue');
  const statVisited = document.getElementById('statVisited');
  const statFailed = document.getElementById('statFailed');
  const currentUrlDisplay = document.getElementById('currentUrlDisplay');
  const logTerminal = document.getElementById('logTerminal');
  const popoutBtn = document.getElementById('popoutBtn');

  // Pop-out Standalone Window
  if (popoutBtn) {
    const isStandalone = window.location.search.includes('standalone=true');
    if (isStandalone) {
      popoutBtn.style.display = 'none';
    } else {
      popoutBtn.addEventListener('click', async () => {
        try {
          if (chrome?.windows?.create) {
            await chrome.windows.create({
              url: chrome.runtime.getURL('popup.html?standalone=true'),
              type: 'popup',
              width: 480,
              height: 680,
              focused: true
            });
            window.close();
          }
        } catch (e) {
          console.warn('Failed to pop out window:', e);
        }
      });
    }
  }

  // Toggle Authentication section
  authToggleBtn.addEventListener('click', () => {
    const isOpen = authContent.classList.toggle('open');
    authChevron.textContent = isOpen ? '▲' : '▼';
  });

  // Helper to reliably find the user's active web page tab (excluding extension popups)
  async function getActiveWebTab() {
    const isStandalone = window.location.search.includes('standalone=true');
    try {
      if (isStandalone) {
        const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
        for (const win of windows) {
          const tab = win.tabs?.find(t => t.active && t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
          if (tab) return tab;
        }
        for (const win of windows) {
          const tab = win.tabs?.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
          if (tab) return tab;
        }
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
          return tab;
        }
      }
    } catch (e) {
      console.warn('Error querying active web tab:', e);
    }
    return null;
  }

  // Query Active Tab
  let activeTabUrl = '';
  let activeTabId = null;
  const initialTab = await getActiveWebTab();
  if (initialTab && initialTab.url) {
    activeTabUrl = initialTab.url;
    activeTabId = initialTab.id;
    detectedTabUrl.textContent = `🌐 Tab: ${activeTabUrl}`;
    detectedTabUrl.title = activeTabUrl;
  } else {
    detectedTabUrl.textContent = '🌐 Ready to crawl. Open web app or enter URL.';
  }

  // Load saved configurations and current state from storage
  let storageData = {};
  try {
    if (chrome?.storage?.local) {
      storageData = await chrome.storage.local.get(['crawlState', 'savedConfig']);
    }
  } catch (e) {
    console.warn('Could not read storage', e);
  }
  const saved = storageData.savedConfig || {};

  if (saved.targetUrls) targetUrlsEl.value = saved.targetUrls;
  if (saved.autoDiscover !== undefined) autoDiscoverEl.checked = saved.autoDiscover;
  if (saved.maxPages) maxPagesEl.value = saved.maxPages;
  if (saved.scrollDelay) scrollDelayEl.value = saved.scrollDelay;
  if (saved.loginUrl) loginUrlEl.value = saved.loginUrl;
  if (saved.username) authUsernameEl.value = saved.username;

  // Auto-populate target URL with active tab if textarea is empty and active tab is http(s)
  if (!targetUrlsEl.value.trim() && activeTabUrl && (activeTabUrl.startsWith('http://') || activeTabUrl.startsWith('https://'))) {
    targetUrlsEl.value = activeTabUrl;
  }

  // "Use Tab" button handler
  useCurrentTabBtn.addEventListener('click', async () => {
    const tab = await getActiveWebTab();
    if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      targetUrlsEl.value = tab.url;
      activeTabUrl = tab.url;
      activeTabId = tab.id;
      detectedTabUrl.textContent = `🌐 Tab: ${tab.url}`;
      detectedTabUrl.title = tab.url;
    } else {
      alert('Could not find an active web app tab. Please open a website tab or enter the URL manually.');
    }
  });

  // Render initial state
  renderState(storageData.crawlState);

  // Sync state in real time
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.crawlState) {
      renderState(changes.crawlState.newValue);
    }
  });

  function renderState(state) {
    if (!state) {
      state = {
        status: 'IDLE',
        queue: [],
        visited: [],
        failed: [],
        currentUrl: null,
        logs: []
      };
    }

    const status = state.status || 'IDLE';
    statusText.textContent = status;
    statusBadge.className = 'status-badge ' + status.toLowerCase();

    const isRunning = status === 'CRAWLING' || status === 'LOGGING_IN';
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    targetUrlsEl.disabled = isRunning;
    autoDiscoverEl.disabled = isRunning;
    maxPagesEl.disabled = isRunning;
    scrollDelayEl.disabled = isRunning;
    loginUrlEl.disabled = isRunning;
    authUsernameEl.disabled = isRunning;
    authPasswordEl.disabled = isRunning;

    const qCount = state.queue ? state.queue.length : 0;
    const vCount = state.visited ? state.visited.length : 0;
    const fCount = state.failed ? state.failed.length : 0;
    const total = qCount + vCount + fCount;

    statQueue.textContent = qCount;
    statVisited.textContent = vCount;
    statFailed.textContent = fCount;

    const percent = total > 0 ? Math.round(((vCount + fCount) / total) * 100) : 0;
    progressBar.style.width = `${percent}%`;

    if (state.currentUrl) {
      currentUrlDisplay.textContent = `Current: ${state.currentUrl}`;
      currentUrlDisplay.title = state.currentUrl;
    } else if (status === 'COMPLETED') {
      currentUrlDisplay.textContent = 'Status: All crawl targets completed! ✨';
    } else {
      currentUrlDisplay.textContent = 'Status: Idle (Ready to crawl)';
    }

    renderLogs(state.logs || []);
  }

  function renderLogs(logs) {
    logTerminal.innerHTML = '';
    if (!logs || logs.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.style.color = '#64748b';
      emptyNotice.textContent = 'No logs yet. Click "Start" to begin.';
      logTerminal.appendChild(emptyNotice);
      return;
    }

    for (const item of logs) {
      const entry = document.createElement('div');
      entry.className = `log-entry ${item.level || 'info'}`;

      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = item.timestamp || '';

      const msgSpan = document.createElement('span');
      msgSpan.className = 'log-msg';
      msgSpan.textContent = item.message;

      entry.appendChild(timeSpan);
      entry.appendChild(msgSpan);
      logTerminal.appendChild(entry);
    }
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }

  // START CRAWL
  startBtn.addEventListener('click', async () => {
    const rawUrls = targetUrlsEl.value
      .split('\n')
      .map(u => u.trim())
      .filter(u => u.length > 0);

    let initialUrls = rawUrls;

    // Fallback to active tab URL
    let currentTab = await getActiveWebTab();
    if (initialUrls.length === 0) {
      if (currentTab && currentTab.url && currentTab.url.startsWith('http')) {
        initialUrls = [currentTab.url];
        targetUrlsEl.value = currentTab.url;
      } else {
        alert('Please enter a target URL (e.g. http://localhost:3000 or https://example.com) in the box.');
        return;
      }
    }

    for (const u of initialUrls) {
      try {
        new URL(u);
      } catch (err) {
        alert(`Invalid URL format: "${u}". Make sure it starts with http:// or https://`);
        return;
      }
    }

    const loginUrl = loginUrlEl.value.trim();
    if (loginUrl) {
      try {
        new URL(loginUrl);
      } catch (err) {
        alert('Invalid Login URL format.');
        return;
      }
    }

    const config = {
      targetUrls: initialUrls,
      targetTabId: currentTab ? currentTab.id : activeTabId,
      autoDiscover: autoDiscoverEl.checked,
      maxPages: parseInt(maxPagesEl.value, 10) || 25,
      scrollDelay: parseInt(scrollDelayEl.value, 10) || 450,
      auth: {
        required: Boolean(loginUrl),
        loginUrl: loginUrl,
        username: authUsernameEl.value.trim(),
        password: authPasswordEl.value
      }
    };

    await chrome.storage.local.set({
      savedConfig: {
        targetUrls: targetUrlsEl.value,
        autoDiscover: config.autoDiscover,
        maxPages: config.maxPages,
        scrollDelay: config.scrollDelay,
        loginUrl: config.auth.loginUrl,
        username: config.auth.username
      }
    });

    chrome.runtime.sendMessage({ action: 'START_CRAWL', config }, (response) => {
      if (chrome.runtime.lastError) {
        alert('Failed to connect to background service worker: ' + chrome.runtime.lastError.message);
      } else if (response && !response.success) {
        alert('Could not start: ' + (response.error || 'Unknown error'));
      }
    });
  });

  // STOP CRAWL
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_CRAWL' });
  });

  // RESET STATE
  resetBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'RESET_STATE' });
  });

  // CLEAR LOGS
  clearLogsBtn.addEventListener('click', async () => {
    const { crawlState } = await chrome.storage.local.get('crawlState');
    if (crawlState) {
      crawlState.logs = [];
      await chrome.storage.local.set({ crawlState });
    }
    renderLogs([]);
  });
});
