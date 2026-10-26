# Full-Page Web App Crawler & Screenshot Extension (Manifest V3)

A high-performance Chrome Extension built with Manifest V3 that automatically discovers, navigates, and captures full-page stitched screenshots of an entire web application, including password-protected areas.

---

## 🚀 Key Features

1. **Full-Page Canvas Stitching**:
   - Programmatically scrolls through pages window-by-window.
   - Waits for intersection observers, dynamic components, and lazy-loaded images (`loading="lazy"`) to render.
   - Accurately stitches slices into an HTML5 `<canvas>` using device pixel ratio (Hi-DPI / Retina support) without duplicate repeating navigation headers.
   - Exports high-resolution PNGs directly to your browser's download folder.

2. **Automated Internal Link Discovery**:
   - Scans and normalizes same-domain links.
   - Automatically enqueues new internal paths while filtering out file downloads, media, anchors, and destructive logout endpoints (`/logout`, `/signout`).

3. **Authentication Automation**:
   - Built-in form detection and synthetic event injection (`input`, `change`, `blur`) for seamless login compatibility with modern SPAs (React, Vue, Angular, Svelte).
   - Detects session redirects and automatically transitions from authentication to crawl mode.

4. **Resilient Service Worker State Machine**:
   - Persists crawler queue, visited status, and logs in `chrome.storage.local`.
   - Prevents state loss during Manifest V3 service worker lifecycle suspensions or full-page navigations.
   - Features navigation watchdog timers to gracefully bypass unresponsive or hanging pages.

5. **Modern Live Control Panel**:
   - Real-time statistics (Queue, Captured, Failed).
   - Progress bar and live terminal log stream.
   - Manual URL entry mode or automatic domain crawling.

---

## 📂 File Structure

```text
Screenshoot Extension/
├── manifest.json        # Manifest V3 extension configuration
├── popup.html           # Modern glassmorphism dark-mode UI
├── popup.js             # Form controls, validation & state rendering
├── background.js        # Service Worker state machine & navigation controller
├── content.js           # DOM scraper, form injector & Canvas stitcher
└── icons/               # Hi-res extension icons (16px, 48px, 128px)
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## 🛠️ Installation & Opening the Extension Window

1. Open Google Chrome.
2. In the address bar, go to `chrome://extensions/`
3. In the top-right corner, ensure **"Developer mode"** toggle is **ON**.
4. Click **"Load unpacked"** in the top-left corner.
5. Select this directory:
   `c:\Users\prano\Documents\Extension\Screenshoot Extension`
6. **Ways the Popup Window Appears**:
   - **Auto-Launch**: As soon as you load or click Reload 🔄 on the extension, a dedicated standalone control window pops up automatically!
   - **Chrome Toolbar Pin (Recommended)**: Click the **Puzzle piece (🧩)** icon in the top right of Chrome, find **"Full-Page Web App Crawler & Screenshot"**, and click the **Pin (📌)** icon. You can now click the **📸** icon anytime!
   - **Keyboard Shortcut**: Press `Ctrl + Shift + E` (toolbar popup) or `Ctrl + Shift + Y` (standalone window).
   - **Right-Click Context Menu**: Right-click anywhere on any web page and select **"📸 Open Web App Crawler & Screenshot Window"**.
   - **On-Page Widget**: Click the floating **📸 App Crawler** button at the bottom-right corner of any web page.
   - **Pop-Out**: In the toolbar popup header, click **"↗ Pop Out Window"** to turn it into a permanent floating window that won't close when you click away!

---

## 📖 How to Use

### 1. Simple Domain Crawl
1. Navigate to the homepage or dashboard of any web application.
2. Click the extension icon in your Chrome toolbar.
3. Keep **"Auto-discover links on the same domain"** checked.
4. Click **"Start Crawl & Screenshot"**.
5. The extension will automatically visit pages one by one, scroll down each page, capture viewports, stitch them into a full-page PNG, name the image after that specific page's title (e.g. `Dashboard.png`), save it directly to the `GUI/` folder, and discover internal links until the queue or max limit is reached.

### 2. Manual URL List Mode
1. Open the popup.
2. Uncheck "Auto-discover links on the same domain".
3. Paste your specific list of URLs into the textarea (one URL per line).
4. Click **"Start Crawl & Screenshot"**.

### 3. Authenticated Crawl (Protected Web Apps)
1. In the popup, expand **"🔐 Authentication (Optional)"**.
2. Enter the **Login URL**, your **Username / Email**, and **Password**.
3. Click **"Start Crawl & Screenshot"**.
4. The extension navigates to the login page, enters credentials, submits the form, waits for the dashboard redirect, and starts crawling the authenticated application.
