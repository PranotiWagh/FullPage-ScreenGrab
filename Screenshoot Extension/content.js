/**
 * Content Script: content.js
 * Handles:
 * 1. Form credential injection & authentication
 * 2. Internal link discovery
 * 3. Viewport scrolling, capture coordination, and HTML5 Canvas stitching
 */

// Utility sleep promise
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Safely sanitize filename for Chrome downloads
function sanitizeFilename(str) {
  return str
    .replace(/https?:\/\//g, '')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 80);
}

// Extract the exact name of the page from document.title or URL path
function getPageName() {
  let title = (document.title || '').trim();

  // If no document.title is available, fallback to the last segment of the pathname
  if (!title) {
    const cleanPath = window.location.pathname.replace(/^\/+|\/+$/g, '');
    title = cleanPath.split('/').pop() || 'Home';
  }

  // Remove illegal characters for file systems: \ / : * ? " < > |
  let cleanName = title
    .replace(/[\\/:*?"<>|]+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  // Clean leading or trailing dashes / dots / underscores
  cleanName = cleanName.replace(/^[-_\.]+|[-_\.]+$/g, '').trim();

  // Limit length to 100 characters to prevent path length issues
  if (cleanName.length > 100) {
    cleanName = cleanName.substring(0, 100).trim();
  }

  return cleanName || 'Page';
}

/**
 * Native value setter that triggers React / Vue / Angular change detectors
 */
function setNativeInputValue(element, value) {
  if (!element) return;
  element.focus();
  const prototype = Object.getPrototypeOf(element);
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
}

/**
 * Automate login credentials injection
 */
async function performLogin(credentials) {
  const { username, password } = credentials || {};
  console.log('[Crawler] Performing automated login...');

  // Search for username/email input
  const usernameSelectors = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]',
    'input[type="text"]'
  ];

  let usernameInput = null;
  for (const sel of usernameSelectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) { // ensure visible
      usernameInput = el;
      break;
    }
  }

  // Search for password input
  const passwordInput = document.querySelector('input[type="password"]');

  if (!usernameInput && !passwordInput) {
    throw new Error('Could not find visible login input fields on this page.');
  }

  if (usernameInput && username) {
    setNativeInputValue(usernameInput, username);
  }

  await sleep(200);

  if (passwordInput && password) {
    setNativeInputValue(passwordInput, password);
  }

  await sleep(300);

  // Locate submit button or form
  let submitBtn = null;
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:not([type="button"])',
    'form button',
    '.login-btn',
    '.submit-btn'
  ];

  for (const sel of submitSelectors) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null) {
      submitBtn = btn;
      break;
    }
  }

  const form = (usernameInput && usernameInput.closest('form')) ||
               (passwordInput && passwordInput.closest('form'));

  if (submitBtn) {
    submitBtn.click();
    return { success: true, method: 'clicked_submit_button' };
  } else if (form) {
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.submit();
    }
    return { success: true, method: 'submitted_form' };
  } else {
    // Attempt keyboard enter key on password input
    if (passwordInput) {
      passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      passwordInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return { success: true, method: 'enter_key' };
    }
  }

  throw new Error('Form submit button could not be located.');
}

/**
 * Canonical URL Normalizer
 * Normalizes protocol, hostname, trailing slashes, tracking parameters,
 * and preserves SPA hash routes while removing in-page scroll anchors.
 */
function normalizeUrl(rawUrl, baseOrigin) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
    return null;
  }

  try {
    const url = new URL(trimmed, baseOrigin || window.location.href);

    // Only allow HTTP and HTTPS protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Normalize hostname: lowercase, remove trailing dot
    url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');

    // Handle hash fragments:
    // Preserve SPA routing hashes like '#/route', '#!/route', '#/page?id=1'
    // Strip plain in-page scroll anchors like '#top', '#section-1', '#'
    if (url.hash) {
      if (/^#(\/|!|\?[a-zA-Z0-9_\-]+=|route=|path=)/.test(url.hash)) {
        // SPA hash route — preserve it
      } else {
        url.hash = '';
      }
    }

    // Strip common tracking and session query parameters
    const trackingKeys = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'fbclid', 'gclid', '_ga', '_gl', 'mc_cid', 'mc_eid'
    ];
    for (const key of trackingKeys) {
      url.searchParams.delete(key);
    }

    // Normalize pathname: remove trailing slash (except for bare '/')
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch (e) {
    return null;
  }
}

/**
 * Check if candidate URL belongs to the same domain / web application
 */
function isSameDomain(candidateUrl, baseDomain) {
  try {
    const parsed = new URL(candidateUrl);
    const targetHost = (baseDomain || window.location.hostname).toLowerCase();
    const candHost = parsed.hostname.toLowerCase();

    // Exact hostname match
    if (candHost === targetHost) return true;

    // Normalized hostname comparison (ignoring 'www.')
    const cleanTarget = targetHost.replace(/^www\./, '');
    const cleanCand = candHost.replace(/^www\./, '');
    if (cleanCand === cleanTarget) return true;

    // Allow subdomains if target is root domain
    if (cleanCand.endsWith('.' + cleanTarget)) return true;

    // Allow localhost/IP ports
    if ((targetHost.includes('localhost') || targetHost.includes('127.0.0.1')) &&
        (candHost.includes('localhost') || candHost.includes('127.0.0.1'))) {
      const curPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const candPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      return curPort === candPort;
    }

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Deep DOM traversal collecting candidate links from standard elements,
 * custom attributes (React/Vue/Angular router attributes), and Shadow DOM roots.
 */
function collectCandidateHrefs(root = document, maxDepth = 4) {
  const candidateStrings = [];

  function traverse(node, depth) {
    if (!node || depth > maxDepth) return;

    // 1. Standard anchor and area elements
    try {
      const anchors = node.querySelectorAll ? node.querySelectorAll('a[href], area[href]') : [];
      for (const a of anchors) {
        const href = a.getAttribute('href');
        if (href) candidateStrings.push(href);
      }
    } catch (e) {}

    // 2. SPA & framework routing attributes: data-href, data-url, data-to, routerlink, to
    try {
      const customElements = node.querySelectorAll ? node.querySelectorAll(
        '[data-href], [data-url], [data-path], [data-route], [data-link], [routerlink], [to], [role="link"]'
      ) : [];
      for (const el of customElements) {
        const val = el.getAttribute('data-href') ||
                    el.getAttribute('data-url') ||
                    el.getAttribute('data-path') ||
                    el.getAttribute('data-route') ||
                    el.getAttribute('data-link') ||
                    el.getAttribute('routerlink') ||
                    el.getAttribute('to') ||
                    el.getAttribute('href');
        if (val && typeof val === 'string') candidateStrings.push(val);
      }
    } catch (e) {}

    // 3. Inspect open Shadow DOM roots recursively
    try {
      const allElements = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (const el of allElements) {
        if (el.shadowRoot) {
          traverse(el.shadowRoot, depth + 1);
        }
      }
    } catch (e) {}
  }

  traverse(root, 0);
  return candidateStrings;
}

/**
 * Discover and filter internal links on the same domain/app
 */
function extractInternalLinks(baseDomain) {
  const links = new Set();
  const rawHrefs = collectCandidateHrefs(document);

  // File extensions to exclude (static media, downloads, source code, data files)
  const excludedExtensions = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|rar|7z|exe|dmg|pkg|deb|rpm|mp4|mp3|wav|avi|mov|wmv|flv|webm|css|js|map|json|xml|rss|atom|txt|csv|tsv|xls|xlsx|doc|docx|ppt|pptx)$/i;

  // Logout / session-destructive paths to avoid
  const logoutPatterns = /(logout|signout|sign-out|log-out|session\/destroy|auth\/logout|exit)/i;

  const currentCanonical = normalizeUrl(window.location.href);

  for (const rawHref of rawHrefs) {
    const normalized = normalizeUrl(rawHref, window.location.href);
    if (!normalized) continue;

    // Check same domain/subdomain
    if (!isSameDomain(normalized, baseDomain)) continue;

    try {
      const parsed = new URL(normalized);

      // Ignore static assets & file downloads
      if (excludedExtensions.test(parsed.pathname)) continue;

      // Ignore logout paths
      if (logoutPatterns.test(parsed.pathname) || logoutPatterns.test(parsed.search) || logoutPatterns.test(parsed.hash)) {
        continue;
      }

      // Don't add current page to queue
      if (currentCanonical && normalized === currentCanonical) continue;

      links.add(normalized);
    } catch (e) {}
  }

  return Array.from(links);
}

/**
 * Programmatic Scrolling, Viewport Capture & HTML5 Canvas Stitching
 * Scrapes links continuously as lazy-loaded components and footers render.
 */
async function captureFullPageScreenshot(scrollDelayMs = 450, autoDiscover = false, baseDomain = '') {
  console.log('[Crawler] Initiating full page screenshot stitch...');

  const discoveredLinksSet = new Set();
  if (autoDiscover) {
    const initialLinks = extractInternalLinks(baseDomain);
    initialLinks.forEach(l => discoveredLinksSet.add(l));
  }

  // Hide on-page crawler widget during screenshot so it doesn't appear in images
  const widgetHost = document.getElementById('app-crawler-widget-host');
  if (widgetHost) widgetHost.style.display = 'none';

  // 1. Temporarily suppress scrollbars to avoid capturing scrollbar tracks
  const scrollbarStyle = document.createElement('style');
  scrollbarStyle.id = '__crawler_hide_scrollbars';
  scrollbarStyle.textContent = `
    ::-webkit-scrollbar { display: none !important; width: 0 !important; }
    html, body { scrollbar-width: none !important; -ms-overflow-style: none !important; }
  `;
  document.head.appendChild(scrollbarStyle);

  // 2. Initial scroll to top
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  await sleep(300);

  // 3. Compute accurate full-page dimensions
  const scrollWidth = Math.max(
    document.body.scrollWidth,
    document.documentElement.scrollWidth,
    document.body.offsetWidth,
    document.documentElement.offsetWidth,
    document.documentElement.clientWidth,
    window.innerWidth
  );

  let scrollHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
    document.body.offsetHeight,
    document.documentElement.offsetHeight,
    document.documentElement.clientHeight,
    window.innerHeight
  );

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  // Protect against infinite scroll blowing up canvas memory limit (max canvas size in Chrome is ~16,384px)
  const MAX_CANVAS_HEIGHT = 16384;
  if (scrollHeight * dpr > MAX_CANVAS_HEIGHT) {
    console.warn(`[Crawler] Truncating page height from ${scrollHeight} to fit max canvas limits`);
    scrollHeight = Math.floor(MAX_CANVAS_HEIGHT / dpr);
  }

  console.log(`[Crawler] Dimensions: ${scrollWidth}x${scrollHeight} (DPR: ${dpr}, Viewport: ${viewportWidth}x${viewportHeight})`);

  // 4. Initialize HTML5 Canvas
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(scrollWidth * dpr);
  canvas.height = Math.round(scrollHeight * dpr);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Unable to create 2D canvas context');
  }

  // 5. Generate list of scroll offsets
  const yPositions = [];
  for (let y = 0; y < scrollHeight; y += viewportHeight) {
    yPositions.push(y);
  }
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);
  if (yPositions.length === 0 || yPositions[yPositions.length - 1] < maxScroll) {
    yPositions.push(maxScroll);
  }

  // Store elements with fixed/sticky position to prevent multiple duplicates down the page
  const fixedElements = [];
  try {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const pos = window.getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        fixedElements.push({ element: el, originalVisibility: el.style.visibility });
      }
    }
  } catch (e) {
    console.warn('Could not inspect fixed elements:', e);
  }

  try {
    // 6. Viewport capture loop
    for (let i = 0; i < yPositions.length; i++) {
      const targetY = yPositions[i];
      window.scrollTo({ top: targetY, left: 0, behavior: 'instant' });

      // After first slice, hide fixed elements so headers don't repeat on each slice
      if (i > 0 && fixedElements.length > 0) {
        for (const item of fixedElements) {
          item.element.style.visibility = 'hidden';
        }
      }

      // Wait for lazy-loading images, transitions, and scroll listeners
      await sleep(scrollDelayMs);

      // Scrape any dynamically rendered links at this scroll depth
      if (autoDiscover) {
        const scrolledLinks = extractInternalLinks(baseDomain);
        scrolledLinks.forEach(l => discoveredLinksSet.add(l));
      }

      const actualY = window.scrollY;

      // Ask service worker to capture current viewport
      const captureResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      });

      if (!captureResponse || !captureResponse.success || !captureResponse.dataUrl) {
        throw new Error(captureResponse?.error || 'Failed to capture visible tab slice');
      }

      // Load captured slice into image element
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load slice dataUrl into Image'));
        img.src = captureResponse.dataUrl;
      });

      // Stitch slice onto canvas at actual scroll position
      ctx.drawImage(img, 0, Math.round(actualY * dpr));
    }
  } finally {
    // 7. Cleanup and restore DOM state
    if (scrollbarStyle.parentNode) {
      scrollbarStyle.parentNode.removeChild(scrollbarStyle);
    }

    // Restore fixed/sticky element visibility
    for (const item of fixedElements) {
      item.element.style.visibility = item.originalVisibility;
    }

    // Restore scroll position
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

    // Restore on-page crawler widget
    if (widgetHost) widgetHost.style.display = 'block';
  }

  // 8. Convert stitched canvas to PNG data URL
  const finalDataUrl = canvas.toDataURL('image/png');
  return {
    dataUrl: finalDataUrl,
    discoveredLinks: Array.from(discoveredLinksSet)
  };
}

/**
 * Message listener for commands dispatched from background service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'PERFORM_LOGIN') {
    (async () => {
      try {
        const result = await performLogin(message.credentials);
        sendResponse(result);
      } catch (err) {
        console.error('[Crawler] Login error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }

  if (message.action === 'START_PAGE_CAPTURE') {
    (async () => {
      const pageUrl = normalizeUrl(window.location.href) || window.location.href;
      try {
        // Perform scroll, link scraping, & canvas stitch
        const { dataUrl, discoveredLinks } = await captureFullPageScreenshot(
          message.scrollDelay || 450,
          Boolean(message.autoDiscover),
          message.baseDomain || ''
        );

        console.log(`[Crawler] Scraped total ${discoveredLinks.length} links from ${pageUrl}`);

        // Format filename with the exact name of the page
        const pageName = getPageName();
        const filename = `${pageName}.png`;

        // Dispatch final stitched screenshot to background for saving
        chrome.runtime.sendMessage({
          action: 'SAVE_SCREENSHOT',
          dataUrl,
          filename,
          pageUrl,
          discoveredLinks
        });

        sendResponse({ success: true, filename, discoveredCount: discoveredLinks.length });
      } catch (err) {
        console.error('[Crawler] Capture failed:', err);
        chrome.runtime.sendMessage({
          action: 'CAPTURE_FAILED',
          pageUrl,
          error: err.message
        });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }

  // Toggle On-Page Widget message handler
  if (message.action === 'TOGGLE_ONPAGE_WIDGET') {
    toggleCrawlerWidget();
    sendResponse({ success: true });
    return false;
  }

  // Ping / health check
  if (message.action === 'PING') {
    sendResponse({ success: true });
    return false;
  }
});

// ==========================================
// ON-PAGE FLOATING CRAWLER WIDGET & MODAL
// ==========================================

function initOnPageWidget() {
  if (document.getElementById('app-crawler-widget-host')) return;

  const host = document.createElement('div');
  host.id = 'app-crawler-widget-host';
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.bottom = '20px';
  host.style.right = '20px';
  host.style.zIndex = '2147483647';
  host.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      
      .floating-btn {
        background: linear-gradient(135deg, #4f46e5, #06b6d4);
        color: white;
        border: none;
        border-radius: 50px;
        padding: 10px 16px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 4px 20px rgba(79, 70, 229, 0.45);
        transition: all 0.2s ease;
      }
      .floating-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 24px rgba(79, 70, 229, 0.6);
      }

      .modal-card {
        display: none;
        position: absolute;
        bottom: 50px;
        right: 0;
        width: 380px;
        background: #090d16;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7);
        color: #f1f5f9;
        font-size: 12px;
      }
      .modal-card.open { display: block; }

      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .modal-title { font-weight: 700; font-size: 13px; color: #fff; }
      .open-window-btn {
        background: #1e293b;
        border: 1px solid #334155;
        color: #94a3b8;
        font-size: 10px;
        font-weight: 600;
        padding: 3px 6px;
        border-radius: 4px;
        cursor: pointer;
        margin-left: auto;
        margin-right: 8px;
        transition: all 0.2s ease;
      }
      .open-window-btn:hover { background: #334155; color: #fff; }
      .close-btn {
        background: none; border: none; color: #94a3b8; font-size: 16px; cursor: pointer;
      }
      .close-btn:hover { color: #fff; }

      label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
      textarea, input[type="text"], input[type="password"] {
        width: 100%;
        background: #0d1525;
        border: 1px solid #334155;
        border-radius: 6px;
        color: #fff;
        padding: 6px 8px;
        font-size: 11.5px;
        outline: none;
        margin-bottom: 8px;
      }
      textarea { resize: vertical; min-height: 50px; font-family: monospace; }
      
      .checkbox-row {
        display: flex; align-items: center; gap: 6px; margin-bottom: 10px; cursor: pointer; color: #cbd5e1;
      }
      .checkbox-row input { accent-color: #4f46e5; }

      .action-btn {
        width: 100%;
        background: linear-gradient(135deg, #4f46e5, #6366f1);
        color: #fff;
        border: none;
        border-radius: 7px;
        padding: 8px 12px;
        font-weight: 600;
        cursor: pointer;
        font-size: 12px;
      }
      .action-btn:hover { opacity: 0.95; }
      .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }

      .status-pill {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 10px;
        font-size: 10px;
        font-weight: 700;
        background: #1e293b;
        color: #94a3b8;
        margin-bottom: 8px;
      }
    </style>

    <button type="button" class="floating-btn" id="widgetToggleBtn">
      <span>📸</span>
      <span>App Crawler</span>
    </button>

    <div class="modal-card" id="widgetModal">
      <div class="modal-header">
        <span class="modal-title">📸 Full-Page App Crawler</span>
        <button type="button" class="open-window-btn" id="widgetOpenWindowBtn" title="Open complete popup window">↗ Full Window</button>
        <button type="button" class="close-btn" id="widgetCloseBtn">✕</button>
      </div>

      <div class="status-pill" id="widgetStatus">IDLE</div>

      <label for="wTargets">Target URL(s) to Screenshot:</label>
      <textarea id="wTargets"></textarea>

      <div class="checkbox-row">
        <input type="checkbox" id="wAutoDiscover" checked>
        <label for="wAutoDiscover" style="margin: 0; cursor: pointer; color: #e2e8f0;">Auto-discover links on domain</label>
      </div>

      <button type="button" class="action-btn" id="wStartBtn">🚀 Start Crawl & Screenshot</button>
    </div>
  `;

  document.body.appendChild(host);

  const toggleBtn = shadow.getElementById('widgetToggleBtn');
  const closeBtn = shadow.getElementById('widgetCloseBtn');
  const openWindowBtn = shadow.getElementById('widgetOpenWindowBtn');
  const modal = shadow.getElementById('widgetModal');
  const targetsInput = shadow.getElementById('wTargets');
  const autoDiscoverCb = shadow.getElementById('wAutoDiscover');
  const startBtn = shadow.getElementById('wStartBtn');
  const statusEl = shadow.getElementById('widgetStatus');

  // Pre-fill with current page URL
  targetsInput.value = window.location.href;

  function toggle() {
    const isOpen = modal.classList.toggle('open');
    if (isOpen && !targetsInput.value.trim()) {
      targetsInput.value = window.location.href;
    }
  }

  toggleBtn.addEventListener('click', toggle);
  closeBtn.addEventListener('click', () => modal.classList.remove('open'));
  if (openWindowBtn) {
    openWindowBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'OPEN_POPUP_WINDOW' });
      modal.classList.remove('open');
    });
  }

  startBtn.addEventListener('click', () => {
    const rawUrls = targetsInput.value.split('\n').map(u => u.trim()).filter(Boolean);
    const initialUrls = rawUrls.length > 0 ? rawUrls : [window.location.href];

    const config = {
      targetUrls: initialUrls,
      autoDiscover: autoDiscoverCb.checked,
      maxPages: 25,
      scrollDelay: 450,
      auth: { required: false, loginUrl: '', username: '', password: '' }
    };

    chrome.runtime.sendMessage({ action: 'START_CRAWL', config }, (res) => {
      if (res?.success) {
        startBtn.disabled = true;
        statusEl.textContent = 'CRAWLING...';
        statusEl.style.color = '#34d399';
      }
    });
  });

  // Sync state
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.crawlState) {
      const state = changes.crawlState.newValue;
      const status = state?.status || 'IDLE';
      statusEl.textContent = status;
      startBtn.disabled = status === 'CRAWLING' || status === 'LOGGING_IN';
    }
  });
}

function toggleCrawlerWidget() {
  const host = document.getElementById('app-crawler-widget-host');
  if (host && host.shadowRoot) {
    const modal = host.shadowRoot.getElementById('widgetModal');
    if (modal) modal.classList.toggle('open');
  } else {
    initOnPageWidget();
    toggleCrawlerWidget();
  }
}

// Keyboard shortcut: Ctrl + Shift + S
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
    e.preventDefault();
    toggleCrawlerWidget();
  }
});

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOnPageWidget);
} else {
  initOnPageWidget();
}
