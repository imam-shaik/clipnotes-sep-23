// sidepanel/panel.js
// VERSION: ANTIGRAVITY_STABILITY_V4 (Global Canvas Protection)

let currentVideoId = null;
let currentVideoTitle = null;
let currentTabId = null;
const initialPanelUrlParams = new URLSearchParams(window.location.search);

// Number(null) === 0 — never treat a missing query param as tab/window id 0.
function parsePositiveIntParam(params, key) {
    const raw = params.get(key);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// Mutable so native side panels can adopt a tabId from storage.session when
// Chrome strips the query string from sidePanel.setOptions({ path }).
let boundTabId = parsePositiveIntParam(initialPanelUrlParams, 'tabId');
// Host browser window for THIS panel instance (native side panel or detached).
let hostWindowId = parsePositiveIntParam(initialPanelUrlParams, 'hostWindowId');
const panelMode = initialPanelUrlParams.get('mode') || '';
const isDetachedPanel = panelMode === 'detached';
console.log('[TabFollow][Panel] init', {
    search: window.location.search,
    panelMode,
    isDetachedPanel,
    boundTabId,
    hostWindowId
});
if (Number.isInteger(boundTabId)) {
    currentTabId = boundTabId;
}

function getBoundTabId() {
    return Number.isInteger(boundTabId) ? boundTabId : null;
}

function getHostWindowId() {
    return Number.isInteger(hostWindowId) ? hostWindowId : null;
}

async function clearPendingSidePanelClaim() {
    try {
        if (!chrome?.storage?.session?.remove) return;
        await chrome.storage.session.remove([
            'pendingSidePanelTabId',
            'pendingSidePanelWindowId',
            'pendingSidePanelToken',
            'pendingSidePanelOpenedAt'
        ]);
    } catch (_) { /* already cleared */ }
}

async function claimPendingSidePanelTabIfNeeded() {
    if (isDetachedPanel) return;
    try {
        if (!chrome?.storage?.session?.get) return;

        // URL already carried tabId: this panel is bound — drop any leftover
        // claim so a later panel cannot adopt a stale/raced tab id.
        if (Number.isInteger(boundTabId)) {
            await clearPendingSidePanelClaim();
            return;
        }

        const data = await chrome.storage.session.get([
            'pendingSidePanelTabId',
            'pendingSidePanelWindowId',
            'pendingSidePanelToken',
            'pendingSidePanelOpenedAt'
        ]);
        const pending = Number(data?.pendingSidePanelTabId);
        const pendingWin = Number(data?.pendingSidePanelWindowId);
        const openedAt = Number(data?.pendingSidePanelOpenedAt);
        // Ignore claims older than 5s (stale after a crashed/slow panel load).
        const fresh = Number.isFinite(openedAt) && (Date.now() - openedAt) <= 5000;
        if (Number.isInteger(pending) && pending > 0 && fresh) {
            boundTabId = pending;
            currentTabId = pending;
            if (!Number.isInteger(hostWindowId) && Number.isInteger(pendingWin) && pendingWin > 0) {
                hostWindowId = pendingWin;
            }
        }
        await clearPendingSidePanelClaim();
    } catch (err) {
        console.debug('[Panel] Session tab claim failed:', err);
    }
}

// Native side panel opened via default_path (no ?tabId=): bind only to the
// ACTIVE YouTube watch tab in THIS panel's browser window. Never adopt a
// background watch tab when the active tab is New Tab / another site.
async function adoptTabFromOwnWindowIfNeeded() {
    if (Number.isInteger(boundTabId)) return;
    if (isDetachedPanel) return;
    try {
        if (!Number.isInteger(hostWindowId)) {
            const win = await chrome.windows.getCurrent();
            if (Number.isInteger(win?.id)) hostWindowId = win.id;
        }
        if (!Number.isInteger(hostWindowId)) return;

        const [active] = await chrome.tabs.query({ windowId: hostWindowId, active: true });
        if (active && Number.isInteger(active.id) && isYouTubeWatchUrl(active.url)) {
            boundTabId = active.id;
            currentTabId = active.id;
        }
    } catch (err) {
        console.debug('[Panel] Own-window tab adopt failed:', err);
    }
}

// Active tab in this window is not a YouTube video — tear down and close
// the panel (native side panel OR detached popup window).
async function closeNativePanelBecauseNoWatchTab() {
    if (panelMode === 'preview') return;
    console.log('[TabFollow][Panel] closeNativePanel', {
        boundTabId, currentTabId, currentVideoId, hostWindowId, panelMode, isDetachedPanel
    });
    const previousBound = Number.isInteger(boundTabId) ? boundTabId : currentTabId;
    if (previousBound !== null && previousBound !== undefined) {
        safeSendMessage(previousBound, { action: 'TAB_PANEL_CLOSED' });
        // Clear SW heartbeat BEFORE nulling boundTabId so panelClosed still has a tabId
        // (otherwise reopen is blocked until the 4s heartbeat TTL expires).
        stopPanelHeartbeat(previousBound);
    }

    // Detached popup: remove the real browser window via SW (window.close alone
    // can be ignored) using the tabId that owns detachedPanelWindowByTab.
    if (isDetachedPanel && Number.isInteger(previousBound)) {
        try {
            chrome.runtime.sendMessage({ action: 'closeSidePanel', tabId: previousBound }, () => {
                void chrome.runtime.lastError;
            });
            console.log('[TabFollow][Panel] asked SW closeSidePanel (detached) for', previousBound);
        } catch (e) {
            console.warn('[TabFollow][Panel] closeSidePanel failed:', e?.message || e);
        }
    }

    // Native side panel: disable per-tab options so Chrome hides the panel.
    if (!isDetachedPanel) {
        try {
            const [active] = Number.isInteger(hostWindowId)
                ? await chrome.tabs.query({ windowId: hostWindowId, active: true })
                : [];
            const disableTabId = Number.isInteger(active?.id) ? active.id : previousBound;
            if (Number.isInteger(disableTabId) && chrome.sidePanel?.setOptions) {
                await chrome.sidePanel.setOptions({ tabId: disableTabId, enabled: false });
                console.log('[TabFollow][Panel] sidePanel.setOptions enabled:false for', disableTabId);
            }
            if (Number.isInteger(disableTabId)) {
                chrome.runtime.sendMessage({ action: 'closeSidePanel', tabId: disableTabId }, () => {
                    void chrome.runtime.lastError;
                });
            }
        } catch (e) {
            console.warn('[TabFollow][Panel] disable sidePanel failed:', e?.message || e);
        }
    }

    boundTabId = null;
    currentTabId = null;
    currentVideoId = null;
    currentVideoTitle = null;
    isDataLoadedForId = null;
    loadInFlightForId = null;
    titleUsedForLoad = null;
    isVideoPlaying = false;
    clearVideoStateUI();
    try { window.close(); } catch (_) { /* side panel may ignore close */ }
}

// Native side panel AND detached popup both follow the ACTIVE watch tab in
// hostWindowId. Preview mode never follows.
async function rebindToActiveWatchTabInHostWindow() {
    if (panelMode === 'preview') return false;
    try {
        if (!Number.isInteger(hostWindowId)) {
            // windows.getCurrent() inside a detached popup returns the POPUP,
            // not the host browser — never use it to discover the host window.
            if (isDetachedPanel) {
                console.log('[TabFollow][Panel] rebind: detached missing hostWindowId', { boundTabId, currentVideoId });
                return false;
            }
            const win = await chrome.windows.getCurrent();
            if (Number.isInteger(win?.id)) hostWindowId = win.id;
        }
        if (!Number.isInteger(hostWindowId)) {
            console.log('[TabFollow][Panel] rebind: no hostWindowId', { boundTabId, currentTabId, currentVideoId });
            return false;
        }

        const [active] = await chrome.tabs.query({ windowId: hostWindowId, active: true });
        const activeWatch = !!(active && Number.isInteger(active.id) && isYouTubeWatchUrl(active.url));
        const urlVideoId = activeWatch ? extractVideoIdFromWatchUrl(active.url) : '';
        const tabChanged = !activeWatch || active.id !== boundTabId || active.id !== currentTabId;
        const videoChanged = activeWatch && !!urlVideoId && urlVideoId !== currentVideoId;

        if (!activeWatch) {
            console.log('[TabFollow][Panel] rebind: active not watch → close', {
                activeId: active?.id, activeUrl: active?.url, boundTabId, currentTabId, currentVideoId, panelMode
            });
            await closeNativePanelBecauseNoWatchTab();
            return false;
        }

        if (!tabChanged && !videoChanged) {
            return false;
        }

        console.log('[TabFollow][Panel] rebind →', {
            from: { boundTabId, currentTabId, currentVideoId },
            to: { tabId: active.id, videoId: urlVideoId },
            tabChanged, videoChanged, panelMode
        });

        const previousBound = Number.isInteger(boundTabId) ? boundTabId : null;
        boundTabId = active.id;
        currentTabId = active.id;

        if (videoChanged) {
            currentVideoId = urlVideoId;
            currentVideoTitle = null;
            isDataLoadedForId = null;
            loadInFlightForId = null;
            titleUsedForLoad = null;
            clearVideoStateUI();
            checkMetadataImmediate();
        }

        if (previousBound !== null && previousBound !== boundTabId) {
            safeSendMessage(previousBound, { action: 'TAB_PANEL_CLOSED' });
            // Stop counting the old tab as "panel open" after a YT→YT rebind.
            try {
                chrome.runtime.sendMessage({
                    action: 'panelClosed',
                    tabId: previousBound,
                    panelInstanceId
                }, () => { void chrome.runtime.lastError; });
            } catch (_) { /* ignore */ }
            // Detached popup is keyed by tabId in the SW — move the mapping.
            if (isDetachedPanel) {
                try {
                    chrome.runtime.sendMessage({
                        action: 'rebindDetachedPanel',
                        oldTabId: previousBound,
                        newTabId: boundTabId
                    }, () => { void chrome.runtime.lastError; });
                } catch (_) { /* ignore */ }
            }
        }
        safeSendMessage(boundTabId, { action: 'TAB_PANEL_OPENED' });
        syncNotebookStateToContent(isNotebookEnabled);
        return true;
    } catch (err) {
        console.warn('[TabFollow][Panel] rebind failed:', err);
        return false;
    }
}

// Chrome reuses one side panel document when switching YT tabs (and may strip
// query strings from setOptions paths). Hard-reload bound to the new tabId so
// metadata/screenshots always match the active video.
function forceReloadPanelForTab(tabId, windowId) {
    if (panelMode === 'preview') {
        console.log('[TabFollow][Panel] forceReload skip (preview)', { tabId, panelMode });
        return;
    }
    if (!Number.isInteger(tabId) || tabId <= 0) {
        console.log('[TabFollow][Panel] forceReload skip (bad tabId)', { tabId });
        return;
    }
    if (tabId === boundTabId && tabId === currentTabId) {
        // Search may already match while video state is stale — still hard-reload.
        console.log('[TabFollow][Panel] forceReload: ids already match, hard reload', { tabId, currentVideoId, panelMode });
        try { window.location.reload(); } catch (_) { /* ignore */ }
        return;
    }

    // Preserve existing params (mode=detached, etc.) — only retarget tab binding.
    const qs = new URLSearchParams(window.location.search);
    qs.set('tabId', String(tabId));
    if (Number.isInteger(windowId) && windowId > 0) {
        qs.set('hostWindowId', String(windowId));
    }
    const nextSearch = `?${qs.toString()}`;

    // Seed session claim so a query-stripped reload still binds correctly.
    try {
        if (chrome?.storage?.session?.set) {
            chrome.storage.session.set({
                pendingSidePanelTabId: tabId,
                pendingSidePanelWindowId: Number.isInteger(windowId) && windowId > 0 ? windowId : null,
                pendingSidePanelToken: `${tabId}:${Date.now()}`,
                pendingSidePanelOpenedAt: Date.now()
            });
        }
    } catch (_) { /* optional */ }

    console.log('[TabFollow][Panel] forceReload', {
        from: window.location.search, to: nextSearch, boundTabId, currentTabId, currentVideoId, tabId, panelMode
    });
    if (window.location.search === nextSearch) {
        try { window.location.reload(); } catch (_) { /* ignore */ }
        return;
    }
    window.location.replace(`${window.location.pathname}${nextSearch}`);
}
let videoScrapeTimer = null;
let isNotebookEnabled = false;
let isDataLoadedForId = null; // Track if we've already loaded state for the current ID
let loadInFlightForId = null; // Track an in-flight loadVideoState to avoid duplicate concurrent loads
let titleUsedForLoad = null; // Track which title was used for loading (to detect stale titles)
let isVideoPlaying = false; // Track playback status
let isAutoOpenEnabled = true; // New: Auto-Open toggle state
let isCaptionEnabled = false; // CC-on-Screenshot toggle: OFF by default (clean screenshots)
let lastCaptureTime = 0; // Prevent spamming screenshots too fast
let lastScreenshotHash = null; // Track perceptual hash of last captured image
let lastScreenshotTime = 0; // Track time of last screenshot for time-based duplicate exemption
let currentRehydrationTaskId = 0; // Track active rehydration task ID for cancellation support
const currentlyRehydrating = new Set(); // Track screenshot IDs currently in the process of rehydrating
let panelHeartbeatTimer = null;
let lastAppliedTabSignalTs = 0;
// Unique per panel document so two panels on one tab do not clear each other.
const panelInstanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let disconnectedPollCount = 0;
let detachedHostMissingCount = 0;
let autoScreenshotInterval = null; // Auto-screenshot loop timer
let autoScreenshotMode = 'timer';
let autoScreenshotIntervalMs = 0;
let autoScreenshotActive = false;
let lastAutoScreenshotTime = 0; // Track last auto-screenshot time to suppress scroll
let lastAutoFrameHash = null; // Frame-mode: last sampled hash for change detection
let cachedPlaybackRate = 1.0; // Cache playback rate for dynamic interval adjustment
let lastPlaybackRateFetch = 0; // Timestamp of last playback rate fetch
const PLAYBACK_RATE_CACHE_MS = 5000; // Refresh playback rate every 5 seconds
const BASE_FRAME_INTERVAL_MS = 1500; // Base sampling interval for frame mode (at 1.0x speed)
let savedScrollPositions = new Map(); // videoId -> scrollTop for scroll persistence across navigation
const DUPLICATE_HASH_THRESHOLD = 6; // Hamming distance threshold for "too similar"
const FRAME_CHANGE_HASH_THRESHOLD = 12; // More tolerant for frame-change mode (ignore tiny changes/noise)
const DUPLICATE_TIME_WINDOW_MS = 3000; // 3 seconds - allow duplicates after this time
const AUTO_SCREENSHOT_DETECT_WINDOW_MS = 5000; // 5s window for auto-screenshot detection
const NEAR_BOTTOM_THRESHOLD = 100; // Pixels from bottom to trigger auto-scroll
const VIDEO_STATE_FILENAME = 'video_notes_state.json';
const HISTORY_INDEX_FILENAME = 'history_index.json';
const WATCH_LATER_FILENAME = 'watch_later_list.json';
const COUNTDOWN_FILENAME = 'countdown_list.json';
const ENABLE_REHYDRATION_DEBUG_LOGS = false;
const TRANSPARENT_PIXEL_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MISSING_SCREENSHOT_PLACEHOLDER_DATA_URL = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#f1f5f9"/><g fill="#64748b" font-family="Arial, sans-serif" text-anchor="middle"><text x="320" y="170" font-size="22">Screenshot file missing</text><text x="320" y="204" font-size="15">Re-capture or restore the image in your Save Folder</text></g></svg>'
);

const TIMEOUT_CONFIG = {
    TOAST_DURATION: 3000,
    TOAST_REMOVE_DELAY: 300,
    VIDEO_POLL_RATE: 2000,
    AUTO_SAVE_DEBOUNCE: 1500,
    METADATA_CHECK_DELAY: 100,
    EDITOR_FOCUS_DELAY: 50,
    EDITOR_OPEN_DELAY: 500,
    BLOB_REVOKE_DELAY: 30000,
    RETRY_JITTER_BASE: 650
};

let state = {
    screenshots: [],
    toc: [],
    intervalMarkers: [],
    activeMiniViewId: null, // Fix #19
    blobUrls: new Set(),    // Fix #11: Track Blob URLs for revocation
    watchLaterList: [],
    countdowns: [], // { id, title, startDate, endDate, durationDays }
    metadata: {
        videoId: null,
        videoTitle: "",
        videoUrl: "",
        channel: "",
        lastTimeMs: 0,
        selectedInterval: "None"
    }
};

let isCapturing = false;      // Prevent multiple screenshots at once
let cachedTranscriptSegments = null; // Cache transcript for "Add CC to Note"


const ENABLE_DEBUG_LOGGING = false;
function debugLog(...args) {
    if (ENABLE_DEBUG_LOGGING) console.log("[DEBUG]", ...args);
}

// GLOBAL ERROR TRACKING
window.onerror = function (msg, url, lineNo, columnNo, error) {
    if (msg.includes("Extension context invalidated")) return true; 
    console.error(`[FATAL_STABILITY] ${msg} at ${lineNo}:${columnNo}`, error);
    return false;
};

/**
 * Robust wrapper for chrome.tabs.sendMessage that handles context invalidation
 * and provides descriptive logging for other failure modes.
 */
async function safeSendMessage(tabId, message) {
    if (!tabId || !chrome?.tabs?.sendMessage) return null;
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
        const msg = err?.message || "";
        if (msg.includes("Extension context invalidated")) {
            debugLog("Extension context invalidated during message. This is expected on re-injection/update.");
            return null;
        }
        if (msg.includes("Could not establish connection")) {
            debugLog("Waiting for content script connection...");
            return null;
        }
        console.warn(`[safeSendMessage] Failed to send ${message.action || 'message'}:`, err);
        return null;
    }
}

// ==========================================
// Initialization
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    // console.log("[STABILITY_V3] DOMContentLoaded starting...");
    try {
        // Register message listeners BEFORE any await so CONTENT_READY sent during
        // startup is never dropped (service worker does not buffer deliveries).
        if (panelMode !== 'preview') {
            initMessageListeners();
        }

        // Adopt tab binding before any tab-scoped messaging/heartbeat.
        // Preview mode is a full-tab viewer — never claims a side-panel tab or heartbeats.
        if (panelMode !== 'preview') {
            await claimPendingSidePanelTabIfNeeded();
            await adoptTabFromOwnWindowIfNeeded();

            // Sync to the host window's active watch tab (closes if New Tab, etc.).
            await rebindToActiveWatchTabInHostWindow();

            // Notify content script that panel is open
            if (Number.isInteger(boundTabId)) {
                safeSendMessage(boundTabId, { action: 'TAB_PANEL_OPENED' });
                // Push notebook state so an already-injected content script is in sync.
                syncNotebookStateToContent(isNotebookEnabled);
            }

            startPanelHeartbeat();
        }
        initTheme();
        await initFileSystem();

        if (panelMode === 'preview') {
            // Special full-tab preview mode
            initPreviewMode();
        } else {
            initTabs(); // Initialize tab switching
            initButtons();
            initOptInToggle();
            initAutoOpenToggle();
            await initAutoShotToggle(); // Initialize Auto-Shot timer logic
            initCCToggle();
            initTranscriptRangeSettings();
            initWatchLaterTab();
            
            // Always rebind on a fixed cadence (side-panel documents can report
            // visibilityState 'hidden' while the user is on another browser tab —
            // gating rebind on visibility left the panel stuck on the old video).
            setInterval(() => {
                rebindToActiveWatchTabInHostWindow().catch(() => {});
                if (document.visibilityState === 'visible') {
                    pollCurrentVideo();
                }
            }, TIMEOUT_CONFIG.VIDEO_POLL_RATE);

            checkMetadataImmediate();
            loadWatchLaterList(); // Load global watch later list
            loadCountdowns(); // Load global countdowns limit
        }
    } catch (err) {
        console.error("[STABILITY_V3] Critical initialization failed:", err);
    }
});

window.addEventListener('beforeunload', () => {
    // Notify content script that panel is closed (not for preview mode — never opened)
    if (panelMode !== 'preview') {
        const closingTabId = Number.isInteger(boundTabId) ? boundTabId : null;
        if (closingTabId !== null) {
            safeSendMessage(closingTabId, { action: 'TAB_PANEL_CLOSED' });
        }
        stopPanelHeartbeat(closingTabId);
    }
    
    // Revoke all blob URLs to prevent memory leaks
    if (state.blobUrls) {
        state.blobUrls.forEach(url => {
            try { URL.revokeObjectURL(url); } catch (e) {
                console.warn('[Panel] Failed to revoke blob URL:', url, e);
            }
        });
        state.blobUrls.clear();
    }
});

// ==========================================
// Memory Leak Prevention: Aggressive Blob Cleanup
// ==========================================

// FIX #1: Periodic cleanup of orphaned blob URLs (runs every 60 seconds)
setInterval(() => {
    const allBlobUrls = new Set();

    // Collect all blob URLs currently in use by screenshots
    state.screenshots.forEach(shot => {
        if (shot.dataUrl && shot.dataUrl.startsWith('blob:')) {
            allBlobUrls.add(shot.dataUrl);
        }
    });

    // Revoke any tracked blobs not in current state (orphans)
    state.blobUrls.forEach(trackedBlob => {
        if (!allBlobUrls.has(trackedBlob)) {
            try {
                URL.revokeObjectURL(trackedBlob);
                state.blobUrls.delete(trackedBlob);
                console.debug('[Panel] Revoked orphan blob URL:', trackedBlob);
            } catch (e) {
                console.debug('[Panel] Failed to revoke orphan blob:', trackedBlob, e);
            }
        }
    });
}, 60000);

// FIX #2: Unified Visibility & Focus Management
let isPanelVisible = true;
let visibilityCheckTimeout = null;

function handlePanelVisibilityChange(newState) {
    if (visibilityCheckTimeout) clearTimeout(visibilityCheckTimeout);
    
    visibilityCheckTimeout = setTimeout(() => {
        if (newState === isPanelVisible) return;
        
        isPanelVisible = newState;
        if (!isPanelVisible) {
            console.log("[Visibility] Panel hidden/blurred - executing cleanup");
            performPanelHiddenCleanup();
        } else {
            console.log("[Visibility] Panel visible/focused - executing rehydration");
            rehydrateActiveScreenshots();
        }
    }, 150); // 150ms debounce to filter rapid duplicate events
}

function performPanelHiddenCleanup() {
    const BLOB_MAX_AGE_MS = 5 * 60 * 1000;
    const now = Date.now();
    let revokedCount = 0;
    
    state.screenshots.forEach(shot => {
        if (shot.dataUrl && shot.dataUrl.startsWith('blob:') && shot.createdAt && (now - shot.createdAt) > BLOB_MAX_AGE_MS) {
            try { 
                URL.revokeObjectURL(shot.dataUrl); 
                state.blobUrls.delete(shot.dataUrl); 
                revokedCount++; 
            } catch (e) { /* ignore */ }
            shot.dataUrl = null; // Mark as null to force rehydration when visible again
            console.log(`[Rehydrate] Revoked blob URL for older screenshot: ${shot.filename}`);
        }
    });
    
    // Revoke any orphaned tracked blobs
    state.blobUrls.forEach(trackedBlob => {
        const stillUsed = state.screenshots.some(s => s.dataUrl === trackedBlob);
        if (!stillUsed) {
            try { URL.revokeObjectURL(trackedBlob); } catch (e) { /* ignore */ }
            state.blobUrls.delete(trackedBlob);
        }
    });

    if (revokedCount > 0) {
        console.debug('[Panel] Revoked', revokedCount, 'blob URLs and cleared references on tab background');
    }
}

// Register multiple triggers for visibility state transitions
document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    handlePanelVisibilityChange(visible);
    if (visible && panelMode !== 'preview') {
        rebindToActiveWatchTabInHostWindow();
    }
});

window.addEventListener('pageshow', () => {
    handlePanelVisibilityChange(true);
    if (panelMode !== 'preview') {
        rebindToActiveWatchTabInHostWindow();
    }
});

window.addEventListener('pagehide', () => {
    handlePanelVisibilityChange(false);
});

window.addEventListener('focus', () => {
    handlePanelVisibilityChange(true);
    if (panelMode !== 'preview') {
        rebindToActiveWatchTabInHostWindow();
    }
});

window.addEventListener('blur', () => {
    // Avoid false positives when user focuses on an input element inside the panel
    setTimeout(() => {
        if (!document.hasFocus() && document.visibilityState === 'hidden') {
            handlePanelVisibilityChange(false);
        }
    }, 50);
});

// Surgical, targeted re-hydration helper
let rehydrationSweepTimer = null;
function scheduleRehydrationSweep(options = {}) {
    // Debounced follow-up so a cancelled/stranded task is always picked up
    // without spawning overlapping tasks that cancel each other in a loop.
    if (rehydrationSweepTimer) return;
    rehydrationSweepTimer = setTimeout(() => {
        rehydrationSweepTimer = null;
        rehydrateActiveScreenshots(options);
    }, 300);
}

async function rehydrateActiveScreenshots(options = {}) {
    if (!FileSystemModule.dirHandle || !currentVideoId || !currentVideoTitle) return;

    // Check directory permission
    const permOpts = { mode: 'readwrite' };
    if ((await FileSystemModule.dirHandle.queryPermission(permOpts)) !== 'granted') {
        return;
    }

    const isPreview = options.isPreview === true;
    const taskId = ++currentRehydrationTaskId;
    console.log(`[Rehydrate] Started (Task ID: ${taskId})`);

    try {
        // Resolve by videoId first so stale titles cannot miss the folder
        const subFolder = await resolveVideoFolderHandleForVideoId(currentVideoId, currentVideoTitle)
            || await FileSystemModule.getVideoFolderHandle(currentVideoTitle, false, currentVideoId);
        if (!subFolder) {
            console.log(`[Rehydrate] Finished (Task ID: ${taskId}) - No subfolder found`);
            return;
        }

        // Filter screenshots that need rehydration
        const toRehydrate = state.screenshots.filter(shot => {
            if (shot.dataUrl) return false; // Skip if already has a valid Blob URL
            if (currentlyRehydrating.has(shot.id)) {
                console.log(`[Rehydrate] Skipped (already running) for: ${shot.filename}`);
                return false;
            }
            if (shot.loadFailed) return false; // Skip failed to prevent infinite retries
            return !!shot.filename;
        });

        if (toRehydrate.length === 0) {
            // Another (older) task may still be winding down with items in
            // currentlyRehydrating; if it cancels without applying updates those
            // shots would be stranded. Re-check after it settles.
            if (currentlyRehydrating.size > 0) {
                console.log(`[Rehydrate] Task ${taskId} waiting on in-flight shots, scheduling sweep`);
                scheduleRehydrationSweep(options);
            } else {
                console.log(`[Rehydrate] Finished (Task ID: ${taskId}) - Nothing to rehydrate`);
            }
            return;
        }

        // Concurrency limit of 3 to keep UI highly responsive
        const CONCURRENCY_LIMIT = 3;
        const batches = [];
        for (let i = 0; i < toRehydrate.length; i += CONCURRENCY_LIMIT) {
            batches.push(toRehydrate.slice(i, i + CONCURRENCY_LIMIT));
        }

        for (const batch of batches) {
            // Check cancellation before processing the batch
            if (taskId !== currentRehydrationTaskId) {
                console.log(`[Rehydrate] Cancelled (Task ID: ${taskId}) - Obsoleted by a newer task`);
                // Ensure shots this task was about to process are picked up again
                scheduleRehydrationSweep(options);
                return;
            }

            await Promise.all(batch.map(async (shot) => {
                currentlyRehydrating.add(shot.id);
                try {
                    const imgHandle = await subFolder.getFileHandle(shot.filename);
                    const imgFile = await imgHandle.getFile();

                    // A successful disk read is always safe to apply even if a newer
                    // task started meanwhile - only drop it when the screenshot itself
                    // is gone (e.g. video switch cleared state). Cancelling here used
                    // to strand images as transparent placeholders until refresh.
                    const stillExists = state.screenshots.some(s => s.id === shot.id);
                    if (!stillExists) {
                        return;
                    }

                    // If this task is obsolete, the newer task skips in-flight shots;
                    // apply the result and let the newer task handle anything else.
                    if (taskId !== currentRehydrationTaskId) {
                        console.log(`[Rehydrate] Applying late result for ${shot.filename} (task superseded)`);
                    }

                    const blobUrl = URL.createObjectURL(imgFile);

                    shot.dataUrl = blobUrl;
                    delete shot.missingOnDisk;
                    delete shot.loadFailed;
                    state.blobUrls.add(blobUrl);

                    // Update UI element directly
                    if (!isPreview) {
                        const cardImg = document.getElementById(shot.id)?.querySelector('.card-img');
                        if (cardImg) {
                            cardImg.src = blobUrl;
                            cardImg.classList.remove('loading');
                        }
                    } else {
                        const shotIdAttr = shot.id || shot.filename;
                        const previewImgs = document.querySelectorAll(`[data-shot-id="${shotIdAttr}"] .preview-shot-image`);
                        previewImgs.forEach(img => {
                            img.src = blobUrl;
                            img.classList.remove('loading');
                        });
                    }
                } catch (e) {
                    console.error(`[Rehydrate] Failed for ${shot.filename}:`, e);
                    shot.loadFailed = true;

                    // Show missing placeholder immediately
                    if (!isPreview) {
                        const cardImg = document.getElementById(shot.id)?.querySelector('.card-img');
                        if (cardImg) {
                            cardImg.src = MISSING_SCREENSHOT_PLACEHOLDER_DATA_URL;
                            cardImg.classList.remove('loading');
                        }
                    } else {
                        const shotIdAttr = shot.id || shot.filename;
                        const previewImgs = document.querySelectorAll(`[data-shot-id="${shotIdAttr}"] .preview-shot-image`);
                        previewImgs.forEach(img => {
                            img.src = MISSING_SCREENSHOT_PLACEHOLDER_DATA_URL;
                            img.classList.remove('loading');
                        });
                    }
                } finally {
                    currentlyRehydrating.delete(shot.id);
                }
            }));
        }

        // After a full pass, sweep again if anything is still missing (e.g. shots
        // skipped because they were in-flight when this task filtered).
        const stillNeeds = state.screenshots.some(s =>
            !s.dataUrl && !s.loadFailed && s.filename && !currentlyRehydrating.has(s.id)
        );
        if (stillNeeds && taskId === currentRehydrationTaskId) {
            console.log(`[Rehydrate] Finished (Task ID: ${taskId}) - Scheduling follow-up sweep`);
            scheduleRehydrationSweep(options);
        } else {
            console.log(`[Rehydrate] Finished (Task ID: ${taskId})`);
        }
    } catch (err) {
        console.error(`[Rehydrate] Error (Task ID: ${taskId}):`, err);
    }
}

// --- UI Utilities ---
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Force reflow
    toast.offsetHeight;

    toast.classList.add('show');

    // Auto-remove after configured duration
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), TIMEOUT_CONFIG.TOAST_REMOVE_DELAY);
    }, TIMEOUT_CONFIG.TOAST_DURATION);
}

/**
 * GLOBAL STABILITY HELPER: Prevents TypeError: Cannot set properties of null (setting 'innerHTML')
 */
function safeSetInnerHTML(idOrEl, html) {
    const el = (typeof idOrEl === 'string') ? document.getElementById(idOrEl) : idOrEl;
    if (!el) {
        // Silently return since we intentionally removed some UI elements (like Timeline TOC)
        return false;
    }
    try {
        el.innerHTML = html;
        return true;
    } catch (e) {
        console.error(`[STABILITY] Failed to set innerHTML.`, e, idOrEl);
        return false;
    }
}

// --- Image Similarity (dHash) ---
/**
 * Calculates a 64-bit Difference Hash (dHash) for an image.
 * Resizes to 9x8, grayscales, and compares adjacent pixels.
 */
async function calculateDHash(dataUrl, precomputedBlob = null) {
    // PERFORMANCE: Use createImageBitmap with resize to avoid decoding full-resolution image.
    // Falls back to Image-based approach if createImageBitmap is unavailable.
    const WIDTH = 9;
    const HEIGHT = 8;

    async function computeHashFromBitmap(bitmap) {
        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, WIDTH, HEIGHT);
        bitmap.close(); // Release memory immediately
        const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
        const pixels = imageData.data;
        const gray = [];
        for (let i = 0; i < pixels.length; i += 4) {
            gray.push(0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2]);
        }
        let hash = "";
        for (let y = 0; y < HEIGHT; y++) {
            for (let x = 0; x < WIDTH - 1; x++) {
                hash += (gray[y * WIDTH + x] > gray[y * WIDTH + (x + 1)] ? "1" : "0");
            }
        }
        let hexHash = "";
        for (let i = 0; i < hash.length; i += 4) {
            hexHash += parseInt(hash.substr(i, 4), 2).toString(16);
        }
        return hexHash;
    }

    return new Promise((resolve) => {
        // Fast path: createImageBitmap decodes directly to target size (avoids full-resolution decode)
        if (typeof createImageBitmap === 'function') {
            try {
                // Convert data URL to blob for createImageBitmap
                const blob = precomputedBlob || (() => {
                    const arr = dataUrl.split(',');
                    const mimeMatch = arr[0].match(/:(.*?);/);
                    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                    const bstr = atob(arr[1]);
                    let n = bstr.length;
                    const u8arr = new Uint8Array(n);
                    while (n--) u8arr[n] = bstr.charCodeAt(n);
                    return new Blob([u8arr], { type: mime });
                })();
                createImageBitmap(blob, { resizeWidth: WIDTH, resizeHeight: HEIGHT, resizeQuality: 'low' })
                    .then((bitmap) => computeHashFromBitmap(bitmap))
                    .then(resolve)
                    .catch(() => _dHashViaImage(dataUrl).then(resolve));
                return;
            } catch (e) {
                // Fallback to Image-based approach
            }
        }
        _dHashViaImage(dataUrl).then(resolve);
    });
}

/** Fallback dHash using Image element (slower - decodes full image) */
function _dHashViaImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const width = 9;
            const height = 8;
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            const pixels = imageData.data;
            const gray = [];
            for (let i = 0; i < pixels.length; i += 4) {
                gray.push(0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2]);
            }
            let hash = "";
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width - 1; x++) {
                    hash += (gray[y * width + x] > gray[y * width + (x + 1)] ? "1" : "0");
                }
            }
            let hexHash = "";
            for (let i = 0; i < hash.length; i += 4) {
                hexHash += parseInt(hash.substr(i, 4), 2).toString(16);
            }
            resolve(hexHash);
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

function getHammingDistance(h1, h2) {
    if (!h1 || !h2 || h1.length !== h2.length) return 999;
    let distance = 0;
    for (let i = 0; i < h1.length; i++) {
        const v1 = parseInt(h1[i], 16);
        const v2 = parseInt(h2[i], 16);
        let xor = v1 ^ v2;
        // Count bits
        while (xor > 0) {
            distance += (xor & 1);
            xor >>= 1;
        }
    }
    return distance;
}

function isDuplicate(newHash, options = {}) {
    if (!state.screenshots || state.screenshots.length === 0) {
        if (lastScreenshotHash !== null) {
            console.log("[Duplicate] Hash reset: screenshot list is empty");
        }
        lastScreenshotHash = null;
        return false;
    }
    if (!lastScreenshotHash) return false;

    const ignoreTimeWindow = options.ignoreTimeWindow === true;
    // EXEMPTION: Always allow if enough time has passed (user intentionally took another shot)
    const timeSinceLast = Date.now() - lastScreenshotTime;
    if (!ignoreTimeWindow && timeSinceLast > DUPLICATE_TIME_WINDOW_MS) {
        return false;
    }

    const distance = getHammingDistance(newHash, lastScreenshotHash);
    console.log(`[dHash] Distance: ${distance}, Time: ${timeSinceLast}ms (Threshold: >${DUPLICATE_HASH_THRESHOLD})`);
    
    const duplicateMatch = distance <= DUPLICATE_HASH_THRESHOLD;
    if (duplicateMatch) {
        console.log(`[Duplicate] Match found: distance ${distance} <= threshold ${DUPLICATE_HASH_THRESHOLD}`);
    }
    return duplicateMatch;
}

function isMissingFileSystemEntryError(err) {
    if (!err) return false;
    const name = String(err.name || '');
    const msg = String(err.message || '');
    if (name === 'NotFoundError') return true;
    return /not\s*found/i.test(msg) || /requested file or directory/i.test(msg);
}

function isPermissionDeniedFileSystemError(err) {
    if (!err) return false;
    const name = String(err.name || '');
    const msg = String(err.message || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') return true;
    return /denied/i.test(msg) || /permission/i.test(msg) || /allowed/i.test(msg);
}

// Centralize communication with content script to handle SPA navigation race conditions
async function sendMessageWithRetry(tabId, message, maxRetries = 10, delayMs = 500) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await new Promise((resolve) => {
                chrome.tabs.sendMessage(tabId, message, (res) => {
                    const err = chrome.runtime.lastError;
                    // If no response or connection error, resolve to null (which triggers retry)
                    resolve(err ? null : res);
                });
            });

            if (response !== null) {
                return response; // Success
            }
        } catch (e) {
            // Suppress error
        }

        // Wait before retrying (shorter delay for faster failure)
        await new Promise(r => setTimeout(r, i === 0 ? 100 : delayMs));
    }

    // Final failure
    return null;
}

function isYouTubeWatchUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        const host = (parsed.hostname || '').toLowerCase();
        if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) return false;
        if (parsed.pathname !== '/watch') return false;
        return parsed.searchParams.has('v');
    } catch (_) {
        return false;
    }
}

function shouldTrackSenderTab(tab) {
    if (!tab || !Number.isInteger(tab.id)) return false;

    // Once bound (side panel query/session or detached URL), never track foreign tabs.
    if (Number.isInteger(boundTabId)) {
        if (tab.id !== boundTabId) return false;
        return !tab.url || isYouTubeWatchUrl(tab.url);
    }

    if (
        Number.isInteger(hostWindowId) &&
        Number.isInteger(tab.windowId) &&
        tab.windowId !== hostWindowId
    ) {
        return false;
    }

    return isYouTubeWatchUrl(tab.url);
}

function isSenderOurBoundTab(sender) {
    const srcTabId = sender?.tab?.id;
    if (!Number.isInteger(srcTabId)) return false;
    const bound = getBoundTabId();
    if (Number.isInteger(bound)) return srcTabId === bound;
    if (Number.isInteger(currentTabId)) return srcTabId === currentTabId;
    return shouldTrackSenderTab(sender.tab);
}

async function getValidatedWatchTab(tabId) {
    if (!Number.isInteger(tabId)) return null;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && isYouTubeWatchUrl(tab.url)) {
            return tab;
        }
    } catch (e) {
        // Tab may have been closed or doesn't exist - silent expected failure
        console.debug('[Panel] Tab not found or inaccessible:', tabId, e);
    }
    return null;
}

function extractVideoIdFromWatchUrl(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get('v') || '';
    } catch (_) {
        return '';
    }
}

function pickBestYouTubeWatchTab(candidates) {
    const list = Array.isArray(candidates) ? candidates.filter(tab => isYouTubeWatchUrl(tab?.url)) : [];
    if (!list.length) return null;

    const scored = list.map((tab) => {
        let score = 0;
        if (Number.isInteger(boundTabId) && tab.id === boundTabId) score += 300;
        if (Number.isInteger(hostWindowId) && tab.windowId === hostWindowId) score += 150;
        if (Number.isInteger(currentTabId) && tab.id === currentTabId) score += 80;
        if (currentVideoId && extractVideoIdFromWatchUrl(tab.url) === currentVideoId) score += 120;
        return { tab, score };
    });

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return Number(b.tab?.lastAccessed || 0) - Number(a.tab?.lastAccessed || 0);
    });

    return scored[0]?.tab || null;
}

async function seekActiveYouTubeTab(timeMs) {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return false;
    chrome.tabs.sendMessage(tabId, { action: 'seekTo', timeMs });
    return true;
}

function handleActiveTabChangedPayload(message, sendResponse = null) {
    if (panelMode === 'preview') {
        console.log('[TabFollow][Panel] activeTabChanged ignored (preview)');
        return;
    }
    const actWinId = Number.isInteger(Number(message.windowId)) && Number(message.windowId) > 0
        ? Number(message.windowId)
        : null;
    if (Number.isInteger(hostWindowId) && Number.isInteger(actWinId) && actWinId !== hostWindowId) {
        console.log('[TabFollow][Panel] activeTabChanged ignored (window mismatch)', { hostWindowId, actWinId });
        return;
    }
    // Left YouTube (New Tab / other site) — close this panel.
    if (message.isWatch === false) {
        console.log('[TabFollow][Panel] activeTabChanged → close (not watch)', { panelMode, isDetachedPanel });
        closeNativePanelBecauseNoWatchTab();
        if (sendResponse) sendResponse({ success: true });
        return;
    }
    const actTabId = Number(message.tabId);
    if (!Number.isInteger(actTabId) || actTabId <= 0) {
        console.log('[TabFollow][Panel] activeTabChanged ignored (bad tabId)', message.tabId);
        return;
    }
    // Different tab: hard-reload (native document reuse) or soft rebind (detached).
    if (actTabId !== boundTabId || actTabId !== currentTabId) {
        console.log('[TabFollow][Panel] activeTabChanged → follow new tab', {
            actTabId, boundTabId, currentTabId, panelMode
        });
        if (isDetachedPanel) {
            // Popup window: soft rebind keeps window bounds; preserve mode=detached.
            rebindToActiveWatchTabInHostWindow().then((changed) => {
                console.log('[TabFollow][Panel] detached rebind result', changed);
                if (sendResponse) sendResponse({ success: true, rebind: changed });
            });
            return true;
        }
        forceReloadPanelForTab(actTabId, actWinId);
        if (sendResponse) sendResponse({ success: true, reloading: true });
        return;
    }
    console.log('[TabFollow][Panel] activeTabChanged → soft rebind (ids match)', { actTabId, panelMode });
    rebindToActiveWatchTabInHostWindow().then((changed) => {
        console.log('[TabFollow][Panel] soft rebind result', changed);
        if (changed && sendResponse) sendResponse({ success: true });
    });
}

function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === 'activeTabChanged' || message?.type === 'CONTENT_READY') {
            console.log('[TabFollow][Panel] onMessage', message.action || message.type, {
                from: sender?.id ? 'ext' : (sender?.tab?.id ?? 'sw/none'),
                message
            });
        }
        // Keep tab binding stable in detached mode; avoid drifting to unrelated YouTube tabs.
        if (sender && sender.tab && shouldTrackSenderTab(sender.tab)) {
            currentTabId = sender.tab.id;
        }

        if (message.type === 'CONTENT_READY') {
            // Ignore relays from other tabs/windows. Bound panels only act on their tab.
            const srcTabId = Number.isInteger(message.tabId) ? message.tabId : null;
            const bound = getBoundTabId();
            if (Number.isInteger(bound) && srcTabId !== null && srcTabId !== bound) {
                return;
            }
            if (Number.isInteger(bound) && srcTabId === null) {
                // No tab stamp (legacy): allow same-video refresh only; never hijack video switch.
                if (message.videoId && currentVideoId && message.videoId !== currentVideoId) {
                    return;
                }
            }
            if (!Number.isInteger(bound) && srcTabId !== null && Number.isInteger(currentTabId) && srcTabId !== currentTabId) {
                return;
            }

            console.log("Sidepanel: Content Script signaled READY for", message.videoId);
            // If it's a NEW video, trigger a video switch immediately
            if (message.videoId && currentVideoId !== message.videoId) {
                console.log("Sidepanel: CONTENT_READY triggered video switch:", currentVideoId, "->", message.videoId);
                currentVideoId = message.videoId;
                currentVideoTitle = null;
                isDataLoadedForId = null;
                loadInFlightForId = null;
                titleUsedForLoad = null;
                clearVideoStateUI();
            }
            // Always check metadata for the current video
            checkMetadataImmediate();
            // Late-injected content has no memory of the notebook toggle — push current state.
            syncNotebookStateToContent(isNotebookEnabled);
        } else if (message.action === 'activeTabChanged') {
            // SW fired when the user switched browser tabs.
            console.log('[TabFollow][Panel] msg activeTabChanged', {
                msg: message,
                boundTabId, currentTabId, currentVideoId, hostWindowId,
                panelMode, isDetachedPanel,
                loc: window.location.search
            });
            const handledTs = Number(message.ts);
            if (Number.isFinite(handledTs)) {
                if (handledTs <= lastAppliedTabSignalTs) return;
                lastAppliedTabSignalTs = handledTs;
            } else {
                // Message path without ts — still mark as applied so storage replay is ignored.
                lastAppliedTabSignalTs = Date.now();
            }
            handleActiveTabChangedPayload(message, sendResponse);
            return true;
        } else if (message.action === 'shortcutPressed') {
            // Only the panel bound to the source tab may run shortcuts.
            if (!isSenderOurBoundTab(sender)) return;
            if (message.key === 's') {
                handleCapture();
            } else if (message.key === 'z') {
                openLastScreenshotNote();
            } else if (message.key === 't') {
                handleAddTOC();
            } else if (message.key === 'a') {
                handleAreaCapture();
            } else if (message.key === 'e') {
                editLastScreenshot();
            } else if (message.key === '+') {
                handleAddWatchLaterRequest(message.metadata);
            }
        } else if (message.type === 'NOTE_SYNCED') {
            // Scope to this panel's video; other windows editing other videos must not apply.
            if (message.videoId && currentVideoId && message.videoId !== currentVideoId) {
                return;
            }
            // Same video in two windows: only the panel bound to the originating tab applies.
            const noteSrcTab = Number.isInteger(message.tabId) ? message.tabId : null;
            if (noteSrcTab !== null) {
                const noteBound = getBoundTabId() ?? (Number.isInteger(currentTabId) ? currentTabId : null);
                if (noteBound !== null && noteSrcTab !== noteBound) return;
            }
            const { shotId, html } = message;
            const card = document.getElementById(shotId);
            if (card) {
                const ed = card.querySelector('.note-editor');
                if (ed) {
                    ed.innerHTML = html;
                    // Ensure visual states are correct
                    const container = card.querySelector('.note-container');
                    if (container) container.classList.add('visible');
                    const btn = card.querySelector('.notes-toggle-btn');
                    if (btn) btn.classList.add('active');
                }
            }
            // Update the data in state array too
            const shot = state.screenshots.find(s => s.id === shotId);
            if (shot) shot.noteHtml = html;
        } else if (message.type === 'PLAYBACK_RATE_CHANGED') {
            // Only the bound tab's player events may reset this panel's auto-shot state.
            if (!autoScreenshotActive || autoScreenshotMode !== 'frame' || !isSenderOurBoundTab(sender)) return;
            console.log(`[AutoShot] Playback rate changed to ${message.playbackRate}x, resetting frame hash`);
            lastAutoFrameHash = null;
            cachedPlaybackRate = message.playbackRate; // Update cache immediately
            lastPlaybackRateFetch = Date.now();
        } else if (message.type === 'VIDEO_SEEKED') {
            if (!autoScreenshotActive || autoScreenshotMode !== 'frame' || !isSenderOurBoundTab(sender)) return;
            console.log(`[AutoShot] Video seeked to ${formatTime(message.currentTimeMs)}, resetting frame hash`);
            lastAutoFrameHash = null;
        } else if (message.action === 'screenshotEdited') {
            if (message.videoId && currentVideoId && message.videoId !== currentVideoId) {
                return;
            }
            const shotSrcTab = Number.isInteger(message.tabId) ? message.tabId : null;
            if (shotSrcTab !== null) {
                const shotBound = getBoundTabId() ?? (Number.isInteger(currentTabId) ? currentTabId : null);
                if (shotBound !== null && shotSrcTab !== shotBound) return;
            }
            console.log("Sidepanel: Screenshot edited result received for", message.shotId);
            handleScreenshotEditedResult(message.shotId, message.dataUrl);
            if (sendResponse) sendResponse({ success: true });
        } else if (message.action === 'requestEditState') {
            // Wrong video: do not respond — let the correct panel answer.
            if (message.videoId && currentVideoId && message.videoId !== currentVideoId) {
                return false;
            }
            const editSrcTab = Number.isInteger(message.tabId) ? message.tabId : null;
            if (editSrcTab !== null) {
                const editBound = getBoundTabId() ?? (Number.isInteger(currentTabId) ? currentTabId : null);
                if (editBound !== null && editSrcTab !== editBound) {
                    return false;
                }
            }
            (async () => {
                const shot = state.screenshots.find(s => s.id === message.shotId);
                if (!shot || !shot.dataUrl) {
                    if (sendResponse) sendResponse({ success: false });
                    return;
                }
                let dataUrl = shot.dataUrl;
                if (typeof dataUrl === 'string' && dataUrl.startsWith('blob:')) {
                    dataUrl = await ensureDataUrlFromBlob(dataUrl, message.shotId);
                }
                if (sendResponse) {
                    sendResponse({
                        success: !!dataUrl,
                        dataUrl: dataUrl || null,
                        timeFormatted: shot.timeFormatted || null
                    });
                }
            })();
            return true;
        }
    });

    // Fallback: SW also writes lastActiveTabSignal to session storage —
    // runtime.sendMessage can miss a suspended/hidden side-panel document.
    try {
        if (chrome.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName !== 'session' || !changes?.lastActiveTabSignal) return;
                const sig = changes.lastActiveTabSignal.newValue;
                if (!sig || !Number.isFinite(Number(sig.ts))) return;
                if (Number(sig.ts) <= Number(lastAppliedTabSignalTs || 0)) return;
                lastAppliedTabSignalTs = Number(sig.ts);
                console.log('[TabFollow][Panel] storage.signal', sig);
                handleActiveTabChangedPayload(sig, null);
            });
        }
    } catch (e) {
        console.warn('[TabFollow][Panel] storage.onChanged unavailable:', e);
    }
}

async function handleScreenshotEditedResult(shotId, newDataUrl) {
    const shot = state.screenshots.find(s => s.id === shotId);
    if (!shot) return;

    // 1. Update In-Memory State
    shot.dataUrl = newDataUrl;

    // 2. Update UI Thumbnail
    const cardImg = document.getElementById(shotId)?.querySelector('.card-img');
    if (cardImg) cardImg.src = newDataUrl;

    // 3. Overwrite file on disk
    if (currentVideoId && shot.filename) {
        try {
            const titleForFolder = state.metadata.videoTitle || currentVideoTitle || "Untitled";
            let folderHandle = await resolveVideoFolderHandleForVideoId(currentVideoId, titleForFolder);
            if (!folderHandle) {
                folderHandle = await FileSystemModule.getVideoFolderHandle(titleForFolder, true, currentVideoId);
            }
            if (folderHandle) {
                const blob = await (await fetch(newDataUrl)).blob();
                const saved = await FileSystemModule.saveFile(shot.filename, blob, folderHandle);
                if (!saved) {
                    showFolderPermissionBannerIfNeeded();
                }
            } else {
                showFolderPermissionBannerIfNeeded();
            }
        } catch (diskErr) {
            console.error("Failed to overwrite edited file:", diskErr);
        }
    }

    // 4. Persist State JSON
    saveVideoState(currentVideoId);
}

// Helper for immediate triggered metadata check
async function checkMetadataImmediate() {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return;

    // Increased retry count for immediate check to handle initialization
    const response = await sendMessageWithRetry(tabId, { action: 'getMetadata' }, 5, 400);
    if (response && response.videoId) {
        // Only accept metadata from the tab we asked.
        handleMetadataResponse(response);
    }
}

function handleMetadataResponse(response) {
    if (!response || !response.videoId) return;

    const rawTitle = String(response.title || '').trim();
    // Reject notification/homepage junk titles: "(11) YouTube", bare "YouTube", etc.
    if (/^\(\d+\)\s*YouTube$/i.test(rawTitle) || rawTitle === 'YouTube') {
        return;
    }
    // Reject non-watch URLs when provided.
    if (response.url && !isYouTubeWatchUrl(response.url)) {
        return;
    }

    // Better generic check: skip if it's literally just "YouTube" or "YouTube Video"
    const isGeneric = !rawTitle ||
        rawTitle === "YouTube Video" ||
        rawTitle === "";

    // Update basic metadata info in DOM
    const titleForUI = response.title || "Loading...";
    document.getElementById('video-title').textContent = titleForUI;
    document.getElementById('video-details').textContent = response.channel || "";

    // Update global tracking state â€” always accept non-generic titles
    if (response.title && !isGeneric) {
        currentVideoTitle = response.title;
        currentVideoId = response.videoId;
    }

    // CRITICAL: Only trigger LOAD if it's a new video and NOT the placeholder "YouTube / YouTube Video"
    // loadInFlightForId prevents duplicate concurrent loads while a retry is still running.
    if (isDataLoadedForId !== response.videoId && !isGeneric && loadInFlightForId !== response.videoId) {
        debugLog("Sidepanel: Real metadata detected, loading state for", response.videoId, "Title:", response.title);

        cachedTranscriptSegments = null; // Clear cached transcript on video change

        // Reset Notebook toggle to OFF by default for new videos
        // It will be turned back ON if loadVideoState finds an existing folder/state.
        setNotebookToggleState(false);

        // Update global tracking state fully
        currentVideoId = response.videoId;
        currentVideoTitle = response.title;
        state.metadata.videoId = response.videoId;
        state.metadata.videoTitle = response.title;
        state.metadata.videoUrl = response.url;
        state.metadata.channel = response.channel;

        // NOTE: isDataLoadedForId is intentionally NOT set here. It is latched only
        // after loadVideoState reports success/empty so a failed load can retry
        // on the next poll instead of being stuck until a panel refresh.
        titleUsedForLoad = response.title;
        lastScreenshotHash = null; // Reset duplicate detection for new video
        const loadVideoId = response.videoId;
        loadInFlightForId = loadVideoId;
        loadVideoState(loadVideoId, response.title)
            .then((loadStatus) => {
                if (loadInFlightForId === loadVideoId) loadInFlightForId = null;
                if ((loadStatus === 'loaded' || loadStatus === 'empty') && currentVideoId === loadVideoId) {
                    isDataLoadedForId = loadVideoId;
                }
            })
            .catch((err) => {
                if (loadInFlightForId === loadVideoId) loadInFlightForId = null;
                console.warn("Sidepanel: loadVideoState failed, will retry via poll:", err);
            });
    } else if (isDataLoadedForId === response.videoId && !isGeneric && titleUsedForLoad && titleUsedForLoad !== response.title) {
        // Title changed after initial load (e.g., stale SPA title -> real title)
        // Re-load with the correct title to get the right folder
        debugLog("Sidepanel: Title changed after load, re-loading:", titleUsedForLoad, "->", response.title);
        if (loadInFlightForId === response.videoId) return;
        currentVideoTitle = response.title;
        state.metadata.videoTitle = response.title;
        titleUsedForLoad = response.title;
        lastScreenshotHash = null; // Reset duplicate detection
        clearVideoStateUI();
        const reloadVideoId = response.videoId;
        loadInFlightForId = reloadVideoId;
        loadVideoState(reloadVideoId, response.title)
            .then((loadStatus) => {
                if (loadInFlightForId === reloadVideoId) loadInFlightForId = null;
                if ((loadStatus === 'loaded' || loadStatus === 'empty') && currentVideoId === reloadVideoId) {
                    isDataLoadedForId = reloadVideoId;
                }
            })
            .catch(() => {
                if (loadInFlightForId === reloadVideoId) loadInFlightForId = null;
            });
    }
}

// ==========================================
// Local Storage & Theme
// ==========================================
function initTheme() {
    const savedTheme = localStorage.getItem('ynTheme') || 'dark';
    document.body.setAttribute('data-theme', savedTheme);

    document.getElementById('btn-theme').addEventListener('click', () => {
        let current = document.body.getAttribute('data-theme');
        let next = current === 'dark' ? 'light' : 'dark';
        document.body.setAttribute('data-theme', next);
        localStorage.setItem('ynTheme', next);
    });
}

// Custom Prompt Dialog Modal (Supports Text or Choice Selection)
// ==========================================
function showPrompt(message, defaultValue = "", choices = null) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-prompt-overlay');
        const msgEl = document.getElementById('custom-prompt-message');
        const inputEl = document.getElementById('custom-prompt-input');
        const choicesEl = document.getElementById('custom-prompt-choices');
        const btnOk = document.getElementById('custom-prompt-confirm');
        const btnCancel = document.getElementById('custom-prompt-cancel');

        // Setup
        msgEl.textContent = message;
        overlay.classList.remove('hidden');

        if (choices && Array.isArray(choices)) {
            inputEl.classList.add('hidden');
            choicesEl.classList.remove('hidden');
            btnOk.classList.add('hidden'); // OK button redundant for choices
            choicesEl.innerHTML = '';

            // Layout density optimization: Use grid for 4+ options
            if (choices.length >= 4) {
                choicesEl.classList.add('grid-layout');
            } else {
                choicesEl.classList.remove('grid-layout');
            }

            const normalizedChoices = choices.map((choice) => {
                if (choice && typeof choice === 'object') {
                    const value = choice.value ?? choice.label ?? "";
                    const label = choice.label ?? String(value || "");
                    return {
                        value: String(value),
                        label: String(label),
                        icon: choice.icon ? String(choice.icon) : "",
                        description: choice.description ? String(choice.description) : ""
                    };
                }
                const val = String(choice ?? "");
                return { value: val, label: val, icon: "", description: "" };
            });

            normalizedChoices.forEach(choice => {
                const btn = document.createElement('button');
                btn.className = 'choice-btn';
                if (choice.description) btn.classList.add('has-description');
                const iconHtml = choice.icon ? `<span class="choice-icon">${choice.icon}</span>` : '';
                const descriptionHtml = choice.description ? `<span class="choice-description">${choice.description}</span>` : '';
                btn.innerHTML = `${iconHtml}<span class="choice-text"><span class="choice-label">${choice.label}</span>${descriptionHtml}</span>`;
                btn.onclick = () => closeAndResolve(choice.value);
                choicesEl.appendChild(btn);
            });
        } else {
            inputEl.classList.remove('hidden');
            choicesEl.classList.add('hidden');
            btnOk.classList.remove('hidden');
            inputEl.value = defaultValue;
            inputEl.focus();
            inputEl.select();
        }

        // Cleanup function
        const closeAndResolve = (value) => {
            overlay.classList.add('hidden');
            // Remove listeners
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            inputEl.removeEventListener('keydown', onKey);
            resolve(value);
        };

        const onOk = () => closeAndResolve(inputEl.value);
        const onCancel = () => closeAndResolve(null);
        const onKey = (e) => {
            if (e.key === 'Enter') onOk();
            if (e.key === 'Escape') onCancel();
        };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        inputEl.addEventListener('keydown', onKey);
    });
}

/**
 * Premium custom confirm dialog — replaces native browser confirm().
 * Returns true if user clicks OK, false if they click Cancel.
 */
function showConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-prompt-overlay');
        const msgEl = document.getElementById('custom-prompt-message');
        const inputEl = document.getElementById('custom-prompt-input');
        const choicesEl = document.getElementById('custom-prompt-choices');
        const btnOk = document.getElementById('custom-prompt-confirm');
        const btnCancel = document.getElementById('custom-prompt-cancel');

        msgEl.textContent = message;
        inputEl.classList.add('hidden');
        choicesEl.classList.add('hidden');
        btnOk.classList.remove('hidden');
        btnCancel.classList.remove('hidden');
        overlay.classList.remove('hidden');

        const close = (result) => {
            overlay.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };

        const onOk = () => close(true);
        const onCancel = () => close(false);
        const onKey = (e) => {
            if (e.key === 'Enter') onOk();
            if (e.key === 'Escape') onCancel();
        };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey, { once: true });
    });
}

/**
 * Premium custom alert dialog — replaces native browser alert().
 * Shows a message with just an OK button.
 */
function showAlert(message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-prompt-overlay');
        const msgEl = document.getElementById('custom-prompt-message');
        const inputEl = document.getElementById('custom-prompt-input');
        const choicesEl = document.getElementById('custom-prompt-choices');
        const btnOk = document.getElementById('custom-prompt-confirm');
        const btnCancel = document.getElementById('custom-prompt-cancel');

        msgEl.textContent = message;
        inputEl.classList.add('hidden');
        choicesEl.classList.add('hidden');
        btnOk.classList.remove('hidden');
        btnCancel.classList.add('hidden'); // No cancel for alerts
        overlay.classList.remove('hidden');

        const close = () => {
            overlay.classList.add('hidden');
            btnOk.removeEventListener('click', close);
            document.removeEventListener('keydown', onKey);
            btnCancel.classList.remove('hidden'); // Restore for next use
            resolve();
        };

        const onKey = (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') close();
        };

        btnOk.addEventListener('click', close, { once: true });
        document.addEventListener('keydown', onKey, { once: true });
    });
}


async function resolveActiveYouTubeTabId() {
    // Preview is a full-tab viewer — never follows browser tabs.
    if (panelMode === 'preview') {
        return Number.isInteger(boundTabId) ? boundTabId : null;
    }

    // Native AND detached: ONLY the active watch tab in hostWindowId.
    // Never fall back to a background /watch tab (that kept New Tab from closing).
    if (!Number.isInteger(hostWindowId)) {
        if (isDetachedPanel) {
            // windows.getCurrent() in a popup is the popup itself — do not use it.
            return Number.isInteger(boundTabId) ? boundTabId : null;
        }
        try {
            const win = await chrome.windows.getCurrent();
            if (Number.isInteger(win?.id)) hostWindowId = win.id;
        } catch (e) {
            console.debug('[Panel] Failed to adopt host window:', e);
        }
    }
    if (!Number.isInteger(hostWindowId)) {
        return Number.isInteger(boundTabId) ? boundTabId : null;
    }
    try {
        const [active] = await chrome.tabs.query({ active: true, windowId: hostWindowId });
        if (active && Number.isInteger(active.id) && isYouTubeWatchUrl(active.url)) {
            currentTabId = active.id;
            return currentTabId;
        }
    } catch (e) {
        console.debug('[Panel] Failed to query active tab in host window:', e);
    }
    // Active tab is not a YouTube video — do not resurrect a background watch tab.
    return null;
}

async function closeDetachedPanelIfHostMissing() {
    if (!isDetachedPanel || !Number.isInteger(hostWindowId)) return false;
    try {
        await chrome.windows.get(hostWindowId);
        detachedHostMissingCount = 0;
        return false;
    } catch (e) {
        detachedHostMissingCount += 1;
        if (detachedHostMissingCount < 2) {
            return false;
        }
        try {
            window.close();
        } catch (closeErr) {
            console.error('[Panel] Failed to close panel window:', closeErr);
        }
        return true;
    }
}

async function resolveTrackedYouTubeTab() {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return null;
    const tab = await getValidatedWatchTab(tabId);
    if (tab) {
        return tab;
    }
    if (currentTabId === tabId) {
        currentTabId = null;
    }
    return null;
}

async function sendPanelHeartbeat() {
    if (await closeDetachedPanelIfHostMissing()) return;

    const tabId = await resolveActiveYouTubeTabId() ?? getBoundTabId();
    if (!Number.isInteger(tabId)) return;
    chrome.runtime.sendMessage({ action: 'panelHeartbeat', tabId, panelInstanceId }, () => {
        if (chrome.runtime.lastError) {
            // Ignore background reload races.
        }
    });
}

async function sendPanelClosed(explicitTabId = null) {
    const tabId = Number.isInteger(explicitTabId)
        ? explicitTabId
        : (await resolveActiveYouTubeTabId() ?? getBoundTabId());
    if (!Number.isInteger(tabId)) return;
    chrome.runtime.sendMessage({ action: 'panelClosed', tabId, panelInstanceId }, () => {
        if (chrome.runtime.lastError) {
            // Ignore background reload races.
        }
    });
}

function startPanelHeartbeat() {
    if (panelHeartbeatTimer) {
        clearInterval(panelHeartbeatTimer);
    }
    sendPanelHeartbeat();
    panelHeartbeatTimer = setInterval(sendPanelHeartbeat, 2500);
}

function stopPanelHeartbeat(explicitTabId = null) {
    if (panelHeartbeatTimer) {
        clearInterval(panelHeartbeatTimer);
        panelHeartbeatTimer = null;
    }
    sendPanelClosed(explicitTabId);
}


let exportProgressOverlayRef = null;

function ensureExportProgressOverlay() {
    if (exportProgressOverlayRef && document.body.contains(exportProgressOverlayRef)) {
        return exportProgressOverlayRef;
    }

    const overlay = document.createElement('div');
    overlay.id = 'export-progress-overlay';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `
        <div class="modal-content export-progress-modal">
            <div class="export-progress-icon-wrap">
                <svg class="spin export-progress-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                </svg>
            </div>
            <h3 class="export-progress-title">Exporting PDF</h3>
            <p id="export-progress-text" class="export-progress-text">Preparing export...</p>
        </div>
    `;
    document.body.appendChild(overlay);
    exportProgressOverlayRef = overlay;
    return overlay;
}

function showExportProgressDialog(message = "Preparing export...") {
    const overlay = ensureExportProgressOverlay();
    const msg = overlay.querySelector('#export-progress-text');
    if (msg) msg.textContent = message;
    overlay.classList.remove('hidden');
}

function updateExportProgressDialog(message = "Exporting...") {
    const overlay = ensureExportProgressOverlay();
    const msg = overlay.querySelector('#export-progress-text');
    if (msg) msg.textContent = message;
}

function hideExportProgressDialog() {
    const overlay = ensureExportProgressOverlay();
    overlay.classList.add('hidden');
}

// ==========================================
// File System (Local Windows Folder Setup)
// ==========================================
let folderPermissionClickListener = null;

async function handleFolderPermissionRegrantClick(event = null) {
    if (event && event.isTrusted === false) return;
    if (!FileSystemModule.dirHandle) return;
    const hasPerm = await FileSystemModule.verifyPermission(FileSystemModule.dirHandle, true, true);
    if (!hasPerm) return;

    const banner = document.getElementById('folder-status-banner');
    if (banner) {
        banner.classList.remove('show');
    }

    if (folderPermissionClickListener) {
        document.body.removeEventListener('click', folderPermissionClickListener);
        folderPermissionClickListener = null;
    }

    if (currentVideoId && currentVideoTitle) {
        await loadVideoState(currentVideoId, currentVideoTitle);
    }
    // FIX: Reload global lists after permission regrant
    await loadWatchLaterList();
    await loadCountdowns();
}

function showFolderPermissionBanner() {
    const banner = document.getElementById('folder-status-banner');
    if (!banner) return;

    banner.innerHTML = '&#9888; Click anywhere in this panel to reconnect to your Save Folder.';
    banner.classList.add('show');

    if (!folderPermissionClickListener) {
        folderPermissionClickListener = (event) => {
            handleFolderPermissionRegrantClick(event);
        };
        document.body.addEventListener('click', folderPermissionClickListener);
    }
}

function showFolderMissingBanner() {
    const banner = document.getElementById('folder-status-banner');
    if (!banner) return;

    banner.innerHTML = '&#9888; Save Folder is missing or moved. Please click the folder icon (top right) to re-select it.';
    banner.classList.add('show');

    if (folderPermissionClickListener) {
        document.body.removeEventListener('click', folderPermissionClickListener);
        folderPermissionClickListener = null;
    }
}

function showFolderPermissionBannerIfNeeded() {
    if (!FileSystemModule.dirHandle) {
        showFolderMissingBanner();
        return true;
    }
    if (FileSystemModule.permissionNeedsUserGesture) {
        showFolderPermissionBanner();
        return true;
    }
    return false;
}

async function initFileSystem() {
    const banner = document.getElementById('folder-status-banner');

    document.getElementById('btn-select-folder').addEventListener('click', async () => {
        const success = await FileSystemModule.selectTargetFolder();
        if (success) {
            banner.classList.remove('show');
            if (folderPermissionClickListener) {
                document.body.removeEventListener('click', folderPermissionClickListener);
                folderPermissionClickListener = null;
            }
            // Try loading state immediately for the current video now that we have a fresh folder
            if (currentVideoId && currentVideoTitle) await loadVideoState(currentVideoId, currentVideoTitle);
            // Also ensure global lists are loaded
            await loadWatchLaterList();
            await loadCountdowns();
        }
    });

    const fsState = await FileSystemModule.setup();
    if (fsState === false) {
        showFolderMissingBanner();
    } else if (fsState === 'needs_permission') {
        showFolderPermissionBanner();
    } else {
        // Success case (permission granted or already set)
        await loadWatchLaterList();
        await loadCountdowns();
    }
}

// ==========================================
// Tabs & UI
// ==========================================
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const currentBtn = e.currentTarget;
            if (!currentBtn) return;

            // Remove active classes
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            // Add to targeted
            const targetId = currentBtn.getAttribute('data-tab');
            if (targetId) {
                currentBtn.classList.add('active');
                const pane = document.getElementById(targetId);
                if (pane) pane.classList.add('active');

                if (targetId === 'tab-history') {
                    refreshHistory();
                } else if (targetId === 'tab-transcript') {
                    refreshTranscript();
                }
            }
        });
    });
}

function initButtons() {
    // Primary Actions
    const btnCaptureFull = document.getElementById('btn-capture-full');
    const btnCountdownManager = document.getElementById('btn-countdown-manager');
    const btnAddCountdown = document.getElementById('btn-add-countdown');
    const btnExportPDF = document.getElementById('btn-export-pdf');
    const btnPreviewPDF = document.getElementById('btn-preview-pdf');
    const btnClosePreview = document.getElementById('btn-close-preview');
    const btnCopyTranscript = document.getElementById('btn-copy-transcript');
    const btnDeleteAllScreenshots = document.getElementById('btn-delete-all-screenshots');
    const btnExportWatchLater = document.getElementById('btn-export-watch-later');

    // Secondary Actions
    const btnCaptureArea = document.getElementById('btn-capture-area');
    const btnDurationCalc = document.getElementById('btn-duration-calc');
    const btnCreateBoard = document.getElementById('btn-create-board');
    const btnAddImg = document.getElementById('btn-add-image');

    // Listeners
    if (btnCaptureFull) btnCaptureFull.addEventListener('click', handleCapture);
    if (btnCaptureArea) btnCaptureArea.addEventListener('click', handleAreaCapture);
    if (btnDurationCalc) btnDurationCalc.addEventListener('click', handleDurationCalculator);
    if (btnCountdownManager) btnCountdownManager.addEventListener('click', () => {
        const tabBtn = document.querySelector('.tab-btn[data-tab="tab-countdown"]');
        if (tabBtn) tabBtn.click();
    });
    if (btnAddCountdown) btnAddCountdown.addEventListener('click', handleAddCountdownPrompt);

    if (btnExportPDF) btnExportPDF.addEventListener('click', handleExportPDF);
    if (btnExportWatchLater) btnExportWatchLater.addEventListener('click', handleExportWatchLaterPDF);
    if (btnPreviewPDF) btnPreviewPDF.addEventListener('click', handlePreviewPDF);
    if (btnClosePreview) btnClosePreview.addEventListener('click', closePdfPreviewModal);

    const previewOverlay = document.getElementById('pdf-preview-overlay');
    if (previewOverlay) {
        previewOverlay.addEventListener('click', (e) => {
            if (e.target === previewOverlay) {
                closePdfPreviewModal();
            }
        });
    }

    if (btnCopyTranscript) btnCopyTranscript.addEventListener('click', copyTranscriptToClipboard);

    // Transcript Copy Mode Handlers
    const copyModeSelect = document.getElementById('transcript-copy-mode');
    const intervalSelect = document.getElementById('transcript-interval-select');
    const rangeInputs = document.getElementById('transcript-range-inputs');
    const copyBtnText = document.getElementById('copy-btn-text');
    const copyStatus = document.getElementById('copy-status');

    // Restore saved preferences
    chrome.storage.local.get(['transcriptCopyMode', 'transcriptIntervalValue'], (data) => {
        if (copyModeSelect && data.transcriptCopyMode) {
            copyModeSelect.value = data.transcriptCopyMode;
            // Trigger change to update UI
            copyModeSelect.dispatchEvent(new Event('change'));
        }
        // intervalSelect value will be restored after markers are populated (handled in updateIntervalSelect)
    });

    if (copyModeSelect) {
        copyModeSelect.addEventListener('change', () => {
            const mode = copyModeSelect.value;
            if (intervalSelect) intervalSelect.classList.toggle('hidden', mode !== 'interval');
            if (rangeInputs) rangeInputs.classList.toggle('hidden', mode !== 'range');
            if (copyBtnText) copyBtnText.textContent = mode === 'all' ? 'Copy All' : 'Copy';
            // Save preference
            chrome.storage.local.set({ transcriptCopyMode: mode });
        });
    }

    // Save interval selection when changed
    if (intervalSelect) {
        intervalSelect.addEventListener('change', () => {
            chrome.storage.local.set({ transcriptIntervalValue: intervalSelect.value });
        });
    }

    if (btnCreateBoard) btnCreateBoard.addEventListener('click', handleCreateBoard);
    if (btnDeleteAllScreenshots) btnDeleteAllScreenshots.addEventListener('click', handleDeleteAllScreenshotsForCurrentVideo);

    const timelineTrack = document.querySelector('.timeline-track');
    if (timelineTrack) {
        timelineTrack.addEventListener('click', async (e) => {
            const rect = timelineTrack.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            const durationMs = state?.metadata?.durationMs || 0;
            if (durationMs <= 0) return;
            const seekMs = Math.round(pct * durationMs);
            await seekActiveYouTubeTab(seekMs);
        });
    }

    if (document.getElementById('btn-set-interval')) {
        document.getElementById('btn-set-interval').addEventListener('click', handleSetInterval);
    }

    // TOC Modal Setup
    const tocModal = document.getElementById('toc-modal-overlay');
    const tocModalClose = document.getElementById('toc-modal-close');
    const tocModalCloseBottom = document.getElementById('toc-modal-close-bottom');

    if (document.getElementById('btn-toc')) {
        document.getElementById('btn-toc').addEventListener('click', () => {
            renderTOCModal();
            if (tocModal) tocModal.classList.remove('hidden');
        });
    }

    if (tocModalClose) tocModalClose.addEventListener('click', () => tocModal.classList.add('hidden'));
    if (tocModalCloseBottom) tocModalCloseBottom.addEventListener('click', () => tocModal.classList.add('hidden'));
    if (tocModal) tocModal.addEventListener('click', (e) => {
        if (e.target === tocModal) tocModal.classList.add('hidden');
    });

    if (btnAddImg) btnAddImg.addEventListener('click', () => document.getElementById('input-add-image').click());

    const inputAddImg = document.getElementById('input-add-image');
    if (inputAddImg) inputAddImg.addEventListener('change', handleAddLocalImage);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const tag = document.activeElement?.tagName?.toLowerCase();
        const isEditable = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable;
        if (isEditable) return;

        const key = e.key.toLowerCase();
        if (key === 's') {
            e.preventDefault();
            handleCapture();
        } else if (key === 'z') {
            e.preventDefault();
            openLastScreenshotNote();
        } else if (key === 't') {
            e.preventDefault();
            handleAddTOC();
        } else if (key === 'a') {
            e.preventDefault();
            handleAreaCapture();
        } else if (key === 'e') {
            e.preventDefault();
            editLastScreenshot();
        } else if (key === '+') {
            handleAddWatchLaterRequest();
        }
    });
}

// Populate interval select when markers change
function updateIntervalSelect() {
    const intervalSelect = document.getElementById('transcript-interval-select');
    console.log("[DEBUG] updateIntervalSelect called, element:", intervalSelect);
    if (!intervalSelect) return;
    const markers = state.intervalMarkers || [];
    console.log("[DEBUG] markers count:", markers.length);
    intervalSelect.innerHTML = '<option value="">Select Marker Range</option>';
    if (markers.length === 0) return;

    const durationMs = state.metadata.durationMs || 0;
    // Add option for start to first marker
    const firstMarkerTime = (markers[0].percentage / 100) * durationMs;
    const firstOpt = document.createElement('option');
    firstOpt.value = `0-${firstMarkerTime}`;
    firstOpt.textContent = `Start to Marker ${markers[0].number}`;
    intervalSelect.appendChild(firstOpt);

    // Add options for each interval range (marker N to marker N+1)
    markers.forEach((marker, idx) => {
        const startTime = (marker.percentage / 100) * durationMs;
        const endTime = idx < markers.length - 1
            ? (markers[idx + 1].percentage / 100) * durationMs
            : durationMs;
        const opt = document.createElement('option');
        opt.value = `${startTime}-${endTime}`;
        opt.textContent = `Marker ${marker.number} to ${idx < markers.length - 1 ? 'Marker ' + markers[idx + 1].number : 'End'}`;
        intervalSelect.appendChild(opt);
    });
    // Add option for all markers range
    if (markers.length > 0) {
        const allOpt = document.createElement('option');
        allOpt.value = `${((markers[0].percentage / 100) * durationMs)}-${durationMs}`;
        allOpt.textContent = 'All Markers to End';
        intervalSelect.appendChild(allOpt);
    }
    
    // Restore saved interval selection if available
    chrome.storage.local.get('transcriptIntervalValue', (data) => {
        if (data.transcriptIntervalValue) {
            // Check if the saved value exists in the options
            const options = Array.from(intervalSelect.options).map(opt => opt.value);
            if (options.includes(data.transcriptIntervalValue)) {
                intervalSelect.value = data.transcriptIntervalValue;
            }
        }
    });
}

function openLastScreenshotNote() {
    if (state.screenshots.length === 0) return;

    // Ensure the sidepanel window itself is focused
    window.focus();

    // Sort screenshots by creation time to ensure we get the "last" one taken
    const shots = [...state.screenshots].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lastShot = shots[shots.length - 1];

    const card = document.getElementById(lastShot.id);
    if (card) {
        const noteContainer = card.querySelector('.note-container');
        const notesBtn = card.querySelector('.notes-toggle-btn');
        const editor = card.querySelector('.note-editor');

        if (noteContainer && notesBtn && editor) {
            const focusEditor = () => {
                editor.focus();
                // Place caret at the end
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            };

            if (!noteContainer.classList.contains('visible')) {
                notesBtn.click(); // This opens. notesBtn listener already has focus logic, 
                                 // but we'll reinforce it to be sure.
                setTimeout(focusEditor, 50); 
            } else {
                focusEditor();
            }
        }

        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function editLastScreenshot() {
    if (state.screenshots.length === 0) return;
    const shots = [...state.screenshots].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lastShot = shots[shots.length - 1];
    if (lastShot) {
        openScreenshotEditor(lastShot.id);
    }
}

// ---------------------------------------------------------
// Secondary Action Handlers (WIP)
// ---------------------------------------------------------
async function handleAreaCapture() {
    if (isCapturing) return; // Guard at top before expensive async task queries
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return;

    const btn = document.getElementById('btn-capture-area');
    const originalText = btn.innerHTML;

    const resetBtn = () => {
        isCapturing = false;
        btn.innerHTML = originalText;
        btn.disabled = false;
    };

    try {
        isCapturing = true;
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
        btn.disabled = true;

        if (!isNotebookEnabled) {
            showToast("Notebook is OFF. Turn it ON to enable capturing.", "warning");
            resetBtn();
            return;
        }

        const targetVideoId = currentVideoId;
        const targetVideoTitle = currentVideoTitle;

        if (!targetVideoId || !targetVideoTitle || targetVideoTitle === "Loading...") {
            showToast("Wait for the video title to load.", "info");
            resetBtn();
            return;
        }

        if (!FileSystemModule.dirHandle) await FileSystemModule.setup();
        if (!FileSystemModule.dirHandle) {
            showToast("Please select a Save Folder first.", "warning");
            resetBtn();
            return;
        }

        // Silent check only. If permission is missing, reconnect flow must come from explicit banner click.
        const hasPerm = await FileSystemModule.verifyPermission(FileSystemModule.dirHandle, true, false);
        if (!hasPerm) {
            showFolderPermissionBannerIfNeeded();
            resetBtn();
            return;
        }

        chrome.tabs.sendMessage(tabId, { action: 'startAreaSelection' }, async (response) => {
            try {
                if (chrome.runtime.lastError || !response || !response.success) {
                    if (response && response.error !== "Cancelled") {
                        showToast("Area capture failed: " + (response.error || "Unknown error"), "error");
                    }
                    resetBtn();
                    return;
                }

                const finalImageData = response.imageData;
                const finalTimeMs = response.currentTimeMs;
                const blob = await dataURLtoBlobAsync(finalImageData);
                const timeF = formatTime(finalTimeMs);
                const safeTimeStr = timeF.replace(/:/g, '-');
                const fileUnique = Date.now().toString().slice(-4);
                const filename = `AreaShot_${safeTimeStr}_${fileUnique}.jpg`;

                const subFolder = await FileSystemModule.getVideoFolderHandle(targetVideoTitle, true, targetVideoId);
                if (subFolder) {
                    const saved = await FileSystemModule.saveFile(filename, blob, subFolder);
                    if (saved && targetVideoId === currentVideoId) {
                        addScreenshotToUI(finalImageData, timeF, finalTimeMs, filename, "", false, null, null, false, blob /* precomputedBlob: skip redundant atob */);
                        await saveVideoState(targetVideoId, targetVideoTitle);
                    } else if (!saved) {
                        showFolderPermissionBannerIfNeeded();
                    }
                } else {
                    showFolderPermissionBannerIfNeeded();
                }
            } finally {
                resetBtn();
            }
        });
    } catch (err) {
        console.error("Area Capture Error:", err);
        resetBtn();
    }
}

async function initAutoShotToggle() {
    const btn = document.getElementById('btn-capture-auto');
    if (!btn) return;

    try {
        const result = await chrome.storage.local.get(['autoScreenshotIntervalSecs', 'autoScreenshotMode']);
        const seconds = parseInt(result.autoScreenshotIntervalSecs) || 0;
        const mode = result.autoScreenshotMode || 'timer';
        
        if (seconds >= 1 || mode === 'frame') {
            startAutoScreenshot(seconds, mode, btn);
        }
    } catch (err) {
        console.warn("Failed to load Auto-Shot state:", err);
    }

    btn.addEventListener('click', handleAutoScreenshotToggle);
}

/**
 * Get cached playback rate for dynamic interval adjustment.
 * Refreshes every PLAYBACK_RATE_CACHE_MS (5 seconds) to balance accuracy and performance.
 * @returns {Promise<number>} Current playback rate (defaults to 1.0 on error)
 */
async function getCachedPlaybackRate() {
    if (!autoScreenshotActive || autoScreenshotMode !== 'frame') {
        return 1.0;
    }
    
    // Return cached value if still fresh
    if (Date.now() - lastPlaybackRateFetch < PLAYBACK_RATE_CACHE_MS) {
        return cachedPlaybackRate;
    }
    
    // Fetch fresh playback rate from video
    try {
        const tab = await resolveTrackedYouTubeTab();
        if (tab) {
            const stateResponse = await sendMessageWithRetry(tab.id, { action: 'getState' }, 1, 0);
            if (stateResponse?.playbackRate) {
                cachedPlaybackRate = stateResponse.playbackRate;
                lastPlaybackRateFetch = Date.now();
                console.log(`[AutoShot] Playback rate: ${cachedPlaybackRate}x`);
            }
        }
    } catch (e) {
        console.debug('[AutoShot] Failed to fetch playback rate:', e);
    }
    
    return cachedPlaybackRate;
}

function startAutoScreenshot(seconds, mode, btn) {
    if (autoScreenshotInterval) clearTimeout(autoScreenshotInterval);

    autoScreenshotMode = mode || 'timer';
    const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 10;
    autoScreenshotIntervalMs = autoScreenshotMode === 'frame' ? BASE_FRAME_INTERVAL_MS : (safeSeconds * 1000);
    autoScreenshotActive = true;
    lastAutoFrameHash = null;
    cachedPlaybackRate = 1.0; // Reset playback rate cache
    lastPlaybackRateFetch = 0;

    const scheduleNext = async (delayMs) => {
        if (!autoScreenshotActive) return;
        
        // Dynamic interval adjustment for frame mode based on playback speed
        let nextIntervalMs = autoScreenshotIntervalMs;
        if (autoScreenshotMode === 'frame') {
            const playbackRate = await getCachedPlaybackRate();
            nextIntervalMs = BASE_FRAME_INTERVAL_MS / playbackRate;
        }
        
        autoScreenshotInterval = setTimeout(async () => {
            if (!autoScreenshotActive) return;
            const tickStart = Date.now();
            try {
                if (isVideoPlaying && document.visibilityState === 'visible') {
                    await handleCapture(true); // Auto-shot
                }
            } catch (err) {
                console.warn("[AutoShot] Capture loop error:", err);
            }
            const elapsed = Date.now() - tickStart;
            const nextDelay = Math.max(0, nextIntervalMs - elapsed);
            scheduleNext(nextDelay);
        }, delayMs);
    };

    // Start loop after the configured interval
    const initialDelay = autoScreenshotMode === 'frame' ? BASE_FRAME_INTERVAL_MS : autoScreenshotIntervalMs;
    scheduleNext(initialDelay);

    // Record start time for auto-screenshot session
    lastAutoScreenshotTime = Date.now();

    btn.classList.add('primary');
    if (autoScreenshotMode === 'frame') {
        btn.title = `Auto Screenshot ON (Frame Change) - Click to Stop`;
    } else {
        btn.title = `Auto Screenshot ON (Every ${safeSeconds}s) - Click to Stop`;
    }

    chrome.storage.local.set({
        autoScreenshotIntervalSecs: safeSeconds,
        autoScreenshotMode: autoScreenshotMode
    });
}

function handleAutoScreenshotToggle(e) {
    const btn = e.currentTarget;
    if (autoScreenshotInterval) {
        clearTimeout(autoScreenshotInterval);
        autoScreenshotInterval = null;
        autoScreenshotActive = false;
        lastAutoScreenshotTime = 0; // Reset auto-screenshot timer
        lastAutoFrameHash = null;
        cachedPlaybackRate = 1.0; // Reset playback rate cache
        lastPlaybackRateFetch = 0;
        btn.classList.remove('primary');
        btn.title = "Toggle Auto Screenshot";
        chrome.storage.local.remove(['autoScreenshotIntervalSecs', 'autoScreenshotMode']);
        console.log("Auto Screenshot STOPPED.");
    } else {
        (async () => {
            const mode = await showPrompt("Choose Auto-Screenshot Mode:", "timer", [
                { label: "Fixed Interval", value: "timer", icon: "\u23F3", description: "Capture every X seconds (skips duplicates)" },
                { label: "Frame Change Detection", value: "frame", icon: "\uD83C\uDF9E", description: "Capture automatically on visual movement" }
            ]);
            if (!mode) return;

            let seconds = 0;
            if (mode === 'timer') {
                const input = await showPrompt("Enter Auto-Screenshot interval (e.g., '10s' or '1m'). Min 1s:", "10s");
                if (!input) return;

                const match = input.toLowerCase().match(/^(\d+)([sm]?)$/);
                if (match) {
                    const val = parseInt(match[1]);
                    const unit = match[2] || 's';
                    if (unit === 'm') seconds = val * 60;
                    else seconds = val;
                } else if (!isNaN(input)) {
                    seconds = parseInt(input);
                }

                if (seconds < 1) {
                    showToast("Invalid interval. Minimum 1s required.", "error");
                    return;
                }
            }

            startAutoScreenshot(seconds, mode, btn);
            console.log(`Auto Screenshot ENABLED mode: ${mode} interval: ${seconds}s.`);
        })();
    }
}

async function handleDurationCalculator() {
    await openDurationCalculator();
}

function syncNotebookStateToContent(isOn) {
    const enabled = !!isOn;

    // Scope to the bound tab only — never write a global ynNotebookEnabled key
    // (that reflected the toggle into every YouTube window/tab).
    resolveActiveYouTubeTabId().then((tabId) => {
        if (!Number.isInteger(tabId)) return;
        // Prefer the exact tab that signaled CONTENT_READY when available.
        const targetTabId = Number.isInteger(boundTabId) ? boundTabId : tabId;
        chrome.tabs.sendMessage(targetTabId, { action: 'setNotebookEnabled', enabled }, () => {
            if (chrome.runtime.lastError) {
                // Content script may not be injected yet; panel re-syncs on CONTENT_READY / next toggle.
            }
        });
    });
}

function initOptInToggle() {
    const toggle = document.getElementById('toggle-notebook');

    // DEFAULT: Always OFF on startup/tab load unless found by loadVideoState
    setNotebookToggleState(false);

    toggle.addEventListener('change', (e) => {
        setNotebookToggleState(!!e.target.checked);
        lastScreenshotHash = null;
        console.log("[Duplicate] Hash reset: Notebook toggle changed");
        if (isNotebookEnabled && currentVideoId && FileSystemModule.dirHandle) {
            // If they just turned it on, auto-save state to create the folder immediately
            saveVideoState(currentVideoId);
        }
    });
}

// ==========================================
// Video Integration Polling
// ==========================================
let isPollInProgress = false; 
/**
 * Single-execution check for video status.
 * Called periodically by DOMContentLoaded's visibility-aware interval.
 */
async function pollCurrentVideo() {
    if (isPollInProgress) return;
    isPollInProgress = true;

    try {
        // Follow tab switches in this window before reading the locked bound tab.
        const rebound = await rebindToActiveWatchTabInHostWindow();
        if (rebound) {
            console.log('[TabFollow][Panel] poll rebound before resolve', { boundTabId, currentVideoId });
        }

        const tab = await resolveTrackedYouTubeTab();
        if (tab && isYouTubeWatchUrl(tab.url)) {
            disconnectedPollCount = 0;
            currentTabId = tab.id;
            
            // Detect video change from URL instantly
            try {
                const urlObj = new URL(tab.url);
                const urlParams = new URLSearchParams(urlObj.search);
                const urlVideoId = urlParams.get('v');

                if (urlVideoId && currentVideoId !== urlVideoId) {
                    console.log("Sidepanel: Instant URL-based navigation detected:", urlVideoId);
                    currentVideoId = urlVideoId;
                    currentVideoTitle = null;
                    isDataLoadedForId = null;
                    loadInFlightForId = null;
                    titleUsedForLoad = null;
                    clearVideoStateUI();
                }
            } catch (urlErr) {
                // Only log if it's a truly invalid URL, not just one with timestamp params (&t=)
                if (!tab.url || !tab.url.includes('youtube.com/watch')) {
                    console.warn("Invalid URL in poll check:", tab.url);
                }
            }

            // Fetch metadata when title is missing OR the last load did not latch
            // (failed/empty-with-stale-title). This is the self-healing retry path
            // that used to be blocked forever by a truthy stale title.
            if (!currentVideoTitle || (isDataLoadedForId !== currentVideoId && loadInFlightForId !== currentVideoId)) {
                const metaResponse = await sendMessageWithRetry(currentTabId, { action: 'getMetadata' }, 3, 200);
                if (metaResponse) {
                    handleMetadataResponse(metaResponse);
                }
            }

            // Quick check for playback state
            const stateResponse = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 1, 0);
            if (stateResponse) {
                isVideoPlaying = stateResponse.isPaused === false;
                updateTimeline(stateResponse);

                // Periodic auto-save for resume position
                if (isVideoPlaying && Date.now() - lastAutoSaveTime > AUTO_SAVE_INTERVAL) {
                    lastAutoSaveTime = Date.now();
                    saveVideoState(currentVideoId, currentVideoTitle);
                }
            }
        } else {
            disconnectedPollCount += 1;
            if (disconnectedPollCount >= 2) {
                currentTabId = null;
                isVideoPlaying = false;
                const detailsEl = document.getElementById('video-details');
                if (detailsEl && (!detailsEl.textContent || !detailsEl.textContent.trim() || /reconnecting/i.test(detailsEl.textContent))) {
                    detailsEl.textContent = 'Reconnecting to YouTube tab...';
                }
            }
        }
    } finally {
        isPollInProgress = false;
    }
}

function updateTimeline(vidState) {
    if (!vidState) return;
    const currentStr = formatTime(vidState.currentTimeMs);
    const durStr = formatTime(vidState.durationMs);

    let displayStr = `${currentStr} / ${durStr}`;
    let flagStats = null;

    // Add interval info if active
    const intervalStr = state.metadata.selectedInterval;
    if (intervalStr && intervalStr !== "None") {
        const secs = parseInt(intervalStr, 10);
        if (Number.isFinite(secs) && secs > 0) {
            const intervalMs = secs * 1000;
            let intervalLabel = "";
            if (secs >= 3600) {
                const hours = secs / 3600;
                intervalLabel = `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour`;
                if (hours !== 1) intervalLabel += "s";
            } else if (secs >= 60) {
                const mins = secs / 60;
                intervalLabel = `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min`;
            } else {
                intervalLabel = `${secs} sec`;
            }

            const durationMs = Math.max(0, Number(vidState.durationMs) || 0);
            const currentMs = Math.max(0, Number(vidState.currentTimeMs) || 0);
            const totalFlags = durationMs > 0 ? Math.floor((durationMs - 1) / intervalMs) : 0;
            const completedFlags = totalFlags > 0
                ? Math.min(totalFlags, Math.floor(currentMs / intervalMs))
                : 0;
            const nextFlagNumber = completedFlags + 1;

            let nextFlagLabel = "all done";
            if (nextFlagNumber <= totalFlags) {
                const nextFlagTimeMs = nextFlagNumber * intervalMs;
                const remainingMs = Math.max(0, nextFlagTimeMs - currentMs);
                nextFlagLabel = `#${nextFlagNumber} in ${formatTime(remainingMs)}`;
            }

            displayStr += ` (${intervalLabel} flags, next ${nextFlagLabel})`;
            flagStats = { completedFlags, totalFlags };
        }
    }

    document.getElementById('time-display').textContent = displayStr;

    // Update duration in metadata if it's new
    if (vidState.durationMs > 0 && (!state.metadata.durationMs || Math.abs(state.metadata.durationMs - vidState.durationMs) > 2000)) {
        console.log("Sidepanel: Duration detected/updated:", vidState.durationMs);
        state.metadata.durationMs = vidState.durationMs;
        // Trigger marker generation if we have an active interval
        if (state.metadata.selectedInterval !== "None") {
            generateIntervalMarkers();
        }
    }

    // Use raw MS for percentage for high precision (matches player bar)
    const pct = vidState.durationMs === 0 ? 0 : (vidState.currentTimeMs / vidState.durationMs) * 100;

    document.getElementById('progress-fill').style.width = `${pct}%`;
    const progressEl = document.getElementById('progress-percentage');
    if (progressEl) {
        if (flagStats && flagStats.totalFlags > 0) {
            progressEl.innerHTML = `${Math.round(pct)}% <span class="timeline-flag-count">(${flagStats.completedFlags}/${flagStats.totalFlags})</span>`;
        } else {
            progressEl.textContent = `${Math.round(pct)}%`;
        }
    }
}

// ==========================================
// Action: Screenshot Capture
// ==========================================
async function handleCapture(isAuto = false) {
    if (isCapturing) return; // Guard at top
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return;

    const btn = document.getElementById('btn-capture-full');
    const originalText = btn.innerHTML;

    const resetBtn = () => {
        isCapturing = false;
        btn.innerHTML = originalText;
        btn.disabled = false;
    };

    try {
        isCapturing = true;
        btn.innerHTML = `<span>\u{1F4F7} Capturing...</span>`;
        btn.disabled = true;

        if (!isNotebookEnabled) {
            showToast("Notebook is OFF. Turn it ON to enable capturing.", "warning");
            resetBtn();
            return;
        }

        // LOCK: Capture the current target video ID and title locally
        // This ensures that even if the user navigates while the capture is processing, 
        // the data goes to the correct (old) folder.
        const targetVideoId = currentVideoId;
        const targetVideoTitle = currentVideoTitle;

        if (!targetVideoId || !targetVideoTitle || targetVideoTitle === "Loading...") {
            showToast("Wait for the video title to load.", "info");
            resetBtn();
            return;
        }

        if (!FileSystemModule.dirHandle) {
            console.log("Sidepanel: No dirHandle in memory, attempting setup recovery...");
            await FileSystemModule.setup();
        }

        if (!FileSystemModule.dirHandle) {
            showToast("Please select a Save Folder (top right icon) first.", "warning");
            resetBtn();
            return;
        }

        // Silent check only; manual re-grant is handled by the reconnect banner click.
        const hasPerm = await FileSystemModule.verifyPermission(FileSystemModule.dirHandle, true, false);
        if (!hasPerm) {
            showFolderPermissionBannerIfNeeded();
            resetBtn();
            return;
        }

        // If CCs are enabled, we CANNOT use `canvas.drawImage` because it only grabs the raw video pixels.
        // We MUST force the fallback to `captureVisibleTab` which captures the whole DOM (including CCs).
        let response = null;
        let activeCaptionState = false;
        try {
            const ccOpt = await chrome.storage.local.get('isCaptionEnabled');
            activeCaptionState = !!ccOpt.isCaptionEnabled;
        } catch (e) { activeCaptionState = isCaptionEnabled; }

        // Try content script capture ONLY if CCs are disabled (faster path)
        if (!activeCaptionState) {
            // Reduced retries for faster fallback (2 retries × 300ms = 600ms max wait)
            response = await sendMessageWithRetry(tabId, { action: 'captureScreenshot', includeCaptions: false }, 2, 300);
        }

        try {
            let finalImageData = null;
            let finalTimeMs = 0;

            // If content script failed (usually due to YouTube cross-origin canvas taint) OR if CCs are forced
            if (!response || !response.success) {
                // Silence expected fallback warnings to prevent user alarm
                if (response?.error && !response.error.toLowerCase().includes("blocked") && !response.error.toLowerCase().includes("failed")) {
                    console.warn("Canvas capture failed, falling back to visible tab:", response.error);
                }

                // Fallback: Capture the entire visible tab via Chrome API
                try {
                    // CRITICAL: When detached, we must capture the HOST window, not the panel window
                    const captureWinId = (isDetachedPanel && Number.isInteger(hostWindowId)) ? hostWindowId : null;

                    // Hide captions before capture (non-blocking, best effort)
                    if (!activeCaptionState) {
                        // Fire-and-forget: Don't wait for response, capture immediately
                        chrome.tabs.sendMessage(tabId, { action: 'hideCaptions' }, () => {});
                    }
                    
                    finalImageData = await chrome.tabs.captureVisibleTab(captureWinId, { format: 'jpeg', quality: 90 });
                    
                    // Restore captions after capture (non-blocking)
                    if (!activeCaptionState) {
                        chrome.tabs.sendMessage(tabId, { action: 'showCaptions' }, () => {});
                    }
                    console.log("Sidepanel: Capture successful via fallback (captureVisibleTab) for win:", captureWinId);

                    // We still need the timestamp, so ask the content script just for the state
                    const stateResp = await new Promise(res => chrome.tabs.sendMessage(tabId, { action: 'getState' }, res));
                    finalTimeMs = stateResp ? stateResp.currentTimeMs : 0;

                } catch (fallbackErr) {
                    console.error("Sidepanel: Both capture methods failed", fallbackErr);
                    showToast("Capture failed. Try refreshing YouTube.", "error");
                    return; // Exit inner try, finally will run
                }
            } else {
                // Success from content script natively
                console.log("Sidepanel: Capture successful via native content script canvas");
                finalImageData = response.imageData;
                finalTimeMs = response.currentTimeMs;
            }

            if (!finalImageData) {
                return; // Exit inner try, finally will run
            }

            // --- PERFORMANCE: Compute blob once, then use for both dHash and save ---
            const blob = await dataURLtoBlobAsync(finalImageData);
            const newHash = await calculateDHash(finalImageData, blob);
            const isAutoFrameMode = isAuto && autoScreenshotMode === 'frame';

            // Frame-mode: compare against last sampled frame to detect visual changes
            if (isAutoFrameMode) {
                if (!newHash) {
                    console.warn("[AutoShot] Failed to calculate frame hash.");
                    return;
                }

                if (lastAutoFrameHash) {
                    const sampleDistance = getHammingDistance(newHash, lastAutoFrameHash);
                    if (sampleDistance <= FRAME_CHANGE_HASH_THRESHOLD) {
                        console.log(`[AutoShot] Frame unchanged (distance=${sampleDistance}); skipping.`);
                        lastAutoFrameHash = newHash;
                        return;
                    }
                    console.log(`[AutoShot] Frame changed (distance=${sampleDistance}); capturing.`);
                    lastAutoFrameHash = newHash;
                } else {
                    console.log("[AutoShot] First frame - setting reference.");
                    lastAutoFrameHash = newHash;
                }
            } else {
                if (newHash && isDuplicate(newHash)) {
                    if (isAuto) {
                        console.log("[AutoShot] Skipping duplicate frame.");
                    } else {
                        showToast("Skipping duplicate screenshot.", "info");
                    }
                    return;
                }
            }

            // Yield to browser before expensive I/O operations
            await new Promise(r => setTimeout(r, 0));
            const timeF = formatTime(finalTimeMs);
            const safeTimeStr = timeF.replace(/:/g, '-');
            const fileUnique = Date.now().toString().slice(-4);
            const filename = `Screenshot_${safeTimeStr}_${fileUnique}.jpg`;

            // Save DIRECTLY to local windows sub-folder using the LOCKED target title
            const subFolder = await FileSystemModule.getVideoFolderHandle(targetVideoTitle, true, targetVideoId);

            if (!subFolder) {
                if (!showFolderPermissionBannerIfNeeded()) {
                    showToast("Could not access sub-folder. Check permissions.", "error");
                }
                return; // Exit inner try, finally will run
            }

            const saved = await FileSystemModule.saveFile(filename, blob, subFolder);

            if (saved) {
                console.log("Saved directly to Windows sub-folder:", filename);
                // Only add to UI if we successfully saved to Disk (source of truth)
                // Track auto-screenshot time for scroll suppression
                if (isAuto) {
                    lastAutoScreenshotTime = Date.now();
                }
                // Track screenshot time for duplicate detection exemption
                lastScreenshotTime = Date.now();
                // Let addScreenshotToUI decide auto-scroll behavior (it already detects auto shots).
                addScreenshotToUI(finalImageData, timeF, finalTimeMs, filename, "", false, null, null, false, blob);
                lastScreenshotHash = newHash; // Update tracker for next comparison
            } else {
                // If save failed but didn't throw (retries exhausted or permission lost)
                if (FileSystemModule.permissionNeedsUserGesture) {
                    showFolderPermissionBannerIfNeeded();
                } else if (!FileSystemModule.dirHandle) {
                    showToast("Save folder missing or moved. Please re-select.", "error");
                } else {
                    showToast("Failed to save. Disk might be full or locked.", "error");
                }
            }

        } catch (innerErr) {
            console.error("Capture Logic Error:", innerErr);
            showToast("An error occurred while saving.", "error");
        } finally {
            resetBtn();
        }
    } catch (err) {
        console.error("Capture Error:", err);
        await showAlert("An error occurred starting the capture process.");
        resetBtn();
    }
}

/**
 * Action: Add External Local Image
 * Prompts user for a file, saves it to video folder, and adds to gallery.
 */
async function handleAddLocalImage(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset input so same file can be selected again if deleted
    const inputElement = e.target;

    try {
        if (!FileSystemModule.dirHandle) {
            await FileSystemModule.setup();
        }
        if (!FileSystemModule.dirHandle) {
            await showAlert("Please select a Save Folder (top right icon) first!");
            inputElement.value = '';
            return;
        }

        const targetVideoId = currentVideoId;
        const targetVideoTitle = currentVideoTitle;

        if (!targetVideoId || !targetVideoTitle) {
            await showAlert("Please wait for the video to load before adding images.");
            inputElement.value = '';
            return;
        }

        // Silent check only; permission prompt must happen via explicit reconnect click.
        const hasPerm = await FileSystemModule.verifyPermission(FileSystemModule.dirHandle, true, false);
        if (!hasPerm) {
            showFolderPermissionBannerIfNeeded();
            inputElement.value = '';
            return;
        }

        // 1. Read file as Data URL (for UI/State) and ArrayBuffer (for saving)
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        const arrayBuffer = await file.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: file.type });

        // 2. Prepare filename - unique to avoid overwrites
        const cleanName = file.name.replace(/[^a-z0-9.]/gi, '_');
        const fileUnique = Date.now().toString().slice(-4);
        const filename = `External_${fileUnique}_${cleanName}`;

        // 3. Save to subfolder
        const subFolder = await FileSystemModule.getVideoFolderHandle(targetVideoTitle, true, targetVideoId);
        if (!subFolder) {
            if (!showFolderPermissionBannerIfNeeded()) {
                await showAlert("Could not access video folder.");
            }
            inputElement.value = '';
            return;
        }

        const saved = await FileSystemModule.saveFile(filename, blob, subFolder);
        if (saved) {
            console.log("External image saved to folder:", filename);

            // 4. Get current video time for timestamping
            let currentTimeMs = 0;
            try {
                const stateResp = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 3, 200);
                if (stateResp && stateResp.currentTimeMs) currentTimeMs = stateResp.currentTimeMs;
            } catch (tErr) {
                console.warn('[Panel] Failed to get video time for external image:', tErr);
            }

            const timeF = formatTime(currentTimeMs);

            // 5. Add to UI
            addScreenshotToUI(dataUrl, timeF, currentTimeMs, filename, "<i>External image.</i>", false, null, null, false);

            // Switch to gallery tab
            const tabBtn = document.querySelector('[data-tab="tab-screenshots"]');
            if (tabBtn) tabBtn.click();

            // Auto-save state
            await saveVideoState(targetVideoId, targetVideoTitle);
        } else {
            showFolderPermissionBannerIfNeeded();
        }

    } catch (err) {
        console.error("handleAddLocalImage failed:", err);
        await showAlert("Failed to add image: " + err.message);
    } finally {
        inputElement.value = '';
    }
}


/**
 * Data URL to Blob conversion - CSP compliant version.
 * Uses atob decoding instead of fetch() to avoid CSP violations with data: URLs.
 */
async function dataURLtoBlobAsync(dataurl) {
    return new Promise((resolve, reject) => {
        try {
            // Parse data URL
            const arr = dataurl.split(',');
            if (arr.length < 2) {
                throw new Error('Invalid data URL');
            }
            
            const mimeMatch = arr[0].match(/:(.*?);/);
            if (!mimeMatch) {
                throw new Error('Invalid MIME type in data URL');
            }
            
            const mime = mimeMatch[1];
            const bstr = atob(arr[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            
            resolve(new Blob([u8arr], { type: mime }));
        } catch (err) {
            console.error('[dataURLtoBlobAsync] Conversion failed:', err);
            reject(err);
        }
    });
}

// ==========================================
// Gallery Rendering (Virtualized for Performance)
// ==========================================
const GALLERY_VIRTUALIZATION_THRESHOLD = 50; // Use virtualization for 50+ items
const GALLERY_ITEMS_PER_PAGE = 30; // Batch size for progressive rendering

function renderMainGallery(onComplete = null) {
    const list = document.getElementById('screenshots-list');
    if (!list) return;

    // SCROLL LOCK: Capture current position before wiping the DOM
    const scrollContainer = list.closest('#tab-screenshots') ||
                            list.closest('.tab-pane.scrollable') ||
                            list.closest('.scrollable') ||
                            list.parentElement;
    const currentScroll = scrollContainer ? scrollContainer.scrollTop : 0;

    list.innerHTML = '';

    const sortedShots = [...state.screenshots].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const sortedToc = sortTOCByCreated(state.toc);

    const items = [
        ...sortedShots.map(s => ({ ref: s, type: 'screenshot', sortVal: s.createdAt || 0 })),
        ...sortedToc.map(t => ({ ref: t, type: 'toc', sortVal: t.createdAt || 0 }))
    ];

    items.sort((a, b) => a.sortVal - b.sortVal);

    if (items.length === 0) {
        const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
        list.innerHTML = `<div class="empty-state">${svgIcon}<p>No screenshots or markers yet.</p></div>`;
        if (onComplete) onComplete();
        return;
    }

    const finalizeRendering = () => {
        // SCROLL LOCK: Restore position before user notices the jump
        // Only restore if we had a non-zero scroll previously to avoid fighting auto-scroll-on-load
        if (scrollContainer && currentScroll > 0) {
            scrollContainer.scrollTop = currentScroll;
        }
        
        // Use a frame delay for onComplete to ensure browser has processed the DOM additions
        if (onComplete) {
            requestAnimationFrame(() => {
                onComplete();
            });
        }
    };

    // For large galleries, use progressive rendering to prevent UI hang
    if (items.length > GALLERY_VIRTUALIZATION_THRESHOLD) {
        renderGalleryProgressively(list, items, finalizeRendering);
    } else {
        renderGalleryImmediate(list, items);
        finalizeRendering();
    }
}

function renderGalleryImmediate(list, items) {
    const fragment = document.createDocumentFragment();
    let shotCounter = 1;
    
    items.forEach(item => {
        if (item.type === 'screenshot') {
            const card = createScreenshotCard(item.ref, shotCounter++);
            fragment.appendChild(card);
        } else {
            const tocElement = createTOCGalleryElement(item.ref);
            fragment.appendChild(tocElement);
        }
    });
    
    list.appendChild(fragment);
}

function renderGalleryProgressively(list, items, onComplete = null) {
    // Show loading indicator
    list.innerHTML = `<div class="empty-state"><p>Loading ${items.length} items...</p></div>`;

    let currentIndex = 0;
    let shotCounter = 1;

    function renderNextBatch() {
        const batch = items.slice(currentIndex, currentIndex + GALLERY_ITEMS_PER_PAGE);
        if (batch.length === 0) {
            if (onComplete) onComplete();
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach(item => {
            if (item.type === 'screenshot') {
                const card = createScreenshotCard(item.ref, shotCounter++);
                fragment.appendChild(card);
            } else {
                const tocElement = createTOCGalleryElement(item.ref);
                fragment.appendChild(tocElement);
            }
        });

        // Remove loading indicator on first batch
        if (currentIndex === 0) {
            list.innerHTML = '';
        }

        list.appendChild(fragment);
        currentIndex += GALLERY_ITEMS_PER_PAGE;

        // Schedule next batch if more items
        if (currentIndex < items.length) {
            requestAnimationFrame(renderNextBatch);
        } else {
            // Finished rendering all batches
            if (onComplete) onComplete();
        }
    }

    // Start rendering
    requestAnimationFrame(renderNextBatch);
}

function createTOCGalleryElement(entry) {
    const level = normalizeTOCLevel(entry.level);
    entry.level = level;
    const item = document.createElement('div');
    item.className = `toc-gallery-item toc-gallery-${level.toLowerCase()}`;
    item.dataset.createdAt = entry.createdAt;
    item.id = entry.id;
    item.innerHTML = `
        <div class="toc-indicator"></div>
        <div class="toc-content">
            <div class="toc-header">
                <span class="toc-level-chip">${level}</span>
                <select class="toc-level-select hidden" title="Heading Level">
                    <option value="H1" ${level === 'H1' ? 'selected' : ''}>H1</option>
                    <option value="H2" ${level === 'H2' ? 'selected' : ''}>H2</option>
                    <option value="H3" ${level === 'H3' ? 'selected' : ''}>H3</option>
                </select>
                <span class="toc-tag">MARKER</span>
                <span class="toc-time-btn" title="Seek to this moment">${entry.timeFormatted}</span>
                <div class="toc-spacer"></div>
                <div class="toc-actions">
                    <button class="toc-action-btn toc-edit-btn" title="Edit Marker">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 20h9"></path>
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
                        </svg>
                    </button>
                    <button class="toc-action-btn toc-save-btn hidden" title="Save Marker">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                    <button class="toc-action-btn toc-cancel-btn hidden" title="Cancel Edit">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                    <button class="toc-action-btn toc-delete-btn" title="Delete Marker">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="toc-title" contenteditable="false" spellcheck="false">${entry.title}</div>
        </div>
    `;

    item.querySelector('.toc-time-btn').addEventListener('click', () => {
        seekActiveYouTubeTab(entry.timestampMs);
    });

    const titleEdit = item.querySelector('.toc-title');
    const levelChip = item.querySelector('.toc-level-chip');
    const levelSelect = item.querySelector('.toc-level-select');
    const editBtn = item.querySelector('.toc-edit-btn');
    const saveBtn = item.querySelector('.toc-save-btn');
    const cancelBtn = item.querySelector('.toc-cancel-btn');

    let isEditing = false;
    let originalTitle = entry.title;
    let originalLevel = level;

    const placeCaretAtEnd = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    };

    const applyLevelVisual = (nextLevel) => {
        const normalized = normalizeTOCLevel(nextLevel);
        entry.level = normalized;
        item.className = `toc-gallery-item toc-gallery-${normalized.toLowerCase()}${isEditing ? ' is-editing' : ''}`;
        levelChip.textContent = normalized;
        levelSelect.value = normalized;
    };

    const setEditMode = (enabled) => {
        isEditing = enabled;
        item.classList.toggle('is-editing', enabled);
        titleEdit.contentEditable = enabled ? 'true' : 'false';
        levelChip.classList.toggle('hidden', enabled);
        levelSelect.classList.toggle('hidden', !enabled);
        editBtn.classList.toggle('hidden', enabled);
        saveBtn.classList.toggle('hidden', !enabled);
        cancelBtn.classList.toggle('hidden', !enabled);
        if (enabled) {
            titleEdit.focus();
            placeCaretAtEnd(titleEdit);
        }
    };

    const saveEdit = () => {
        const nextTitle = String(titleEdit.innerText || '').trim();
        if (!nextTitle) {
            showToast("Marker title cannot be empty.", "warning");
            titleEdit.focus();
            return;
        }

        entry.title = nextTitle;
        applyLevelVisual(levelSelect.value);
        setEditMode(false);
        // renderMainGallery() is redundant/harmful here as it resets scroll; the DOM is already updated.
        renderTOCList();
        saveVideoState(currentVideoId);
    };

    const cancelEdit = () => {
        titleEdit.innerText = originalTitle;
        applyLevelVisual(originalLevel);
        setEditMode(false);
    };

    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        originalTitle = entry.title;
        originalLevel = normalizeTOCLevel(entry.level);
        titleEdit.innerText = originalTitle;
        levelSelect.value = originalLevel;
        setEditMode(true);
    });

    saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        saveEdit();
    });

    cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelEdit();
    });

    titleEdit.addEventListener('keydown', (e) => {
        if (!isEditing) {
            e.preventDefault();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            saveEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    });

    levelSelect.addEventListener('change', () => {
        if (!isEditing) return;
        applyLevelVisual(levelSelect.value);
    });

    item.querySelector('.toc-delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await showConfirm("Delete this marker?")) {
            state.toc = state.toc.filter(t => t.id !== entry.id);
            
            // SURGICAL DELETION: Remove from DOM directly
            const itemEl = document.getElementById(entry.id);
            if (itemEl) {
                itemEl.remove();
                
                // If no items left (including screenshots), show empty state
                const list = document.getElementById('screenshots-list');
                if (list && list.children.length === 0) {
                    const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
                    list.innerHTML = `<div class="empty-state">${svgIcon}<p>No screenshots or markers yet.</p></div>`;
                }
            } else {
                renderMainGallery();
            }

            renderTOCList(); // Still needed to update TOC side-panel list
            saveVideoState(currentVideoId);
        }
    });

    applyLevelVisual(entry.level);
    return item;
}

// The inline note highlighter uses #FFF36A; browsers serialize this differently
// (e.g. #fff36a, rgb(255, 243, 106), background shorthand). We normalize it.
const NOTE_HIGHLIGHT_STYLE_RE = /#fff36a|#ffff00|rgba?\(\s*255\s*,\s*243\s*,\s*106(?:\s*,\s*1(?:\.0+)?)?\s*\)|rgba?\(\s*255\s*,\s*255\s*,\s*0(?:\s*,\s*1(?:\.0+)?)?\s*\)|\byellow\b/i;

function hasNoteHighlightStyle(styleText) {
    return NOTE_HIGHLIGHT_STYLE_RE.test(String(styleText || ''));
}

function syncNoteHighlightNodes(editorEl) {
    if (!editorEl) return;

    editorEl.querySelectorAll('[style], [data-note-highlight]').forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const styleText = node.getAttribute('style') || '';
        if (hasNoteHighlightStyle(styleText)) {
            node.setAttribute('data-note-highlight', '1');
        } else {
            node.removeAttribute('data-note-highlight');
        }
    });
}

function applyNoteToolbarCommand(editorEl, cmd, value) {
    if (!editorEl || !cmd) return;
    editorEl.focus();

    // `backColor` is inconsistent in contenteditable (especially dark UI).
    // Prefer `hiliteColor` then normalize selected highlight nodes.
    if (cmd === 'backColor') {
        const highlightColor = value || '#FFF36A';
        try { document.execCommand('styleWithCSS', false, true); } catch (e) {
            console.debug('[Panel] styleWithCSS command failed:', e);
        }

        let applied = false;
        try { applied = document.execCommand('hiliteColor', false, highlightColor); } catch (e) {
            console.debug('[Panel] hiliteColor command failed:', e);
        }
        if (!applied) {
            try { document.execCommand('backColor', false, highlightColor); } catch (e) {
                console.debug('[Panel] backColor command failed:', e);
            }
        }

        syncNoteHighlightNodes(editorEl);
        return;
    }

    document.execCommand(cmd, false, value || null);
    if (cmd === 'removeFormat') {
        syncNoteHighlightNodes(editorEl);
    }
}

function createScreenshotCard(shot, index) {
    const noteHtml = getScreenshotNoteHtml(shot);
    if (shot.noteHtml !== noteHtml) {
        shot.noteHtml = noteHtml;
    }
    const imageSrc = shot.dataUrl || (shot.missingOnDisk ? MISSING_SCREENSHOT_PLACEHOLDER_DATA_URL : TRANSPARENT_PIXEL_DATA_URL);
    const imageAlt = shot.missingOnDisk
        ? `Missing screenshot file for ${shot.timeFormatted || 'unknown time'}`
        : `Screenshot at ${shot.timeFormatted}`;
    const hasNote = noteHtml && noteHtml.trim().replace(/<[^>]*>/g, '').trim().length > 0;
    const card = document.createElement('div');
    card.className = 'screenshot-card';
    card.dataset.createdAt = shot.createdAt;
    card.id = shot.id;
    card.innerHTML = `
        <div class="card-img-container">
            <img src="${imageSrc}" class="card-img" alt="${imageAlt}" />
        </div>
        <div class="card-controls-bar">
            <div class="card-info">
                <span class="card-time"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${shot.timeFormatted}</span>
                <span class="card-divider">|</span>
                <span class="card-index">#${index}</span>
            </div>
            <div class="card-actions">
                <button class="card-action-btn notes-toggle-btn ${hasNote ? 'active' : ''}" title="Toggle Notes">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                </button>
                <button class="card-action-btn add-cc-btn" title="Add Transcript to Notes">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                </button>
                <button class="card-action-btn expand-btn" title="View in Full Editor">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
                </button>
                <button class="card-action-btn edit-btn" title="Edit Screenshot">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="card-action-btn toc-add-btn" title="Bookmark this moment">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                </button>
                <button class="card-action-btn seek-btn" title="Seek to Timestamp">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <button class="card-action-btn open-btn" title="Download Image">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </button>
                <button class="card-action-btn delete-btn" title="Delete Screenshot">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        </div>
        <div class="note-container ${hasNote ? 'visible' : ''}">
            <div class="note-toolbar">
                <button class="toolbar-btn" data-cmd="bold" title="Bold">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path></svg>
                </button>
                <button class="toolbar-btn" data-cmd="italic" title="Italic">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"></line><line x1="14" y1="20" x2="5" y2="20"></line><line x1="15" y1="4" x2="9" y2="20"></line></svg>
                </button>
                <button class="toolbar-btn" data-cmd="underline" title="Underline">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"></path><line x1="4" y1="21" x2="20" y2="21"></line></svg>
                </button>
                <button class="toolbar-btn" data-cmd="backColor" data-val="#FFF36A" title="Highlight">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#FFF36A" stroke="#888" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
                </button>
                <button class="toolbar-btn" data-cmd="removeFormat" title="Clear Formatting">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="20" y2="20"/><path d="M8.5 14.5L4 19l1.5-4.5"/><path d="M12 3L5.5 17.5"/><path d="M12 3l6.5 14.5"/><path d="M19 9H9"/></svg>
                </button>
                <button class="toolbar-btn list-style-btn" data-marker="→" title="Arrow List">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </button>
                <button class="toolbar-btn list-style-btn" data-marker="✓" title="Check List">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </button>
            </div>
            <div class="note-editor" contenteditable="true" placeholder="Add notes for this screenshot...">${noteHtml}</div>
        </div>
    `;

    const noteContainer = card.querySelector('.note-container');
    const notesBtn = card.querySelector('.notes-toggle-btn');
    notesBtn.addEventListener('click', () => {
        const isVisible = noteContainer.classList.toggle('visible');
        notesBtn.classList.toggle('active', isVisible);
        if (isVisible) {
            const ed = card.querySelector('.note-editor');
            ed.focus();
            const range = document.createRange();
            range.selectNodeContents(ed);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    const editor = card.querySelector('.note-editor');
    syncNoteHighlightNodes(editor);
    card.querySelectorAll('.toolbar-btn:not(.list-style-btn)').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const cmd = btn.getAttribute('data-cmd');
            const val = btn.getAttribute('data-val');
            applyNoteToolbarCommand(editor, cmd, val);
            editor.focus();
        });
    });

    card.querySelectorAll('.list-style-btn').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            editor.focus();
            document.execCommand('insertText', false, btn.getAttribute('data-marker') + ' ');
        });
    });

    card.querySelector('.add-cc-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const btn = e.currentTarget;
        const originalText = btn.innerHTML;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" class="spin" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
        btn.disabled = true;

        try {
            // Feature: Use current playback time instead of shot time if available
            let targetTimeMs = shot.timestampMs;
            try {
                const response = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 5, 200);
                if (response && typeof response.currentTimeMs === 'number') {
                    targetTimeMs = response.currentTimeMs;
                }
            } catch (e) {
                // Fallback to shot.timestampMs
            }

            let segments = await getCachedTranscript();
            if (!segments || segments.length === 0) {
                segments = await getCachedTranscript(true); // Force fetch
            }

            if (!segments || segments.length === 0) {
                showToast("Transcript not available for this video.", "warning");
                return;
            }

            // Get range settings from UI
            const preSec = parseInt(document.getElementById('transcript-before')?.value || '4');
            const postSec = parseInt(document.getElementById('transcript-after')?.value || '5');

            const startTargetMs = targetTimeMs - (preSec * 1000);
            const endTargetMs = targetTimeMs + (postSec * 1000);

            // Filter segments within the [startTargetMs, endTargetMs] window
            const rangeSegments = segments.filter(seg => {
                const segEndMs = seg.timestampMs + (seg.durationMs || 3000); // Assume 3s if duration missing
                return seg.timestampMs <= endTargetMs && segEndMs >= startTargetMs;
            });

            if (rangeSegments.length === 0) {
                showToast("No transcript found for this range.", "warning");
                return;
            }

            // Concatenate text
            const timeLabel = rangeSegments[0].time;
            const fullText = rangeSegments.map(s => s.text).join(' ');

            const htmlToInsert = `<blockquote>\u{1F4AC} [${timeLabel}] ${fullText}</blockquote><br>`;

            if (document.activeElement === editor) {
                document.execCommand('insertHTML', false, htmlToInsert);
            } else {
                editor.innerHTML += (editor.innerHTML ? '<br>' : '') + htmlToInsert;
            }

            editor.dispatchEvent(new Event('input', { bubbles: true }));

            const noteContainer = card.querySelector('.note-container');
            const notesBtn = card.querySelector('.notes-toggle-btn');
            if (noteContainer && !noteContainer.classList.contains('visible') && notesBtn) {
                notesBtn.click();
            }
            showToast("Transcript added to notes!", "success");

        } catch (err) {
            console.error("Failed to add transcript:", err);
            showToast("Failed to get transcript. Try turning CC on for a moment.", "error");
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

    card.querySelector('.expand-btn').addEventListener('click', () => {
        openBigNoteEditor(shot.id, editor);
    });

    card.querySelector('.seek-btn').addEventListener('click', () => {
        seekActiveYouTubeTab(shot.timestampMs);
    });

    card.querySelector('.edit-btn').addEventListener('click', () => {
        openScreenshotEditor(shot.id);
    });

    card.querySelector('.toc-add-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetId = currentVideoId;
        const targetTitle = currentVideoTitle;
        const details = await collectTOCEntryDetails("", 'H2');
        if (!details) return;
        let placement = 'bottom';
        if (state.screenshots.length >= 2) {
            const pickedPlacement = await collectTOCPlacementForScreenshot('bottom');
            if (!pickedPlacement) return;
            placement = pickedPlacement;
        }

        const createdBase = Number(shot.createdAt || Date.now());
        const createdOffset = placement === 'top' ? -0.1 : 0.1;
        const anchoredCreatedAt = createdBase + createdOffset;

        if (targetId === currentVideoId) {
            addTOCToUI(details.title, shot.timeFormatted || formatTime(shot.timestampMs || 0), shot.timestampMs || 0, anchoredCreatedAt, details.level);

            // Switch to Screenshots tab (where markers are now interleaved)
            const tabBtn = document.querySelector('.tab-btn[data-tab="tab-screenshots"]');
            if (tabBtn) tabBtn.click();
        } else {
            const pendingEntry = normalizeTOCRecord({
                id: `toc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                timeFormatted: shot.timeFormatted || formatTime(shot.timestampMs || 0),
                timestampMs: shot.timestampMs || 0,
                title: details.title,
                level: details.level,
                createdAt: anchoredCreatedAt
            });
            state.toc.push(pendingEntry);
            state.toc = sortTOCByCreated(state.toc);
            await saveVideoState(targetId, targetTitle);
        }
    });

    card.querySelector('.open-btn').addEventListener('click', () => {
        openScreenshotInSystemViewer(shot.id);
    });

    card.querySelector('.delete-btn').addEventListener('click', () => {
        deleteScreenshot(shot.id);
    });

    // Debounce timer for note saves
    let noteSaveTimer = null;
    editor.addEventListener('input', () => {
        syncNoteHighlightNodes(editor);

        // Sanitize HTML before saving to prevent XSS
        const sanitizedHtml = sanitizeNoteHtml(editor.innerHTML);

        // Update the ORIGINAL state entry directly via the reference
        shot.noteHtml = sanitizedHtml;

        // SAFETY NET: Also update by ID in case the reference got detached
        const stateEntry = state.screenshots.find(s => s.id === shot.id);
        if (stateEntry && stateEntry !== shot) {
            stateEntry.noteHtml = sanitizedHtml;
        }

        // Debounce save: wait for configured delay after last keystroke before saving to disk
        clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(() => {
            saveVideoState(currentVideoId);
        }, TIMEOUT_CONFIG.AUTO_SAVE_DEBOUNCE);
    });

    editor.addEventListener('keydown', (event) => {
        handleNoteEditorKeydown(event, editor, shot);
    });

    editor.addEventListener('paste', (event) => {
        handleNoteEditorPaste(event, editor, shot);
        setTimeout(() => syncNoteHighlightNodes(editor), 0);
    });

    return card;
}

function startDownload(downloadOptions) {
    return chrome.downloads.download(downloadOptions).then((downloadId) => {
        if (!Number.isInteger(downloadId)) {
            throw new Error("Download failed: missing download id.");
        }
        return downloadId;
    });
}

function waitForDownloadCompletion(downloadId, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            chrome.downloads.onChanged.removeListener(onChanged);
        };

        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };

        const onChanged = (delta) => {
            if (delta.id !== downloadId || !delta.state || !delta.state.current) return;
            if (delta.state.current === 'complete') {
                settle(resolve);
                return;
            }
            if (delta.state.current === 'interrupted') {
                settle(reject, new Error("Download was interrupted before completion."));
            }
        };

        chrome.downloads.onChanged.addListener(onChanged);
        timeoutId = setTimeout(() => {
            settle(reject, new Error("Timed out waiting for download to complete."));
        }, timeoutMs);

        chrome.downloads.search({ id: downloadId }).then((results) => {
            const entry = Array.isArray(results) ? results[0] : null;
            if (!entry) {
                settle(reject, new Error("Download entry not found."));
                return;
            }
            if (entry.state === 'complete') {
                settle(resolve);
                return;
            }
            if (entry.state === 'interrupted') {
                settle(reject, new Error("Download was interrupted before completion."));
            }
        }).catch((err) => {
            settle(reject, new Error(err?.message || "Unable to read download status."));
        });
    });
}

function openCompletedDownload(downloadId) {
    return chrome.downloads.open(downloadId);
}

// Open the screenshot in the system's default image viewer (Windows Photo Viewer, etc.)
async function openScreenshotInSystemViewer(shotId) {
    const shot = state.screenshots.find(s => s.id === shotId);
    if (!shot) return;
    if (shot.missingOnDisk) {
        showToast("Screenshot file is missing from your Save Folder.", "warning");
        return;
    }
    if (!shot.dataUrl) return;

    let tempBlobUrl = null;
    try {
        // Use Downloads API: write a temp file, wait until complete, then open in system app.
        const blob = await (await fetch(shot.dataUrl)).blob();
        tempBlobUrl = URL.createObjectURL(blob);

        const timestamp = Date.now();
        const filename = `screenshot_${shotId}_${timestamp}.png`;
        const downloadId = await startDownload({
            url: tempBlobUrl,
            filename,
            saveAs: false,
            conflictAction: 'overwrite'
        });

        await waitForDownloadCompletion(downloadId);
        await openCompletedDownload(downloadId);
    } catch (err) {
        console.error("Failed to open system viewer:", err);
        showToast("Could not open screenshot. Please try again.", "error");
    } finally {
        if (tempBlobUrl) {
            setTimeout(() => URL.revokeObjectURL(tempBlobUrl), TIMEOUT_CONFIG.BLOB_REVOKE_DELAY);
        }
    }
}

// â”€â”€ Internal Image Editor (Opens in a New Window) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function persistScreenshotEditState(shotId, editState) {
    const key = `edit_state_${shotId}`;
    const trySet = (area, areaName) => new Promise((resolve) => {
        // Clear all other edit states first to keep storage lean
        area.get(null, (all) => {
            const keysToRemove = Object.keys(all || {}).filter(k => k.startsWith('edit_state_'));
            if (keysToRemove.length > 0) {
                area.remove(keysToRemove, () => {
                    area.set({ [key]: editState }, () => {
                        const err = chrome.runtime.lastError;
                        if (err) {
                            console.warn(`[Panel] Failed to set ${key} in ${areaName}:`, err);
                            resolve({ ok: false, error: err, area: areaName });
                            return;
                        }
                        resolve({ ok: true, area: areaName });
                    });
                });
            } else {
                area.set({ [key]: editState }, () => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        console.warn(`[Panel] Failed to set ${key} in ${areaName}:`, err);
                        resolve({ ok: false, error: err, area: areaName });
                        return;
                    }
                    resolve({ ok: true, area: areaName });
                });
            }
        });
    });

    if (chrome.storage?.session) {
        const sessionResult = await trySet(chrome.storage.session, 'session');
        if (sessionResult.ok) return sessionResult;
    }

    if (chrome.storage?.local) {
        return await trySet(chrome.storage.local, 'local');
    }

    return { ok: false, error: new Error('Storage API not available') };
}

async function openScreenshotEditor(shotId) {
    const shot = state.screenshots.find(s => s.id === shotId);
    if (!shot) return;
    if (shot.missingOnDisk) {
        showToast("Screenshot file is missing from your Save Folder.", "warning");
        return;
    }
    if (!shot.dataUrl) return;

    let finalDataUrl = shot.dataUrl;

    // If it's a blob url (from rehydration), we MUST convert it to base64 dataUrl 
    // before passing to a different window, as Blob URLs don't survive cross-window storage boundary.
    if (finalDataUrl.startsWith('blob:')) {
        finalDataUrl = await ensureDataUrlFromBlob(finalDataUrl, shotId);
        if (!finalDataUrl || finalDataUrl.startsWith('blob:')) {
             console.error("Failed to convert blob to dataUrl for editor");
             showToast("Could not prepare image data. Please try again.", "error");
             return;
        }
    }

    // Prepare state for the editor window
    const editState = {
        id: shot.id,
        dataUrl: finalDataUrl,
        timeFormatted: shot.timeFormatted
    };

    const saveResult = await persistScreenshotEditState(shotId, editState);
    if (!saveResult.ok) {
        console.warn("Failed to store edit state for screenshot editor, falling back to live fetch:", saveResult.error);
    }

    // Calculate center position
    const width = Math.min(window.screen.availWidth - 100, 1200);
    const height = Math.min(window.screen.availHeight - 100, 900);
    const left = (window.screen.availWidth - width) / 2;
    const top = (window.screen.availHeight - height) / 2;

    chrome.windows.create({
        url: chrome.runtime.getURL(`sidepanel/editor.html?shotId=${shotId}&videoId=${currentVideoId}&tabId=${getBoundTabId() ?? currentTabId ?? ''}`),
        type: 'popup',
        width: width,
        height: height,
        left: Math.round(left),
        top: Math.round(top),
        focused: true
    }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
            console.error("Failed to open screenshot editor window:", err);
            showToast("Could not open editor window. Please try again.", "error");
        }
    });
}

/**
 * Creates a blank whiteboard or blackboard image and launches the editor.
 */
async function handleCreateBoard() {
    if (!currentVideoId) {
        await showAlert("Please connect to a video first.");
        return;
    }

    const choices = [
        { label: 'Whiteboard (Bright)', value: 'white', icon: '\u2B1C' },
        { label: 'Blackboard (Dark)', value: 'black', icon: '\u2B1B' }
    ];

    const type = await showPrompt('Select board color:', 'white', choices);
    if (!type) return;

    const color = type === 'black' ? '#000000' : '#ffffff';
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let dataUrl = "";
    try {
        dataUrl = canvas.toDataURL('image/png');
    } catch (e) {
        console.error("Board canvas extraction failed:", e);
        dataUrl = TRANSPARENT_PIXEL_DATA_URL; // Fallback
    }
    const blob = await dataURLtoBlobAsync(dataUrl);

    // Get current time from content script
    let timeMs = 0;
    let timeStr = "00:00";
    try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
        if (response) {
            timeMs = response.currentTimeMs;
            timeStr = formatTime(timeMs);
        }
    } catch (e) { console.warn("Failed to get time for board:", e); }

    const id = `shot-${Date.now()}`;
    const fileName = `Board_${type}_at_${timeStr.replace(/:/g, '-')}.png`;

    // Save using standard FileSystemModule
    try {
        if (FileSystemModule.dirHandle) {
            const subFolder = await FileSystemModule.getVideoFolderHandle(currentVideoTitle, true, currentVideoId);
            if (subFolder) {
                const saved = await FileSystemModule.saveFile(fileName, blob, subFolder);
                if (!saved) {
                    showFolderPermissionBannerIfNeeded();
                }
            } else {
                showFolderPermissionBannerIfNeeded();
            }
        }
    } catch (e) {
        console.error("Disk save failed for board:", e);
    }

    const boardTitle = type.charAt(0).toUpperCase() + type.slice(1);
    addScreenshotToUI(dataUrl, timeStr, timeMs, fileName, `<i>[${boardTitle} Board]</i>`, false, id);

    // Auto-open editor
    setTimeout(() => openScreenshotEditor(id), TIMEOUT_CONFIG.EDITOR_OPEN_DELAY);
}

let lastAutoSaveTime = 0;
const AUTO_SAVE_INTERVAL = 30000; // 30 seconds

function normalizeScreenshotRecord(shot, index = 0) {
    const normalized = (shot && typeof shot === 'object') ? { ...shot } : {};
    if (!normalized.id) {
        normalized.id = `shot-restored-${Date.now()}-${index}-${Math.floor(Math.random() * 1000)}`;
    }
    normalized.noteHtml = getScreenshotNoteHtml(normalized);
    if (!Number.isFinite(normalized.createdAt)) {
        const ts = Number(normalized.timestampMs);
        normalized.createdAt = Number.isFinite(ts) ? ts : (Date.now() + index);
    }
    return normalized;
}

// Add screenshot to the UI list and local state
async function addScreenshotToUI(dataUrl, timeStr, timeMs, filename, initialNoteHtml = "", isRestoring = false, existingId = null, existingCreatedAt = null, skipScroll = false, precomputedBlob = null) {
    const shotId = existingId || `shot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let finalDataUrl = dataUrl;
    if (dataUrl && dataUrl.startsWith('data:')) {
        try {
            const blob = await dataURLtoBlobAsync(dataUrl);
            finalDataUrl = URL.createObjectURL(blob);
            state.blobUrls.add(finalDataUrl);
        } catch (e) { console.warn("Blob URL optimization failed", e); }
    }

    const item = {
        id: shotId,
        timestampMs: timeMs,
        timeFormatted: timeStr,
        filename: filename,
        dataUrl: finalDataUrl,
        noteHtml: getScreenshotNoteHtml({ noteHtml: initialNoteHtml }),
        createdAt: existingCreatedAt || Date.now()
    };
    state.screenshots.push(item);

    // Sort by creation time (Capture Order)
    state.screenshots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (!isRestoring) {
        const list = document.getElementById('screenshots-list');
        if (list && list.querySelector('.empty-state')) {
            list.innerHTML = '';
        }

        if (list) {
            // The real scroll container is the tab-pane (.scrollable), NOT the gallery-list
            const scrollContainer = document.getElementById('tab-screenshots') ||
                                    list.closest('.tab-pane.scrollable') ||
                                    list.closest('.scrollable') ||
                                    list.parentElement;

            // Capture scroll metrics BEFORE appending the new card
            const scrollTopBefore = scrollContainer.scrollTop;
            const clientHeight = scrollContainer.clientHeight;
            const scrollHeightBefore = scrollContainer.scrollHeight;
            const wasNearBottom = (scrollHeightBefore - scrollTopBefore - clientHeight) < NEAR_BOTTOM_THRESHOLD;

            // Detect auto-screenshots to suppress scroll thrashing during review
            const isAutoScreenshot = filename.startsWith('AutoShot_') ||
                                     filename.startsWith('AreaShot_') ||
                                     (lastAutoScreenshotTime > 0 && (Date.now() - lastAutoScreenshotTime) < AUTO_SCREENSHOT_DETECT_WINDOW_MS);

            // Manual shots ALWAYS scroll into view. Auto-shots only scroll if near bottom.
            const shouldAutoScroll = !skipScroll && (isAutoScreenshot ? wasNearBottom : true);

            // Insert the new card in sorted order
            const index = state.screenshots.length;
            const card = createScreenshotCard(item, index);
            insertElementSorted(list, card);

            // Scroll to show the new card using direct scrollTop on the real container
            if (shouldAutoScroll) {
                requestAnimationFrame(() => {
                    scrollContainer.scrollTo({
                        top: scrollContainer.scrollHeight,
                        behavior: 'smooth'
                    });
                });
            }
        }
        saveVideoState(currentVideoId);
    } else {
        renderMainGallery();
    }
}

/**
 * Robust vertical scroll that handles dynamic layouts and potential UI lag.
 * Refined for ultra-smooth movement.
 */
function safeScrollToElement(el, behavior = 'smooth') {
    if (!el || !el.isConnected) return;

    // Resolve the true scrolling container: prefer the tab-pane, fall back to nearest scrollable
    const container = el.closest('#tab-screenshots') ||
                      el.closest('.tab-pane.scrollable') ||
                      el.closest('.scrollable') ||
                      el.parentElement;
    if (!container) return;

    requestAnimationFrame(() => {
        // Calculate where the element is relative to the container
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        const containerTop = container.scrollTop;
        const containerBottom = containerTop + container.clientHeight;

        if (elBottom > containerBottom) {
            // Element is below the visible area — scroll it into view at the bottom
            container.scrollTo({
                top: elBottom - container.clientHeight + 16,
                behavior: behavior
            });
        } else if (elTop < containerTop) {
            // Element is above the visible area — scroll it into view at the top
            container.scrollTo({
                top: elTop - 16,
                behavior: behavior
            });
        }
        // else: already fully visible — no scroll needed
    });
}

function normalizeTOCRecord(entry, index = 0) {
    const normalized = (entry && typeof entry === 'object') ? { ...entry } : {};

    if (!normalized.id) {
        normalized.id = `toc-${Date.now()}-${index}-${Math.floor(Math.random() * 1000)}`;
    }

    const rawTitle = String(
        normalized.title ??
        normalized.text ??
        ""
    ).trim();
    normalized.title = rawTitle || `Marker ${index + 1}`;
    normalized.level = normalizeTOCLevel(normalized.level || normalized.heading || normalized.type);

    let ts = Number(normalized.timestampMs);
    if (!Number.isFinite(ts)) ts = Number(normalized.position_ms);
    if (!Number.isFinite(ts)) ts = parseTimeToMs(normalized.timeFormatted || normalized.timestamp || "") ?? 0;
    normalized.timestampMs = Math.max(0, Math.floor(ts));

    const tf = String(normalized.timeFormatted || normalized.timestamp || "").trim();
    normalized.timeFormatted = tf || formatTime(normalized.timestampMs);

    let createdAt = Number(normalized.createdAt);
    if (!Number.isFinite(createdAt)) createdAt = Number(normalized.updatedAt);
    if (!Number.isFinite(createdAt)) createdAt = Date.now() + index;
    normalized.createdAt = Math.floor(createdAt);

    return normalized;
}

function normalizeTOCLevel(level) {
    const lvl = String(level || "").trim().toUpperCase();
    if (lvl === 'H1' || lvl === '1' || lvl === 'LEVEL1') return 'H1';
    if (lvl === 'H2' || lvl === '2' || lvl === 'LEVEL2') return 'H2';
    if (lvl === 'H3' || lvl === '3' || lvl === 'LEVEL3') return 'H3';
    return 'H2';
}

function sortTOCByTimeline(entries) {
    return [...entries].sort((a, b) => {
        const aMs = Number(a?.timestampMs) || 0;
        const bMs = Number(b?.timestampMs) || 0;
        if (aMs !== bMs) return aMs - bMs;

        const aCreated = Number(a?.createdAt) || 0;
        const bCreated = Number(b?.createdAt) || 0;
        return aCreated - bCreated;
    });
}

function sortTOCByCreated(entries) {
    return [...entries].sort((a, b) => {
        const aCreated = Number(a?.createdAt) || 0;
        const bCreated = Number(b?.createdAt) || 0;
        if (aCreated !== bCreated) return aCreated - bCreated;

        const aMs = Number(a?.timestampMs) || 0;
        const bMs = Number(b?.timestampMs) || 0;
        return aMs - bMs;
    });
}

async function promptTOCLevel(defaultLevel = 'H2') {
    const choices = [
        {
            value: 'H1',
            label: 'H1 Main Heading',
            icon: '<span style="font-weight:800;font-size:13px;">H1</span>',
            description: 'Largest title style for major chapter markers.'
        },
        {
            value: 'H2',
            label: 'H2 Section Heading',
            icon: '<span style="font-weight:760;font-size:12px;">H2</span>',
            description: 'Balanced section style for normal marker headings.'
        },
        {
            value: 'H3',
            label: 'H3 Sub Heading',
            icon: '<span style="font-weight:700;font-size:11px;">H3</span>',
            description: 'Compact style for fine-grained points.'
        }
    ];
    const picked = await showPrompt("Select TOC level:", normalizeTOCLevel(defaultLevel), choices);
    if (!picked) return null;
    return normalizeTOCLevel(picked);
}

// â”€â”€ Big Note Editor Overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openBigNoteEditor(shotId, inlineEditor) {
    chrome.runtime.sendMessage({
        action: 'openBigEditor',
        tabId: getBoundTabId() ?? currentTabId,
        shotId: shotId,
        videoId: currentVideoId,
        videoTitle: currentVideoTitle,
        html: inlineEditor.innerHTML
    });
}


function revokeScreenshotBlobUrlIfNeeded(shot) {
    if (!shot || !shot.dataUrl) return;
    if (typeof shot.dataUrl !== 'string') return;
    if (!shot.dataUrl.startsWith('blob:')) return;
    try {
        URL.revokeObjectURL(shot.dataUrl);
    } catch (e) {
        console.debug('[Panel] Failed to revoke screenshot blob URL:', shot.dataUrl, e);
    }
    state.blobUrls.delete(shot.dataUrl);
}

async function deleteScreenshotFilesFromCurrentVideo(shotsToDelete) {
    const sourceShots = Array.isArray(shotsToDelete) ? shotsToDelete : [];
    if (sourceShots.length === 0) {
        return {
            blocked: false,
            reason: null,
            removableIds: [],
            deletedCount: 0,
            missingCount: 0,
            failedCount: 0
        };
    }

    const removableIds = [];
    let deletedCount = 0;
    let missingCount = 0;
    let failedCount = 0;

    const shotsWithFile = sourceShots.filter((shot) => {
        const filename = String(shot?.filename || '').trim();
        return filename.length > 0;
    });

    // In-memory-only screenshots can still be removed from UI/state.
    sourceShots.forEach((shot) => {
        const filename = String(shot?.filename || '').trim();
        if (!filename && shot?.id) removableIds.push(shot.id);
    });

    if (shotsWithFile.length === 0) {
        return {
            blocked: false,
            reason: null,
            removableIds,
            deletedCount,
            missingCount,
            failedCount
        };
    }

    if (!FileSystemModule.dirHandle) {
        return {
            blocked: true,
            reason: 'no_root_handle',
            removableIds,
            deletedCount,
            missingCount,
            failedCount: shotsWithFile.length
        };
    }

    const hasPerm = await FileSystemModule.verifyPermission(FileSystemModule.dirHandle, true, false);
    if (!hasPerm) {
        return {
            blocked: true,
            reason: 'permission',
            removableIds,
            deletedCount,
            missingCount,
            failedCount: shotsWithFile.length
        };
    }

    const targetVideoId = currentVideoId || state.metadata?.videoId || null;
    const targetVideoTitle = currentVideoTitle || state.metadata?.videoTitle || null;
    const subFolder = await FileSystemModule.getVideoFolderHandle(targetVideoTitle, false, targetVideoId);

    // If folder no longer exists, those files are already gone on disk.
    if (!subFolder) {
        shotsWithFile.forEach((shot) => {
            if (shot?.id) removableIds.push(shot.id);
        });
        return {
            blocked: false,
            reason: null,
            removableIds,
            deletedCount,
            missingCount: shotsWithFile.length,
            failedCount
        };
    }

    for (const shot of shotsWithFile) {
        const filename = String(shot?.filename || '').trim();
        if (!filename || !shot?.id) continue;
        try {
            await subFolder.removeEntry(filename);
            removableIds.push(shot.id);
            deletedCount++;
        } catch (err) {
            if (isMissingFileSystemEntryError(err)) {
                removableIds.push(shot.id);
                missingCount++;
                continue;
            }
            if (isPermissionDeniedFileSystemError(err)) {
                return {
                    blocked: true,
                    reason: 'permission',
                    removableIds,
                    deletedCount,
                    missingCount,
                    failedCount: shotsWithFile.length - deletedCount - missingCount
                };
            }
            failedCount++;
            console.warn(`Failed to remove screenshot file "${filename}" from disk:`, err);
        }
    }

    return {
        blocked: false,
        reason: null,
        removableIds,
        deletedCount,
        missingCount,
        failedCount
    };
}

async function deleteScreenshot(shotId) {
    if (!await showConfirm("Delete this screenshot and its notes?")) return;

    const shot = state.screenshots.find(s => s.id === shotId);
    if (!shot) return;

    // FIX: Revoke blob URL BEFORE removing from state to ensure proper cleanup
    revokeScreenshotBlobUrlIfNeeded(shot);

    const diskResult = await deleteScreenshotFilesFromCurrentVideo([shot]);
    if (diskResult.blocked) {
        if (diskResult.reason === 'permission' || diskResult.reason === 'no_root_handle') {
            showFolderPermissionBannerIfNeeded();
        }
        showToast("Could not delete screenshot from local folder. Reconnect folder and try again.", "warning");
        return;
    }

    if (diskResult.failedCount > 0) {
        showToast("Could not delete screenshot file from disk.", "error");
        return;
    }

    state.screenshots = state.screenshots.filter(s => s.id !== shotId);

    // SURGICAL DELETION: Remove from DOM directly to avoid scroll jump
    const cardEl = document.getElementById(shotId);
    if (cardEl) {
        cardEl.remove();
        
        // Update indices of remaining cards to keep them sequential
        const screenshotCards = document.querySelectorAll('.screenshot-card');
        screenshotCards.forEach((card, idx) => {
            const indexEl = card.querySelector('.card-index');
            if (indexEl) indexEl.textContent = `#${idx + 1}`;
        });

        // If no items left (including TOC), show empty state
        const list = document.getElementById('screenshots-list');
        if (list && list.children.length === 0) {
            const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
            list.innerHTML = `<div class="empty-state">${svgIcon}<p>No screenshots or markers yet.</p></div>`;
        }
    } else {
        // Fallback if DOM is out of sync
        renderMainGallery();
    }

    await saveVideoState(currentVideoId, currentVideoTitle);
}

async function handleDeleteAllScreenshotsForCurrentVideo() {
    const totalShots = state.screenshots.length;
    if (totalShots === 0) {
        showToast("No screenshots to delete for this video.", "info");
        return;
    }

    if (!await showConfirm(`Delete ALL ${totalShots} screenshots for this video?\nThis removes local image files and clears the screenshot panel for this video only.`)) {
        return;
    }

    const shotsSnapshot = [...state.screenshots];
    const byId = new Map(shotsSnapshot.map((shot) => [shot.id, shot]));
    const diskResult = await deleteScreenshotFilesFromCurrentVideo(shotsSnapshot);

    if (diskResult.blocked) {
        if (diskResult.reason === 'permission' || diskResult.reason === 'no_root_handle') {
            showFolderPermissionBannerIfNeeded();
        }
        showToast("Could not access local folder to delete screenshots.", "warning");
        return;
    }

    const removableSet = new Set(diskResult.removableIds);
    if (removableSet.size === 0 && diskResult.failedCount > 0) {
        showToast("Delete failed. Some local files could not be removed.", "error");
        return;
    }

    state.screenshots = state.screenshots.filter((shot) => !removableSet.has(shot.id));
    removableSet.forEach((id) => revokeScreenshotBlobUrlIfNeeded(byId.get(id)));

    renderMainGallery();
    await saveVideoState(currentVideoId, currentVideoTitle);

    const removedCount = removableSet.size;
    if (diskResult.failedCount > 0) {
        showToast(`Deleted ${removedCount} screenshot(s); ${diskResult.failedCount} could not be removed from disk.`, "warning");
        return;
    }

    showToast(`Deleted ${removedCount} screenshot(s) for this video.`, "success");
}

// ==========================================
// Action: History Management
// ==========================================
function getSafeFolderNameForTitle(videoTitle) {
    if (FileSystemModule && typeof FileSystemModule.sanitizeFolderName === 'function') {
        return FileSystemModule.sanitizeFolderName(videoTitle);
    }
    let safeName = "Unknown Video";
    if (videoTitle && typeof videoTitle === 'string') {
        safeName = videoTitle.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().substring(0, 100);
    }
    if (!safeName) safeName = "Unknown Video";
    return safeName;
}

function getHistorySortTimestamp(entry) {
    const parsed = Date.parse(entry?.updatedAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function sortHistoryEntries(entries) {
    return entries.sort((a, b) => getHistorySortTimestamp(b) - getHistorySortTimestamp(a));
}

function buildHistoryEntryFromState(vState, folderName) {
    const metadata = vState?.metadata || {};
    const videoId = metadata.videoId || null;
    const videoTitle = metadata.videoTitle || folderName || "Unknown Video";
    const videoUrl = metadata.videoUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "#");
    const channel = metadata.channel || "YouTube";
    const shotCount = Array.isArray(vState?.screenshots) ? vState.screenshots.length : 0;
    const tocCount = Array.isArray(vState?.toc) ? vState.toc.length : 0;
    const updatedAt = vState?.updatedAt || new Date().toISOString();

    return {
        videoId,
        videoTitle,
        videoUrl,
        channel,
        shotCount,
        tocCount,
        folderName,
        updatedAt
    };
}

function normalizeHistoryIndexEntries(rawIndex) {
    const inputEntries = Array.isArray(rawIndex)
        ? rawIndex
        : (Array.isArray(rawIndex?.entries) ? rawIndex.entries : []);

    const normalized = [];
    for (const raw of inputEntries) {
        const folderName = raw?.folderName || getSafeFolderNameForTitle(raw?.videoTitle);
        const shotCountNum = Number(raw?.shotCount);
        const tocCountNum = Number(raw?.tocCount);
        if (!folderName) continue;
        normalized.push({
            videoId: raw?.videoId || null,
            videoTitle: raw?.videoTitle || folderName,
            videoUrl: raw?.videoUrl || (raw?.videoId ? `https://www.youtube.com/watch?v=${raw.videoId}` : "#"),
            channel: raw?.channel || "YouTube",
            shotCount: Number.isFinite(shotCountNum) ? shotCountNum : 0,
            tocCount: Number.isFinite(tocCountNum) ? tocCountNum : 0,
            folderName,
            updatedAt: raw?.updatedAt || new Date().toISOString()
        });
    }
    return sortHistoryEntries(normalized);
}

async function readHistoryIndexEntries() {
    if (!FileSystemModule.dirHandle) return [];
    try {
        const indexHandle = await FileSystemModule.dirHandle.getFileHandle(HISTORY_INDEX_FILENAME);
        const indexFile = await indexHandle.getFile();
        const rawText = await indexFile.text();
        if (!rawText.trim()) return [];
        const parsed = JSON.parse(rawText);
        return normalizeHistoryIndexEntries(parsed);
    } catch (_) {
        return [];
    }
}

async function writeHistoryIndexEntries(entries) {
    if (!FileSystemModule.dirHandle) return false;
    const sortedEntries = sortHistoryEntries(entries);
    const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: sortedEntries
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const saved = await FileSystemModule.saveFile(HISTORY_INDEX_FILENAME, blob);
    if (!saved) {
        if (FileSystemModule.permissionNeedsUserGesture) {
            showFolderPermissionBannerIfNeeded();
        } else if (FileSystemModule.dirHandle) {
            showToast("Failed to update history index. Disk issues?", "error");
        }
    }
    return saved;
}

async function upsertHistoryIndexEntry(vState, folderName) {
    if (!FileSystemModule.dirHandle || !folderName) return;
    const entries = await readHistoryIndexEntries();
    const nextEntry = buildHistoryEntryFromState(vState, folderName);
    const idx = entries.findIndex(e =>
        (nextEntry.videoId && e.videoId === nextEntry.videoId) ||
        e.folderName === folderName
    );
    if (idx >= 0) {
        entries[idx] = { ...entries[idx], ...nextEntry };
    } else {
        entries.unshift(nextEntry);
    }
    const saved = await writeHistoryIndexEntries(entries);
    if (!saved) {
        console.warn("upsertHistoryIndexEntry: Permission lost or folder missing during save.");
    }
}

async function removeHistoryIndexEntry(folderName, videoId = null) {
    if (!FileSystemModule.dirHandle || !folderName) return;
    const entries = await readHistoryIndexEntries();
    const filtered = entries.filter(entry => {
        if (videoId && entry.videoId === videoId) return false;
        return entry.folderName !== folderName;
    });
    const saved = await writeHistoryIndexEntries(filtered);
    if (!saved) {
        console.warn("removeHistoryIndexEntry: Failed to update index after removal.");
    }
}

// True only when the folder's state file explicitly belongs to this videoId.
async function folderStateMatchesVideoId(folderHandle, videoId) {
    try {
        const fh = await folderHandle.getFileHandle(VIDEO_STATE_FILENAME);
        const file = await fh.getFile();
        const text = await file.text();
        if (!text.trim()) return false;
        const parsed = JSON.parse(text);
        return parsed?.metadata?.videoId === videoId;
    } catch (_) {
        return false;
    }
}

/**
 * Resolve a video's folder PRIMARILY by videoId (not the SPA-derived title).
 * Stale YouTube titles during navigation otherwise key the lookup to the wrong
 * folder (or no folder), which used to fail silently until a panel refresh.
 * Order: history index -> title-based strategies (ownership-checked) -> full scan.
 * Returns null when no folder for this videoId exists (does not create).
 */
async function resolveVideoFolderHandleForVideoId(videoId, preferredTitle = null) {
    if (!FileSystemModule.dirHandle || !videoId) return null;

    // Strategy A: history index already maps videoId -> folderName (fast path)
    try {
        const entries = await readHistoryIndexEntries();
        const entry = entries.find(e => e.videoId === videoId && e.folderName);
        if (entry?.folderName) {
            try {
                const handle = await FileSystemModule.dirHandle.getDirectoryHandle(entry.folderName, { create: false });
                if (await folderStateMatchesVideoId(handle, videoId)) {
                    return handle;
                }
                // Index may point at a renamed/legacy folder - fall through to scan
            } catch (_) { /* missing folder - fall through */ }
        }
    } catch (_) { /* unreadable index - fall through */ }

    // Strategy B: title-based lookup (correct once the real title has settled)
    if (preferredTitle) {
        try {
            const handle = await FileSystemModule.getVideoFolderHandle(preferredTitle, false, videoId);
            if (handle && await folderStateMatchesVideoId(handle, videoId)) {
                return handle;
            }
        } catch (_) { /* fall through */ }
    }

    // Strategy C: scan subfolders for a state file whose metadata.videoId matches
    try {
        const folders = await FileSystemModule.listSubFolders();
        for (const folder of folders) {
            if (await folderStateMatchesVideoId(folder, videoId)) {
                return folder;
            }
        }
    } catch (_) { /* scan failed */ }

    if (FileSystemModule.permissionNeedsUserGesture) return null;
    return null;
}

async function scanFoldersForHistoryEntries() {
    const folders = await FileSystemModule.listSubFolders();
    const entries = [];

    // Performance: Process folders in parallel with concurrency limit to prevent I/O bottleneck
    const CONCURRENCY_LIMIT = 5; // Process 5 folders at a time

    for (let i = 0; i < folders.length; i += CONCURRENCY_LIMIT) {
        const batch = folders.slice(i, i + CONCURRENCY_LIMIT);
        
        // Process batch in parallel
        const batchResults = await Promise.allSettled(
            batch.map(async (folder) => {
                try {
                    const stateFile = await folder.getFileHandle(VIDEO_STATE_FILENAME);
                    const file = await stateFile.getFile();
                    const text = await file.text();
                    const vState = JSON.parse(text);
                    return buildHistoryEntryFromState(vState, folder.name);
                } catch (e) {
                    // Ignore folders without a valid state file or read errors
                    console.debug('[History] Failed to read folder:', folder.name, e);
                    return null;
                }
            })
        );

        // Collect successful results
        batchResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                entries.push(result.value);
            }
        });
    }

    return sortHistoryEntries(entries);
}

function renderHistoryEntry(list, entry) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const title = entry.videoTitle || entry.folderName || "Unknown Video";
    const url = entry.videoUrl || "#";

    const thumbUrl = entry.videoId
        ? `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`
        : "";

    item.innerHTML = `
        ${thumbUrl ? `<img class="history-thumb" src="${thumbUrl}" alt="thumb">` : '<div class="history-thumb"></div>'}
        <div class="history-info">
            <div class="history-header">
                <div class="history-title">${escapeHtml(title)}</div>
                <button class="history-delete-btn" title="Delete all data for this video">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
            <div class="history-meta">
                <div class="history-stats">
                    <span class="stat-tag"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> ${entry.shotCount || 0}</span>
                    <span class="stat-tag"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></path></svg> ${entry.tocCount || 0}</span>
                </div>
                <div class="history-channel"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"></path><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"></polygon></svg> ${escapeHtml(entry.channel || 'YouTube')}</div>
            </div>
        </div>
    `;

    item.addEventListener('click', (e) => {
        if (e.target.closest('.history-delete-btn')) return;
        if (url !== "#") {
            resolveActiveYouTubeTabId().then((tabId) => {
                if (Number.isInteger(tabId)) {
                    chrome.tabs.update(tabId, { url: url });
                } else {
                    chrome.tabs.create({ url });
                }
            });
        }
    });

    item.querySelector('.history-delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await showConfirm(`Delete ALL screenshots and notes for "${title}"?\nThis will remove the local folder: ${entry.folderName}`)) {
            return;
        }

        const success = await FileSystemModule.deleteDirectory(entry.folderName);
        if (!success) {
            await showAlert("Failed to delete folder. Check permissions.");
            return;
        }

        await removeHistoryIndexEntry(entry.folderName, entry.videoId || null);
        item.remove();

        const currentFolderName = getSafeFolderNameForTitle(currentVideoTitle || state.metadata?.videoTitle || "");
        if (entry.folderName === currentFolderName) {
            clearVideoStateUI();
        }

        if (!list.querySelector('.history-item')) {
            list.innerHTML = '<div class="empty-state"><p>No history left.</p></div>';
        }
    });

    list.appendChild(item);
}

async function refreshHistory() {
    if (!safeSetInnerHTML('history-list', '<div class="empty-state"><p>Scanning for history...</p></div>')) return;

    if (!FileSystemModule.dirHandle) {
        safeSetInnerHTML('history-list', '<div class="empty-state"><p>Select a folder to see history.</p></div>');
        return;
    }

    try {
        let entries = await readHistoryIndexEntries();
        const folders = await FileSystemModule.listSubFolders();
        const existingFolderNames = new Set(folders.map(folder => folder.name));

        // Bootstrap history_index.json from existing per-video JSON files.
        if (entries.length === 0) {
            entries = folders.length > 0 ? await scanFoldersForHistoryEntries() : [];
            if (entries.length > 0) {
                await writeHistoryIndexEntries(entries);
            }
        } else {
            const prunedEntries = entries.filter(entry => existingFolderNames.has(entry.folderName));
            if (prunedEntries.length !== entries.length) {
                entries = prunedEntries;
                await writeHistoryIndexEntries(entries);
            }
        }

        if (entries.length === 0) {
            safeSetInnerHTML('history-list', '<div class="empty-state"><p>No recorded notes found in this folder.</p></div>');
            return;
        }

        const list = document.getElementById('history-list');
        if (list) {
            list.innerHTML = '';
            
            // Performance: Use DocumentFragment to batch DOM insertions
            const fragment = document.createDocumentFragment();
            for (const entry of entries) {
                renderHistoryEntry(fragment, entry);
            }
            list.appendChild(fragment);

            if (!list.querySelector('.history-item')) {
                list.innerHTML = '<div class="empty-state"><p>No valid history files found.</p></div>';
            }
        }

    } catch (err) {
        console.error("History refresh failed:", err);
        safeSetInnerHTML('history-list', '<div class="empty-state"><p>Failed to scan folders.</p></div>');
    }
}
// ==========================================
// Action: Table of Contents
// ==========================================
async function collectTOCEntryDetails(defaultTitle = "", defaultLevel = "H2") {
    const titleInput = await showPrompt("Enter marker name:", defaultTitle);
    const cleanedTitle = String(titleInput || "").trim();
    if (!cleanedTitle) return null;

    const level = await promptTOCLevel(defaultLevel);
    if (!level) return null;

    return { title: cleanedTitle, level: normalizeTOCLevel(level) };
}

async function collectTOCPlacementForScreenshot(defaultPlacement = 'bottom') {
    const choices = [
        {
            value: 'top',
            label: 'Above Screenshot',
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14"></path><polyline points="6 11 12 5 18 11"></polyline></svg>',
            description: 'Insert this marker before the screenshot in the gallery flow.'
        },
        {
            value: 'bottom',
            label: 'Below Screenshot',
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14"></path><polyline points="6 13 12 19 18 13"></polyline></svg>',
            description: 'Add this marker after the screenshot in the gallery flow.'
        }
    ];

    const picked = await showPrompt("Place marker above or below this screenshot?", defaultPlacement, choices);
    if (!picked) return null;
    return picked === 'top' ? 'top' : 'bottom';
}

async function handleAddTOC() {
    if (!currentTabId || !currentVideoId) {
        console.warn("Sidepanel: Cannot add TOC, missing tab or video ID");
        return;
    }

    if (!isNotebookEnabled) {
        showToast("Notebook is OFF. Turn it ON to add markers.", "warning");
        return;
    }

    const targetId = currentVideoId;
    const targetTitle = currentVideoTitle;

    // Use retry logic in case they click TOC immediately after URL changes but script hasn't loaded
    const response = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 10, 500);

    if (!response) {
        console.warn("Sidepanel: Failed to get video state for TOC after retries.");
        showToast("Could not read video time. Try again in a moment.", "info");
        return;
    }

    const timeMs = response.currentTimeMs;
    const timeStr = formatTime(timeMs);
    const details = await collectTOCEntryDetails("", "H2");

    if (details) {
        console.log("Sidepanel: Adding TOC Entry:", details.title, timeStr, details.level);

        // Only add to UI if we're still on the same video
        if (targetId === currentVideoId) {
            addTOCToUI(details.title, timeStr, timeMs, null, details.level);

            // Switch to Screenshots tab (where markers are now interleaved)
            const tabBtn = document.querySelector('.tab-btn[data-tab="tab-screenshots"]');
            if (tabBtn) tabBtn.click();
        } else {
            // Background save if navigated away
            const pendingEntry = normalizeTOCRecord({
                id: `toc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                timeFormatted: timeStr,
                timestampMs: timeMs,
                title: details.title,
                level: details.level,
                createdAt: Date.now()
            });
            state.toc.push(pendingEntry);
            state.toc = sortTOCByCreated(state.toc);
        }
        await saveVideoState(targetId, targetTitle);
    }
}

function insertElementSorted(container, newElement) {
    if (!container || !newElement) return;
    const newCreated = Number(newElement.dataset.createdAt) || 0;
    const children = Array.from(container.children);
    
    // Skip empty states or non-card elements if any
    const existingItems = children.filter(child => child.dataset.createdAt !== undefined);
    
    const nextElement = existingItems.find(child => (Number(child.dataset.createdAt) || 0) > newCreated);
    
    if (nextElement) {
        container.insertBefore(newElement, nextElement);
    } else {
        container.appendChild(newElement);
    }
}

function addTOCToUI(title, timeStr, timeMs, existingCreatedAt = null, level = 'H2') {
    const entry = normalizeTOCRecord({
        id: `toc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        title: title,
        timeFormatted: timeStr,
        timestampMs: timeMs,
        level: normalizeTOCLevel(level),
        createdAt: existingCreatedAt || Date.now()
    });
    state.toc.push(entry);

    // Keep stable "where added" order in gallery
    state.toc = sortTOCByCreated(state.toc);

    renderTOCList();
    
    const list = document.getElementById('screenshots-list');
    if (list && list.querySelector('.empty-state')) {
        list.innerHTML = '';
    }

    const totalItems = state.screenshots.length + state.toc.length;

    if (list) {
        // DELTA RENDERING: Insert marker in sorted position
        const tocElement = createTOCGalleryElement(entry);
        insertElementSorted(list, tocElement);
        safeScrollToElement(tocElement);
    }

    saveVideoState(currentVideoId);
}

// Fix #16: Batch DOM creation in renderTOCList using DocumentFragment
function renderTOCList() {
    const list = document.getElementById('toc-list');
    if (!list) return;

    list.innerHTML = "";
    if (!state.toc || state.toc.length === 0) {
        list.innerHTML = '<div class="empty-state">No markers yet. Use the timeline or click a screenshot button to add.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();
    state.toc.forEach(entry => {
        const item = createTOCGalleryElement(entry);
        fragment.appendChild(item);
    });
    list.appendChild(fragment);
}

function renderTOCModal() {
    const tocModalList = document.getElementById('toc-modal-list');
    if (!tocModalList) return;

    tocModalList.innerHTML = '';

    // Only show TOC entries with hierarchy (h1, h2, h3)
    const tocEntries = (state.toc || [])
        .filter(entry => entry.level)
        .sort((a, b) => a.timestampMs - b.timestampMs);

    if (tocEntries.length === 0) {
        tocModalList.innerHTML = '<div class="empty-state"><p>No TOC entries with headings (H1, H2, H3) added for this video.</p></div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    tocEntries.forEach(entry => {
        const levelClass = `toc-level-${entry.level.toLowerCase()}`;
        const indentSize = entry.level === 'H1' ? 0 : entry.level === 'H2' ? 16 : 32;

        const item = document.createElement('div');
        item.className = `toc-modal-item ${levelClass}`;
        item.style.paddingLeft = `${16 + indentSize}px`;
        item.dataset.entryId = entry.id;
        item.innerHTML = `
            <span class="toc-heading-label">${escapeHtml(entry.level)}</span>
            <span class="toc-marker-title">${escapeHtml(entry.title)}</span>
            <span class="toc-marker-time">${escapeHtml(entry.timeFormatted || formatTime(entry.timestampMs))}</span>
        `;

        item.addEventListener('click', async () => {
            const tabId = await resolveActiveYouTubeTabId();
            if (Number.isInteger(tabId)) {
                chrome.tabs.sendMessage(tabId, { action: 'seekTo', timeMs: entry.timestampMs });
            }

            // Switch to Screenshots tab and scroll to the entry
            const tabBtn = document.querySelector('.tab-btn[data-tab="tab-screenshots"]');
            if (tabBtn && !tabBtn.classList.contains('active')) {
                tabBtn.click();
            }

            // Navigate to the entry in the side panel
            requestAnimationFrame(() => {
                const panelEntry = document.getElementById(entry.id);
                if (panelEntry) {
                    panelEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });

            document.getElementById('toc-modal-overlay')?.classList.add('hidden');
        });

        fragment.appendChild(item);
    });

    tocModalList.appendChild(fragment);
}

function clearVideoStateUI() {
    // Fix #11: Revoke all Blob URLs to free memory
    state.blobUrls.forEach(url => {
        try { URL.revokeObjectURL(url); } catch (e) {
            console.debug('[Panel] Failed to revoke blob URL during clear:', url, e);
        }
    });
    state.blobUrls.clear();

    state.screenshots = [];
    state.toc = [];
    state.intervalMarkers = [];
    state.metadata = {};
    state.activeIntervalCount = 0;

    // Always drop stale title/channel/progress so a tab swap never keeps the old video header.
    const titleEl = document.getElementById('video-title');
    if (titleEl) titleEl.textContent = 'Clip Notes';
    const detailsEl = document.getElementById('video-details');
    if (detailsEl) detailsEl.textContent = 'Connect to a video...';
    const fillEl = document.getElementById('progress-fill');
    if (fillEl) fillEl.style.width = '0%';
    const pctEl = document.getElementById('progress-percentage');
    if (pctEl) pctEl.textContent = '0%';
    const timeEl = document.getElementById('time-display');
    if (timeEl) timeEl.textContent = '00:00 / 00:00';

    // Fix #10: Clear auto-screenshot interval on video change
    if (autoScreenshotInterval) {
        clearTimeout(autoScreenshotInterval);
        autoScreenshotInterval = null;
    }
    if (autoScreenshotActive || lastAutoFrameHash) {
        autoScreenshotActive = false;
        lastAutoFrameHash = null;
        cachedPlaybackRate = 1.0;
        lastPlaybackRateFetch = 0;
        const autoBtn = document.getElementById('btn-capture-auto');
        if (autoBtn) {
            autoBtn.classList.remove('primary');
            autoBtn.title = 'Toggle Auto Screenshot';
        }
        lastAutoScreenshotTime = 0;
    }

    // Fix #17: Clear transcript cache on video change
    cachedTranscriptSegments = null;
    state.metadata = {
        videoId: currentVideoId,
        videoTitle: currentVideoTitle || "",
        videoUrl: "", // Will be filled by poll Metadata
        channel: "",
        selectedInterval: "None"
    };
    isDataLoadedForId = null; // Reset load tracker
    const timelineMarkers = document.getElementById('timeline-markers');
    if (timelineMarkers) timelineMarkers.innerHTML = '';

    const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;

    // Use helper for safety
    safeSetInnerHTML('screenshots-list', `<div class="empty-state">${svgIcon}<p>No screenshots taken yet.</p></div>`);

    safeSetInnerHTML('toc-list', `<div class="empty-state"><p>No timeline markers added.</p></div>`);

    safeSetInnerHTML('transcript-content', `<div class="empty-state"><p>Click "📜 Transcript" to load the text for this video.</p></div>`);

    // Reset toggle when video changes
    setNotebookToggleState(false);
}

// ==========================================
// Action: Export PDF (Mimicking ReportLab)
// ==========================================
// ==========================================
// PRO PDF: Rich Text & Emoji Rendering (Canvas Strategy)
// ==========================================
/**
 * Renders HTML/Rich Text to a high-res image data URL using a temporary DOM element.
 * This preserves emojis (no Ã˜=ÃœÃ¸ issue) and formatting (bold, color, etc).
 */
const PDF_EXPORT_FONT_STACK = "'Nirmala UI', 'Noto Sans Telugu', 'Noto Sans Devanagari', 'Mangal', 'Segoe UI', Arial, sans-serif";

function escapeHtmlForExport(text) {
    return String(text || "")
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeHtml(text) {
    return escapeHtmlForExport(text);
}

function escapeAttr(text) {
    return escapeHtmlForExport(text);
}

function normalizeInlineStyleForExport(styleText, maxFontPx = 16) {
    const allowedProps = new Set([
        'font-weight',
        'font-style',
        'text-decoration',
        'background-color',
        'color',
        'text-align',
        'line-height',
        'white-space',
        'font-size',
        'border',
        'border-top',
        'border-bottom',
        'border-left',
        'border-right',
        'border-collapse',
        'padding',
        'padding-top',
        'padding-bottom',
        'padding-left',
        'padding-right',
        'margin',
        'margin-top',
        'margin-bottom',
        'margin-left',
        'margin-right',
        'width',
        'height',
        'min-width',
        'min-height',
        'max-width',
        'max-height',
        'display',
        'vertical-align'
    ]);

    const output = [];
    const rules = String(styleText || '').split(';');
    for (const rule of rules) {
        const [rawProp, rawVal] = rule.split(':');
        if (!rawProp || !rawVal) continue;

        const prop = rawProp.trim().toLowerCase();
        const val = rawVal.trim();

        if (prop === 'font-family') continue;

        if (prop === 'font-size') {
            const px = parseFloat(val);
            if (Number.isFinite(px)) {
                // If maxFontPx is explicitly null or large, allow original size
                const limit = maxFontPx || 500;
                const clamped = Math.max(10, Math.min(limit, px));
                output.push(`font-size:${clamped}px`);
            }
            continue;
        }

        if (allowedProps.has(prop)) {
            // Block any URL/resource references that can taint the canvas
            if (val.toLowerCase().includes('url(')) continue;
            output.push(`${prop}:${val}`);
        }
    }

    return output.join('; ');
}

function sanitizeHtmlForEditorAndExport(html, options = {}) {
    if (!html) return "";

    const maxFontPx = ('maxFontPx' in options) ? options.maxFontPx : 16;
    const keepLinks = !!options.keepLinks;

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild || doc.body;

    root.querySelectorAll('script,style,meta,link,iframe,object,embed').forEach(el => el.remove());

    const allowedTags = new Set([
        'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'P', 'DIV', 'BR', 'UL', 'OL', 'LI', 'SPAN',
        'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
        'PRE', 'CODE', 'BLOCKQUOTE'
    ]);
    const allowedAttrs = new Set([
        'style', 'href', 'colspan', 'rowspan', 'target', 'rel',
        'width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'valign', 'bgcolor', 'color'
    ]);

    root.querySelectorAll('*').forEach((el) => {
        if (!allowedTags.has(el.tagName)) {
            const blockLikeTags = new Set([
                'ADDRESS', 'ARTICLE', 'ASIDE', 'DIV', 'DL', 'DT', 'DD', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
                'FOOTER', 'FORM', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
                'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'UL'
            ]);
            const replacement = doc.createElement(blockLikeTags.has(el.tagName) ? 'div' : 'span');
            while (el.firstChild) {
                replacement.appendChild(el.firstChild);
            }
            el.replaceWith(replacement);
            return;
        }

        Array.from(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            if (!allowedAttrs.has(name)) {
                el.removeAttribute(attr.name);
            }
        });

        const styleText = el.getAttribute('style');
        if (styleText) {
            const normalized = normalizeInlineStyleForExport(styleText, maxFontPx);
            if (normalized) el.setAttribute('style', normalized);
            else el.removeAttribute('style');
        }

        if (el.tagName === 'A') {
            const href = (el.getAttribute('href') || '').trim();
            if (!keepLinks || !/^(https?:|mailto:)/i.test(href)) {
                el.removeAttribute('href');
            } else {
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            }
        }
    });

    return root.innerHTML.trim();
}

function plainTextToEditorHtml(text) {
    return escapeHtmlForExport(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}

function getPlainTextFromHtmlForExport(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || "";
    return (tmp.textContent || tmp.innerText || "")
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getPlainTextWithBreaksFromHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || "";
    const blockTags = new Set([
        'DIV', 'P', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'TR', 'TABLE'
    ]);

    const pieces = [];
    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            pieces.push(node.nodeValue || "");
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName;
        if (tag === 'BR') {
            pieces.push('\n');
            return;
        }

        const isBlock = blockTags.has(tag);
        if (isBlock && pieces.length > 0 && !pieces[pieces.length - 1].endsWith('\n')) {
            pieces.push('\n');
        }

        node.childNodes.forEach(walk);

        if (isBlock && pieces.length > 0 && !pieces[pieces.length - 1].endsWith('\n')) {
            pieces.push('\n');
        }
    };
    tmp.childNodes.forEach(walk);

    return pieces.join('')
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getScreenshotNoteHtml(shot) {
    if (!shot || typeof shot !== 'object') return "";

    const htmlCandidates = [shot.noteHtml, shot.note_html];
    for (const candidate of htmlCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            // Sanitize HTML to prevent XSS attacks
            return sanitizeNoteHtml(candidate);
        }
    }

    const plainCandidates = [shot.note, shot.notes, shot.noteText];
    for (const candidate of plainCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return plainTextToEditorHtml(candidate);
        }
    }

    return "";
}

// Security: Sanitize note HTML to prevent XSS attacks
// Removes dangerous tags and attributes while preserving formatting
function sanitizeNoteHtml(html) {
    if (!html || typeof html !== 'string') return "";

    // Create a temporary DOM element for parsing
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    // Allowed tags (whitelist approach)
    const allowedTags = new Set([
        'b', 'i', 'em', 'strong', 'u', 'span', 'div', 'p', 'br', 'hr',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'mark', 'code', 'pre', 'blockquote', 'a'
    ]);

    // Allowed attributes per tag
    const allowedAttrs = {
        '*': ['style', 'class'],
        'a': ['href', 'title', 'target'],
        'span': ['style', 'class'],
        'div': ['style', 'class'],
        'p': ['style', 'class'],
        'h1': ['style', 'class'],
        'h2': ['style', 'class'],
        'h3': ['style', 'class'],
        'h4': ['style', 'class'],
        'h5': ['style', 'class'],
        'h6': ['style', 'class'],
        'mark': ['style', 'class'],
        'code': ['style', 'class'],
        'pre': ['style', 'class'],
        'blockquote': ['style', 'class']
    };

    // Allowed CSS properties in style attributes
    const allowedStyles = new Set([
        'color', 'background-color', 'background',
        'font-weight', 'font-style', 'font-family', 'font-size',
        'text-decoration', 'text-align',
        'margin', 'padding', 'border',
        'white-space', 'word-wrap', 'line-height'
    ]);

    // Dangerous tags to completely remove (including contents)
    const dangerousTags = new Set([
        'script', 'iframe', 'object', 'embed', 'form', 'input',
        'button', 'select', 'textarea', 'style', 'link', 'meta',
        'base', 'applet', 'frame', 'frameset', 'layer', 'ilayer'
    ]);

    // Recursive function to sanitize nodes
    function sanitizeNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.cloneNode();
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }

        const tagName = node.nodeName.toLowerCase();

        // Remove dangerous tags completely
        if (dangerousTags.has(tagName)) {
            return null;
        }

        // Skip unknown tags but process their children
        if (!allowedTags.has(tagName)) {
            const fragment = document.createDocumentFragment();
            Array.from(node.childNodes).forEach(child => {
                const sanitized = sanitizeNode(child);
                if (sanitized) fragment.appendChild(sanitized);
            });
            return fragment;
        }

        // Create sanitized element
        const sanitizedEl = document.createElement(tagName);

        // Copy allowed attributes
        Array.from(node.attributes).forEach(attr => {
            const attrName = attr.name.toLowerCase();
            const allowedForTag = allowedAttrs[tagName] || allowedAttrs['*'] || [];

            if (allowedForTag.includes(attrName)) {
                if (attrName === 'style') {
                    // Sanitize style attribute
                    const sanitizedStyle = sanitizeStyleAttribute(attr.value);
                    if (sanitizedStyle) {
                        sanitizedEl.setAttribute(attrName, sanitizedStyle);
                    }
                } else if (attrName === 'href') {
                    // Only allow safe protocols for links
                    const hrefValue = attr.value.trim();
                    if (hrefValue.startsWith('#') ||
                        hrefValue.startsWith('http://') ||
                        hrefValue.startsWith('https://') ||
                        hrefValue.startsWith('mailto:')) {
                        sanitizedEl.setAttribute(attrName, hrefValue);
                    }
                } else {
                    sanitizedEl.setAttribute(attrName, attr.value);
                }
            }
        });

        // Process children
        Array.from(node.childNodes).forEach(child => {
            const sanitized = sanitizeNode(child);
            if (sanitized) sanitizedEl.appendChild(sanitized);
        });

        return sanitizedEl;
    }

    // Sanitize style attribute value
    function sanitizeStyleAttribute(styleValue) {
        if (!styleValue || typeof styleValue !== 'string') return '';

        const declarations = styleValue.split(';');
        const sanitized = [];

        declarations.forEach(declaration => {
            const colonIndex = declaration.indexOf(':');
            if (colonIndex === -1) return;

            const property = declaration.substring(0, colonIndex).trim().toLowerCase();
            const value = declaration.substring(colonIndex + 1).trim();

            // Only allow whitelisted CSS properties
            if (allowedStyles.has(property)) {
                // Additional safety: remove url() and expression() which can execute code
                if (!value.includes('url(') &&
                    !value.includes('expression(') &&
                    !value.includes('javascript:')) {
                    sanitized.push(`${property}: ${value}`);
                }
            }
        });

        return sanitized.join('; ');
    }

    // Process the HTML
    const sanitized = sanitizeNode(tempDiv);
    if (!sanitized) return '';

    // Return sanitized HTML
    const result = sanitized.nodeType === Node.ELEMENT_NODE ? sanitized.outerHTML : sanitized.textContent;
    return result || '';
}

function convertMarkdownToHtml(text) {
    if (!text) return null;

    // Heuristic strictly targeting common markdown symbols, now allowing leading whitespace
    const hasMarkdown = /^\s*(#{1,6}\s|[-*]\s|\d+\.\s|>|\||```)/m.test(text) || /\*\*(.*?)\*\*/.test(text) || /__(.*?)__/.test(text) || /`(.*?)`/.test(text);
    if (!hasMarkdown) return null;

    const lines = text.split(/\r?\n/);
    let inTable = false;
    let inCodeBlock = false;
    let inList = false;
    let htmlOutput = [];

    const formatInline = (str) => {
        return str
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.*?)__/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/_(.*?)_/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1); padding:2px 4px; border-radius:3px; font-family:monospace;">$1</code>');
    };

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        let rawLine = lines[i]; // for code blocks

        // 1. Code blocks
        if (line.startsWith('```')) {
            if (inList) { htmlOutput.push('</ul>'); inList = false; }
            if (inTable) { htmlOutput.push('</tbody></table><br/>'); inTable = false; }

            if (inCodeBlock) {
                htmlOutput.push('</code></pre>');
                inCodeBlock = false;
            } else {
                htmlOutput.push('<br/><pre style="background:#1e1e1e; color:#d4d4d4; padding:10px; border-radius:5px; overflow-x:auto;"><code>');
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            htmlOutput.push(escapeHtmlForExport(rawLine) + '\n');
            continue;
        }

        // 2. Tables
        const isTableDivider = /^[\|\s\-:]+$/.test(line) && line.includes('-') && line.includes('|');
        const isTableRow = line.includes('|') && (line.startsWith('|') || line.endsWith('|'));

        if (isTableRow || isTableDivider) {
            if (inList) { htmlOutput.push('</ul>'); inList = false; }

            let nextLineIsDivider = false;
            if (!inTable && i + 1 < lines.length) {
                const nl = lines[i + 1].trim();
                nextLineIsDivider = /^[\|\s\-:]+$/.test(nl) && nl.includes('-') && nl.includes('|');
            }

            if (inTable || nextLineIsDivider || isTableDivider) {
                if (isTableDivider) {
                    if (inTable && htmlOutput.length > 0) {
                        const lastLine = htmlOutput.pop();
                        const cleanHeaderLine = lastLine.replace(/^<tr>/, '').replace(/<\/tr>$/, '');
                        const headerHtml = cleanHeaderLine.replace(/<td[^>]*>/g, '<th style="border: 1px solid #555; padding: 6px; background: rgba(255,255,255,0.08); font-weight:bold;">').replace(/<\/td>/g, '</th>');
                        htmlOutput.push('<thead><tr>' + headerHtml + '</tr></thead><tbody style="border-top: 1px solid #555;">');
                    }
                    inTable = true;
                    continue;
                }

                let cleanLine = line.replace(/^\|/, '').replace(/\|$/, '');
                const cells = cleanLine.split('|').map(c => c.trim());
                const rowHtml = '<tr>' + cells.map(c => {
                    return `<td style="border: 1px solid #444; padding: 4px 8px;">${formatInline(escapeHtmlForExport(c))}</td>`;
                }).join('') + '</tr>';

                if (!inTable) {
                    htmlOutput.push('<br/><table style="border-collapse: collapse; width: 100%; border: 1px solid #444; margin: 8px 0;"><tbody>');
                    inTable = true;
                }
                htmlOutput.push(rowHtml);
                continue;
            }
        }

        if (inTable) {
            htmlOutput.push('</tbody></table><br/>');
            inTable = false;
        }

        // 3. Headers
        const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            if (inList) { htmlOutput.push('</ul>'); inList = false; }
            const level = headerMatch[1].length;
            const content = formatInline(escapeHtmlForExport(headerMatch[2]));
            // Add appropriate bottom padding depending on header size
            const size = [32, 24, 18, 16, 14, 12][level - 1] + 'px';
            htmlOutput.push(`<h${level} style="margin-top: 14px; margin-bottom: 8px; font-size: ${size};">${content}</h${level}>`);
            continue;
        }

        // 4. Blockquotes
        if (line.startsWith('>')) {
            if (inList) { htmlOutput.push('</ul>'); inList = false; }
            let content = line.startsWith('> ') ? line.substring(2) : line.substring(1);
            content = formatInline(escapeHtmlForExport(content.trim()));
            htmlOutput.push(`<blockquote style="border-left: 3px solid #63b3ed; margin-left: 0; margin-top: 6px; margin-bottom: 6px; padding-left: 12px; color: #aaa; font-style: italic;">${content}</blockquote>`);
            continue;
        }

        // 5. Lists
        const listMatch = line.match(/^([*\-+]|\d+\.)\s+(.*)$/);
        if (listMatch) {
            if (!inList) {
                htmlOutput.push('<ul style="margin-top: 4px; margin-bottom: 4px; padding-left: 24px;">');
                inList = true;
            }
            let content = listMatch[2];
            // Render basic pseudo-checkboxes for task lists
            if (content.toLowerCase().startsWith('[ ] ')) {
                content = '&#9744; ' + content.substring(4);
            } else if (content.toLowerCase().startsWith('[x] ')) {
                content = '&#9745; ' + content.substring(4);
            }
            htmlOutput.push(`<li style="margin-bottom: 2px;">${formatInline(escapeHtmlForExport(content))}</li>`);
            continue;
        }

        // Blank lines
        if (line === '') {
            if (inList) { htmlOutput.push('</ul>'); inList = false; }
            htmlOutput.push('<br/>');
            continue;
        }

        // Normal text
        if (inList) { htmlOutput.push('</ul>'); inList = false; }
        htmlOutput.push(formatInline(escapeHtmlForExport(line)) + '<br/>');
    }

    if (inList) { htmlOutput.push('</ul>'); }
    if (inTable) { htmlOutput.push('</tbody></table><br/>'); }
    if (inCodeBlock) { htmlOutput.push('</code></pre>'); }

    return htmlOutput.join('\n');
}

function handleNoteEditorPaste(event, editor, shot) {
    event.preventDefault();
    const clipboard = event.clipboardData || window.clipboardData;
    if (!clipboard) return;

    const html = clipboard.getData('text/html');
    const text = clipboard.getData('text/plain') || "";

    let insertHtml = "";

    const mkHtml = convertMarkdownToHtml(text);

    // If the HTML version literally contains markdown symbols like '###' or '> ', 
    // it's a "bad" HTML flavor and we should force the markdown parser.
    const htmlHasLiteralMarkdown = html && (html.includes('###') || html.includes('&gt; ') || html.includes('| ---'));

    if (mkHtml && (htmlHasLiteralMarkdown || !html || !html.toLowerCase().includes('<table'))) {
        insertHtml = sanitizeHtmlForEditorAndExport(mkHtml, { maxFontPx: null, keepLinks: true });
    } else if (html && html.trim()) {
        insertHtml = sanitizeHtmlForEditorAndExport(html, { maxFontPx: null, keepLinks: true });
    }

    if (!insertHtml) {
        insertHtml = plainTextToEditorHtml(text);
    }
    if (!insertHtml) return;

    document.execCommand('insertHTML', false, insertHtml);
    
    // Sanitize HTML before saving to prevent XSS
    const sanitizedHtml = sanitizeNoteHtml(editor.innerHTML);
    shot.noteHtml = sanitizedHtml;
    const stateEntry = state.screenshots.find(s => s.id === shot.id);
    if (stateEntry && stateEntry !== shot) {
        stateEntry.noteHtml = sanitizedHtml;
    }
    saveVideoState(currentVideoId);
}

/**
 * Handles Enter key to automatically continue "Arrow List" (→) or "Check List" (✓).
 */
function handleNoteEditorKeydown(event, editor, shot) {
    if (event.key !== 'Enter') return;

    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const container = range.startContainer;

    // Find the text node or element containing the current line start
    const lineText = container.textContent || "";
    const caretOffset = range.startOffset;

    // Detect if the current line starts with our special markers
    const markers = ["→", "✓"];
    let activeMarker = null;

    for (const m of markers) {
        if (lineText.trim().startsWith(m)) {
            activeMarker = m;
            break;
        }
    }

    if (activeMarker) {
        // If the line has ONLY the marker, clear it (exit list)
        if (lineText.trim() === activeMarker) {
            event.preventDefault();
            // Clear current line text
            if (container.nodeType === Node.TEXT_NODE) {
                container.textContent = "";
            } else {
                container.innerHTML = "";
            }
            return;
        }

        // Otherwise, continue the list on next line
        event.preventDefault();
        document.execCommand('insertHTML', false, `<br>${activeMarker} &nbsp;`);
    }
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

async function ensureDataUrlFromBlob(sourceUrl, optionalShotId = null) {
    if (!sourceUrl || typeof sourceUrl !== 'string') {
        // If it was already null/empty, we might need to re-hydrate it if shotId is provided
        if (!sourceUrl && optionalShotId && currentVideoId && currentVideoTitle) {
            console.debug('[Panel] ensureDataUrlFromBlob: URL is missing, attempting re-hydration for', optionalShotId);
            await loadVideoState(currentVideoId, currentVideoTitle, { lazy: true });
            const shot = state.screenshots.find(s => s.id === optionalShotId);
            if (shot && shot.dataUrl) return shot.dataUrl;
        }
        return sourceUrl;
    }
    if (!sourceUrl.startsWith('blob:')) return sourceUrl;

    try {
        const blobResp = await fetch(sourceUrl);
        const blob = await blobResp.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn("[Panel] Failed to convert blob URL to data URL, attempting re-hydration:", e);
        if (optionalShotId && currentVideoId && currentVideoTitle) {
            await loadVideoState(currentVideoId, currentVideoTitle, { lazy: true });
            const shot = state.screenshots.find(s => s.id === optionalShotId);
            if (shot && shot.dataUrl) {
                // If it's a blob again, recurrence is fine as loadVideoState creates a FRESH blob
                return await ensureDataUrlFromBlob(shot.dataUrl); 
            }
        }
        return sourceUrl;
    }
}

async function isDataUrlLikelyBlank(dataUrl) {
    try {
        const img = await loadImageFromDataUrl(dataUrl);
        if (!img || !img.width || !img.height) return true;

        const sampleWidth = Math.max(8, Math.min(96, img.width));
        const sampleHeight = Math.max(8, Math.min(96, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = sampleWidth;
        canvas.height = sampleHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return true;

        ctx.clearRect(0, 0, sampleWidth, sampleHeight);
        ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
        const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;

        let visible = 0;
        let textLike = 0;

        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const a = pixels[i + 3];

            if (a < 8) continue;
            visible += 1;

            const isNearWhite = r > 245 && g > 245 && b > 245;
            const colorSpread = Math.max(r, g, b) - Math.min(r, g, b);
            const isDark = (r + g + b) < 650;
            if (!isNearWhite && (isDark || colorSpread > 12)) {
                textLike += 1;
            }
        }

        if (visible === 0) return true;
        const textLikeRatio = textLike / visible;
        return textLikeRatio < 0.0008;
    } catch {
        return true;
    }
}

function fitImageWithinBox(naturalWidth, naturalHeight, maxWidth, maxHeight, minHeight = 0) {
    const safeNaturalWidth = Math.max(1, Number(naturalWidth) || 1);
    const safeNaturalHeight = Math.max(1, Number(naturalHeight) || 1);
    const safeMaxWidth = Math.max(1, Number(maxWidth) || 1);
    const safeMaxHeight = Math.max(1, Number(maxHeight) || 1);
    const safeMinHeight = Math.max(0, Math.min(Number(minHeight) || 0, safeMaxHeight));

    let width = safeMaxWidth;
    let height = width * (safeNaturalHeight / safeNaturalWidth);

    if (height > safeMaxHeight) {
        height = safeMaxHeight;
        width = height * (safeNaturalWidth / safeNaturalHeight);
    }

    if (width > safeMaxWidth) {
        width = safeMaxWidth;
        height = width * (safeNaturalHeight / safeNaturalWidth);
    }

    if (height < safeMinHeight) {
        height = safeMinHeight;
        width = height * (safeNaturalWidth / safeNaturalHeight);
        if (width > safeMaxWidth) {
            width = safeMaxWidth;
            height = width * (safeNaturalHeight / safeNaturalWidth);
        }
    }

    return {
        width: Math.max(1, width),
        height: Math.max(1, height)
    };
}

function stripInvalidXmlChars(input) {
    const raw = String(input || "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');

    // Remove unpaired surrogate code points that can break SVG/XML parsing.
    let cleaned = '';
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = raw.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                cleaned += raw[i] + raw[i + 1];
                i += 1;
            }
            continue;
        }
        if (code >= 0xDC00 && code <= 0xDFFF) {
            continue;
        }
        cleaned += raw[i];
    }
    return cleaned;
}

async function renderRichTextToCanvas(html, widthPx = 600, options = {}) {
    return new Promise((resolve) => {
        const container = document.createElement('div');
        const fontFamily = options.fontFamily || PDF_EXPORT_FONT_STACK;
        const baseFontSize = options.fontSize || '14px';
        const baseColor = options.color || '#2c3e50';
        const renderScale = Number.isFinite(options.scale) ? Math.max(1, Math.min(3, options.scale)) : 1;

        container.style.position = 'absolute';
        container.style.left = '-9999px';
        container.style.top = '0';
        container.style.width = `${widthPx}px`;
        container.style.backgroundColor = options.bgColor || 'white';
        container.style.padding = options.padding || '0px';
        container.style.fontFamily = fontFamily;
        container.style.fontSize = baseFontSize;
        container.style.lineHeight = options.lineHeight || '1.55';
        container.style.color = baseColor;
        container.style.wordBreak = 'break-word';

        let sanitizedHtml = sanitizeHtmlForEditorAndExport(html || "", {
            maxFontPx: options.maxFontPx || 16,
            keepLinks: false
        });
        sanitizedHtml = sanitizedHtml.replace(/<img[^>]*>/gi, '[Image Removed]');
        container.innerHTML = sanitizedHtml || escapeHtmlForExport(options.fallbackText || "");
        document.body.appendChild(container);

        const cleanup = () => {
            if (container.parentNode) container.parentNode.removeChild(container);
        };

        setTimeout(() => {
            const renderHeight = Math.max(1, container.offsetHeight || 1);
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(widthPx * renderScale);
            canvas.height = Math.ceil(renderHeight * renderScale);
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                cleanup();
                resolve(null);
                return;
            }
            ctx.scale(renderScale, renderScale);

            const safeInnerHtml = stripInvalidXmlChars(container.innerHTML);
            const svg = stripInvalidXmlChars(`
                <svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${renderHeight}">
                    <foreignObject width="100%" height="100%">
                        <div xmlns="http://www.w3.org/1999/xhtml" style="
                            font-family:${fontFamily};
                            font-size:${baseFontSize};
                            color:${baseColor};
                            line-height:${options.lineHeight || '1.55'};
                            word-break:break-word;
                            white-space:pre-wrap;
                        ">
                            <style>
                                * { box-sizing: border-box; color: inherit; }
                                p, div, ul, ol, li, pre, code, blockquote, table, tr, td, th,
                                h1, h2, h3, h4, h5, h6 { margin: 0 0 0.35em 0; }
                                b, strong { font-weight: 700 !important; }
                                i, em { font-style: italic !important; }
                                u { text-decoration: underline !important; text-underline-offset: 1px; }
                                s, del { text-decoration: line-through !important; }
                                a { color: inherit; text-decoration: underline; }
                                ul, ol { padding-left: 1.2em; }
                                li { margin-bottom: 0.2em; }
                                pre { white-space: pre-wrap; }
                                code { white-space: pre-wrap; font-family: Consolas, "Courier New", monospace; }
                                blockquote { border-left: 2px solid #d1d5db; padding-left: 0.55em; }
                                table { border-collapse: collapse; }
                                td, th { padding: 0.15em 0.3em; }
                            </style>
                            ${safeInnerHtml}
                        </div>
                    </foreignObject>
                </svg>`);

            const img = new Image();
            img.onload = () => {
                try {
                    ctx.drawImage(img, 0, 0);
                    cleanup();
                    resolve(canvas.toDataURL('image/png'));
                } catch (err) {
                    console.error("Canvas export failed (tainted):", err);
                    cleanup();
                    resolve(null); // Fallback to plain text
                }
            };
            img.onerror = () => {
                cleanup();
                resolve(null);
            };
            try {
                const encodedSvg = btoa(unescape(encodeURIComponent(svg)));
                img.src = `data:image/svg+xml;base64,${encodedSvg}`;
            } catch (err) {
                console.error("Failed to base64 encode SVG for PDF rendering:", err);
                cleanup();
                resolve(null);
            }
        }, 30);
    });
}

async function renderPlainTextToCanvas(text, widthPx = 1200, options = {}) {
    const cleanText = stripInvalidXmlChars(String(text || "")).trim();
    if (!cleanText) return null;

    const fontFamily = options.fontFamily || PDF_EXPORT_FONT_STACK;
    const fontSizePx = Number.isFinite(options.fontSizePx) ? options.fontSizePx : 22;
    const lineHeightPx = Number.isFinite(options.lineHeightPx) ? options.lineHeightPx : Math.round(fontSizePx * 1.5);
    const paddingPx = Number.isFinite(options.paddingPx) ? options.paddingPx : 20;
    const renderScale = Number.isFinite(options.scale) ? Math.max(1, Math.min(3, options.scale)) : 1;
    const color = options.color || '#2f3d4a';
    const bgColor = options.bgColor || '#ffffff';

    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    if (!measureCtx) return null;
    measureCtx.font = `${fontSizePx}px ${fontFamily}`;

    const maxLineWidth = Math.max(20, widthPx - (paddingPx * 2));
    const lines = [];

    const pushWrappedLine = (inputLine) => {
        const textLine = inputLine || "";
        if (!textLine.trim()) {
            lines.push("");
            return;
        }
        const words = textLine.split(/\s+/).filter(Boolean);
        let current = "";
        for (const word of words) {
            const candidate = current ? `${current} ${word}` : word;
            if (measureCtx.measureText(candidate).width <= maxLineWidth) {
                current = candidate;
            } else {
                if (current) lines.push(current);
                current = word;
            }
        }
        if (current) lines.push(current);
    };

    cleanText.split(/\r\n|\r|\n/g).forEach(pushWrappedLine);
    if (lines.length === 0) lines.push(cleanText);

    const renderHeight = Math.max(lineHeightPx + (paddingPx * 2), (lines.length * lineHeightPx) + (paddingPx * 2));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(widthPx * renderScale);
    canvas.height = Math.ceil(renderHeight * renderScale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.scale(renderScale, renderScale);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, widthPx, renderHeight);
    ctx.font = `${fontSizePx}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';

    let y = paddingPx;
    for (const line of lines) {
        ctx.fillText(line, paddingPx, y, maxLineWidth);
        y += lineHeightPx;
    }

    try {
        return canvas.toDataURL('image/png');
    } catch (err) {
        console.error("Plain text canvas export failed:", err);
        return null; // Fallback to jsPDF native
    }
}

async function addImageDataToPdfWithPaging(doc, imageDataUrl, xMm, startYMm, widthMm, options = {}) {
    const marginMm = Number.isFinite(options.marginMm) ? options.marginMm : 12;
    const gapMm = Number.isFinite(options.gapMm) ? options.gapMm : 4;
    const compression = options.compression || 'FAST';
    const pageHeightMm = doc.internal.pageSize.getHeight();
    const bottomMm = pageHeightMm - marginMm;

    let yMm = startYMm;
    const img = await loadImageFromDataUrl(imageDataUrl);
    if (!img || !img.width || !img.height) return yMm;

    const pxPerMm = img.width / widthMm;
    let offsetPx = 0;

    while (offsetPx < img.height) {
        let availableMm = bottomMm - yMm;
        if (availableMm < 6) {
            doc.addPage();
            yMm = marginMm;
            availableMm = bottomMm - yMm;
        }

        let slicePx = Math.floor(availableMm * pxPerMm);
        if (!Number.isFinite(slicePx) || slicePx <= 0) {
            doc.addPage();
            yMm = marginMm;
            continue;
        }
        slicePx = Math.min(slicePx, img.height - offsetPx);

        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = img.width;
        sliceCanvas.height = slicePx;
        const sliceCtx = sliceCanvas.getContext('2d');
        if (!sliceCtx) break;

        sliceCtx.drawImage(
            img,
            0, offsetPx, img.width, slicePx,
            0, 0, img.width, slicePx
        );

        const sliceHeightMm = slicePx / pxPerMm;
        try {
            const sliceData = sliceCanvas.toDataURL('image/png');
            doc.addImage(sliceData, 'PNG', xMm, yMm, widthMm, sliceHeightMm, undefined, compression);
        } catch (err) {
            console.error("Paging slice failed (tainted):", err);
            // If we can't slice, we just skip this slice to avoid crashing the whole PDF
        }

        offsetPx += slicePx;
        yMm += sliceHeightMm;

        if (offsetPx < img.height) {
            doc.addPage();
            yMm = marginMm;
        }
    }

    return yMm + gapMm;
}

async function addRichBlockToPdf(doc, html, xMm, yMm, widthMm, options = {}) {
    const dataUrl = await renderRichTextToCanvas(html, options.widthPx || 1800, options);
    if (!dataUrl) return yMm;
    return addImageDataToPdfWithPaging(doc, dataUrl, xMm, yMm, widthMm, options);
}

async function generatePDFDoc(progressCallback = null) {
    if (state.screenshots.length === 0 && state.toc.length === 0) {
        await showAlert("Nothing to export yet!");
        return null;
    }

    if (!window.jspdf && !window.jsPDF) {
        await showAlert("PDF Library not loaded properly.");
        return null;
    }

    const jsPDFBuilder = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
    if (!jsPDFBuilder) {
        await showAlert("Could not initialize JS PDF builder.");
        return null;
    }

    const report = (message) => {
        if (typeof progressCallback === 'function') {
            progressCallback(message);
        }
    };

    const isMeaningfulNoteText = (text) => {
        const normalized = String(text || "")
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[.]+$/g, '')
            .trim();

        if (!normalized) return false;

        const placeholders = new Set([
            'no notes attached',
            'no note attached',
            'no notes',
            'none',
            'n/a',
            'na',
            '-'
        ]);

        return !placeholders.has(normalized);
    };

    const getMeaningfulNoteText = (html) => {
        const plain = getPlainTextFromHtmlForExport(html);
        return isMeaningfulNoteText(plain) ? plain : "";
    };

    report("Preparing document...");

    const PDF_BRAND_NAME = "Clip Notes";
    const PDF_ICON_URL = chrome.runtime.getURL("assets/icons/icon128.png");

    const sanitizeForPdfSafe = (str) => {
        if (!str) return "";
        return str.replace(/[^\x00-\x7F]/g, " ").replace(/\s+/g, " ").trim();
    };

    const doc = new jsPDFBuilder({
        orientation: 'p',
        unit: 'mm',
        format: 'a4',
        putOnlyUsedFonts: true,
        compress: true
    });

    let appIconDataUrl = null;
    let thumbnailDataUrl = null;

    const fetchThumbnailDataUrl = async (vid) => {
        if (!vid) return null;
        const urls = [
            `https://img.youtube.com/vi/${vid}/maxresdefault.jpg`,
            `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
            `https://img.youtube.com/vi/${vid}/0.jpg`
        ];
        for (const url of urls) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const blob = await resp.blob();
                return await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
            } catch (e) {
                console.warn("Thumnail fetch failed:", url, e);
            }
        }
        return null;
    };

    try {
        const iconResp = await fetch(PDF_ICON_URL);
        const iconBlob = await iconResp.blob();
        appIconDataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(iconBlob);
        });
    } catch (e) {
        console.warn("Could not load app icon for PDF:", e);
    }

    try {
        report("Fetching video thumbnail...");
        thumbnailDataUrl = await fetchThumbnailDataUrl(state.metadata.videoId);
    } catch (e) {
        console.warn("Could not load thumbnail:", e);
    }

    const rawTitle = document.getElementById('video-title').textContent || "Clip Notes";
    const title = sanitizeForPdfSafe(rawTitle);
    const durationText = document.getElementById('time-display').textContent || "";
    const totalDuration = durationText.split('/')[1]?.trim() || "Unknown";
    const generatedAt = new Date().toLocaleString();

    const sortedShots = [...state.screenshots].sort((a, b) => {
        const aVal = a.createdAt || a.timestampMs || 0;
        const bVal = b.createdAt || b.timestampMs || 0;
        return aVal - bVal;
    });
    const sortedTocEntries = sortTOCByTimeline(
        (Array.isArray(state.toc) ? state.toc : []).map((entry, idx) => normalizeTOCRecord(entry, idx))
    ).filter(entry => String(entry.title || "").trim().length > 0);

    // Hierarchical Numbering
    let h1Count = 0;
    let h2Count = 0;
    let h3Count = 0;
    sortedTocEntries.forEach(entry => {
        const level = normalizeTOCLevel(entry.level);
        if (level === 'H1') {
            h1Count++; h2Count = 0; h3Count = 0;
            entry.numPrefix = `${h1Count}. `;
        } else if (level === 'H2') {
            h2Count++; h3Count = 0;
            entry.numPrefix = `${h1Count}.${h2Count}. `;
        } else {
            h3Count++;
            entry.numPrefix = `${h1Count}.${h2Count}.${h3Count}. `;
        }
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2);

    const mmToPx = 96 / 25.4;
    const noteRenderWidthPx = Math.max(560, Math.round(contentWidth * mmToPx));
    const slotGap = 8;
    const firstPageSlotsTop = 40;
    const normalPageSlotsTop = margin; // Start exactly at margin now that branding is removed

    const getSlotLayout = (isFirstPage) => {
        const slotsTop = isFirstPage ? firstPageSlotsTop : normalPageSlotsTop;
        const available = pageHeight - margin - slotsTop;
        return {
            slotsTop,
            slotHeight: (available - slotGap) / 2
        };
    };

    // --- Pre-calculate Page Destinations for Links & Bookmarks ---
    const shotDestinations = new Map(); // shotIndex -> pageNumber
    let currentDryPage = 1;

    // 1. Calculate TOC page count
    const tocPages = (() => {
        if (sortedTocEntries.length === 0) return 0;
        let count = 1;
        const bottomLimit = pageHeight - margin - 15;
        let y = margin + 24;
        for (const entry of sortedTocEntries) {
            const level = normalizeTOCLevel(entry.level);
            const lineHeight = level === 'H1' ? 5.2 : (level === 'H2' ? 4.8 : 4.6);
            const label = (entry.numPrefix || "") + entry.title;
            const lines = doc.splitTextToSize(label, contentWidth - (level === 'H1' ? 0 : (level === 'H2' ? 6 : 12)));
            const required = (lines.length * lineHeight) + 1.4;
            if (y + required > bottomLimit) {
                count++;
                y = margin + 16;
            }
            y += required;
        }
        return count;
    })();


    const frontPagesCount = 1 + (sortedTocEntries.length > 0 ? tocPages : 0);

    // 2. Pre-calculate destinations for ALL items
    const unifiedItemsForSizing = [
        ...sortedShots.map((s, idx) => ({ type: 'shot', data: s, index: idx + 1, time: s.timestampMs || 0 })),
        ...sortedTocEntries.map(e => ({ type: 'toc', data: e, time: e.timestampMs || 0 }))
    ].sort((a, b) => a.time - b.time);

    const calculateShotHeight = (shot, isFullPage) => {
        const noteHtml = getScreenshotNoteHtml(shot);
        const noteText = getMeaningfulNoteText(noteHtml);
        const lines = Math.max(1, Math.ceil(noteText.length / 85));
        const notesH = noteText.length > 0 ? (10 + (lines * 4.5)) : 0;
        const imgH = isFullPage ? 120 : 105; // Restored to 105mm for impactful visual size
        return 5 + imgH + notesH + 4; // Header(5) + Image + Notes + Padding
    };

    const isShotFullPage = (shot, yInPage, layout) => {
        const noteText = getMeaningfulNoteText(getScreenshotNoteHtml(shot));
        const estimatedLines = Math.ceil(noteText.length / 85);
        const isVeryLong = noteText.length > 400 || estimatedLines > 8;
        // If it's a fresh page and somewhat long, mark as full page to get better resolution
        if (yInPage < layout.slotsTop + 10 && noteText.length > 260) return true;
        if (isVeryLong) return true;
        return false;
    };

    const getItemKey = (itemOrRecord) => {
        if (!itemOrRecord) return "unknown";
        if (itemOrRecord.type) {
            // It's a wrapped item { type, data }
            return itemOrRecord.type === 'shot'
                ? `shot-${itemOrRecord.data.id}`
                : `toc-${itemOrRecord.data.id}`;
        }
        // It's a direct record (shot or TOC entry)
        if (itemOrRecord.level !== undefined || itemOrRecord.numPrefix !== undefined) {
            return `toc-${itemOrRecord.id}`;
        }
        return `shot-${itemOrRecord.id}`;
    };

    const itemDestinations = new Map();
    const itemLayoutCache = new Map(); // Store fullPage and estH to prevent drift
    let currentCalcPage = frontPagesCount + 1;
    const layout = getSlotLayout(false);
    let yInCalcPage = layout.slotsTop;
    let slotCount = 0;

    for (let i = 0; i < unifiedItemsForSizing.length; i++) {
        const item = unifiedItemsForSizing[i];
        const itemKey = getItemKey(item);

        if (item.type === 'toc') {
            // Marker required space is 22mm. Sync threshold with rendering exactly.
            if (yInCalcPage + 22 > pageHeight - margin) {
                currentCalcPage++;
                yInCalcPage = layout.slotsTop;
                slotCount = 0;
            }
            itemDestinations.set(itemKey, { page: currentCalcPage, y: yInCalcPage });
            yInCalcPage += 22;
            continue;
        }

        // Shot sizing pass
        const shot = item.data;
        const useFullPage = isShotFullPage(shot, yInCalcPage, layout);
        const estH = calculateShotHeight(shot, useFullPage);

        // Cache these decisions for the rendering pass
        itemLayoutCache.set(itemKey, { useFullPage, estH });

        if (useFullPage) {
            // Sync fullPage break condition: (slotCount > 0 or y > top+20)
            if (slotCount !== 0 || yInCalcPage > layout.slotsTop + 20) {
                currentCalcPage++;
                yInCalcPage = layout.slotsTop;
                slotCount = 0;
            }
            itemDestinations.set(itemKey, { page: currentCalcPage, y: yInCalcPage });
            yInCalcPage += estH + slotGap;
            slotCount++;
            continue;
        }

        // Standard slot sizing
        if (yInCalcPage + estH > pageHeight - margin) {
            currentCalcPage++;
            yInCalcPage = layout.slotsTop;
            slotCount = 0;
        }
        itemDestinations.set(itemKey, { page: currentCalcPage, y: yInCalcPage });
        yInCalcPage += estH + slotGap;
        slotCount++;
    }

    const getItemDestination = (itemOrRecord) => {
        const key = getItemKey(itemOrRecord);
        return itemDestinations.get(key) || { page: frontPagesCount + 1, y: layout.slotsTop };
    };

    // --- Outline / Bookmarks (PDF Sidebar) ---
    if (doc.outline) {
        const topNode = doc.outline.add(null, "Video Notes");
        if (sortedTocEntries.length > 0) {
            const tocNode = doc.outline.add(topNode, "Table of Contents", { pageNumber: 1 });
            let currentH1 = tocNode;
            let currentH2 = tocNode;

            sortedTocEntries.forEach(entry => {
                const dest = getItemDestination(entry);
                const destPage = dest.page;
                const level = normalizeTOCLevel(entry.level);
                const title = `[${entry.numPrefix || ""}] ${entry.title}`;

                if (level === 'H1') {
                    currentH1 = doc.outline.add(tocNode, title, { pageNumber: destPage });
                    currentH2 = currentH1;
                } else if (level === 'H2') {
                    currentH2 = doc.outline.add(currentH1, title, { pageNumber: destPage });
                } else {
                    doc.outline.add(currentH2, title, { pageNumber: destPage });
                }
            });
        }
    }

    const drawCoverPage = async (thumb) => {
        // Page 1 Background
        doc.setFillColor(249, 250, 251);
        doc.rect(0, 0, pageWidth, pageHeight, 'F');

        // Branding
        if (appIconDataUrl) {
            doc.addImage(appIconDataUrl, 'PNG', margin, margin, 12, 12);
        }
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(15, 23, 42);
        doc.text(PDF_BRAND_NAME, appIconDataUrl ? margin + 15 : margin, margin + 8.5);

        // Title block
        const titleY = margin + 40;
        doc.setFontSize(26);
        doc.setTextColor(15, 23, 42);
        const wrappedTitle = doc.splitTextToSize(title, contentWidth);
        doc.text(wrappedTitle, margin, titleY);

        let nextY = titleY + (wrappedTitle.length * 10) + 10;

        // Thumbnail
        if (thumb) {
            const thumbWidth = contentWidth;
            const thumbHeight = (thumbWidth * 9) / 16;
            doc.setDrawColor(226, 232, 240);
            doc.setLineWidth(0.5);
            doc.roundedRect(margin - 1, nextY - 1, thumbWidth + 2, thumbHeight + 2, 2, 2, 'D');
            doc.addImage(thumb, 'JPEG', margin, nextY, thumbWidth, thumbHeight);
            nextY += thumbHeight + 20;
        } else {
            nextY += 20;
        }

        // Info Box
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        const infoBoxHeight = 42;
        doc.roundedRect(margin, nextY, contentWidth, infoBoxHeight, 3, 3, 'FD');

        doc.setFontSize(11);
        doc.setTextColor(71, 85, 105);
        doc.setFont(undefined, 'bold');
        doc.text("Complete Automated Video Report", margin + 8, nextY + 12);

        doc.setFont(undefined, 'normal');
        doc.setFontSize(10);
        doc.setTextColor(100, 116, 139);
        doc.text(`Channel: ${state.metadata.channel || "Unknown Channel"}`, margin + 8, nextY + 20);
        doc.text(`Duration: ${totalDuration}`, margin + 8, nextY + 26);
        doc.text(`Generated At: ${generatedAt}`, margin + 8, nextY + 32);
        doc.text(`Original URL: ${state.metadata.videoUrl || "YouTube"}`, margin + 8, nextY + 38);

        // Final aesthetic touch at bottom
        doc.setFontSize(9);
        doc.setTextColor(14, 165, 233);
        doc.setFont(undefined, 'bold');
        doc.text("Powered by Clip Notes • Intelligent Video Documentation", pageWidth / 2, pageHeight - 15, { align: 'center' });
    };

    const drawSimpleBranding = () => {
        // [DELETED] Branding removed per user request for a cleaner look
    };

    const drawMetadataHeader = () => {
        // [DELETED] detailed metadata header per user request to save space
    };

    const drawTOCHeading = (yPos, isContinuation = false) => {
        const headingText = isContinuation ? "Table of Contents (cont.)" : "Table of Contents";
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(14, 165, 233); // Sky-500 professional blue
        doc.text(headingText, margin, yPos);

        // Underline
        const textWidth = doc.getTextWidth(headingText);
        doc.setDrawColor(14, 165, 233);
        doc.setLineWidth(0.4);
        doc.line(margin, yPos + 1.5, margin + textWidth, yPos + 1.5);
    };

    const drawTOCSection = () => {
        if (sortedTocEntries.length === 0) return;

        // Dedicated page(s) for TOC
        doc.addPage();
        const bottomLimit = pageHeight - margin - 15;
        let y = margin + 12;
        drawTOCHeading(y, false);
        y += 12;

        for (const entry of sortedTocEntries) {
            const level = normalizeTOCLevel(entry.level);
            const indent = level === 'H1' ? 0 : (level === 'H2' ? 6 : 12);
            const lineHeight = level === 'H1' ? 5.8 : (level === 'H2' ? 5.2 : 5);

            if (level === 'H1') {
                doc.setFontSize(12);
                doc.setFont(undefined, 'bold');
                doc.setTextColor(15, 23, 42);
            } else if (level === 'H2') {
                doc.setFontSize(10.5);
                doc.setFont(undefined, 'bold');
                doc.setTextColor(30, 41, 59);
            } else {
                doc.setFontSize(10);
                doc.setFont(undefined, 'normal');
                doc.setTextColor(51, 65, 85);
            }

            const dest = getItemDestination(entry);
            const destPage = dest.page;
            const relativePageNum = Math.max(1, destPage - frontPagesCount);
            const pageNumStr = String(relativePageNum);
            const pageNumWidth = doc.getTextWidth(pageNumStr);
            const titleStr = entry.title;
            const fullTitle = (entry.numPrefix || "") + titleStr;

            // Calculate dots
            const titleWidthLimit = contentWidth - indent - pageNumWidth - 8;
            const truncatedTitleLines = doc.splitTextToSize(fullTitle, titleWidthLimit);
            const requiredLinesHeight = (truncatedTitleLines.length * lineHeight);

            if (y + requiredLinesHeight > bottomLimit) {
                doc.addPage();
                y = margin + 12;
                drawTOCHeading(y, true);
                y += 12;
            }

            // Clickable link to exact marker destination for precise navigation
            if (typeof doc.addDestination === 'function') {
                const destKey = getItemKey(entry);
                doc.link(margin + indent, y - 4, contentWidth - indent, requiredLinesHeight + 2, { destination: destKey });
            } else {
                doc.link(margin + indent, y - 4, contentWidth - indent, requiredLinesHeight + 2, { pageNumber: destPage });
            }

            // Draw Title Lines
            doc.text(truncatedTitleLines, margin + indent, y);

            // Draw Dots and Page Number (only on the last line of the title if multi-line)
            const lastLineY = y + ((truncatedTitleLines.length - 1) * lineHeight);
            const lastLineWidth = doc.getTextWidth(truncatedTitleLines[truncatedTitleLines.length - 1]);

            doc.setFont(undefined, 'normal');
            doc.setTextColor(148, 163, 184); // Muted dots
            const dotsX = margin + indent + lastLineWidth + 2;
            const dotsEnd = margin + contentWidth - pageNumWidth - 4;
            if (dotsEnd > dotsX) {
                const dotCount = Math.floor((dotsEnd - dotsX) / 1.5);
                doc.text(".".repeat(dotCount), dotsX, lastLineY);
            }

            doc.setFont(undefined, 'bold');
            doc.setTextColor(15, 23, 42);
            doc.text(pageNumStr, margin + contentWidth, lastLineY, { align: 'right' });


            y += requiredLinesHeight + 1.5;
        }
    };

    const drawShotCard = async (shot, shotIndex, regionTop, regionBottom, options = {}) => {
        const fullPage = !!options.fullPage;
        const hasShotImage = !!shot.dataUrl;
        const noteHtml = getScreenshotNoteHtml(shot);
        const noteText = getMeaningfulNoteText(noteHtml);
        const noteTextForFallback = getPlainTextWithBreaksFromHtml(noteHtml);
        const hasNote = noteText.length > 0;

        let y = regionTop;

        doc.setFontSize(9.5);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(71, 85, 105); // Muted slate color
        doc.text(`Screenshot ${shotIndex} - ${shot.timeFormatted || "00:00"}`, margin, y);
        doc.setFont(undefined, 'normal');
        y += 5;

        if (hasShotImage) {
            try {
                const shotImageSrc = await ensureDataUrlFromBlob(shot.dataUrl);
                const shotImageMeta = await loadImageFromDataUrl(shotImageSrc);
                if (!shotImageMeta || !shotImageMeta.width || !shotImageMeta.height) {
                    throw new Error("Could not load screenshot image metadata.");
                }
                const maxHeight = fullPage ? 120 : 105; // Synced with calculateShotHeight (restored from 85)
                const minHeight = fullPage ? 48 : 34;

                let reserveForNotes = 0;
                if (hasNote) {
                    const estimatedNoteLines = Math.max(1, Math.ceil(noteText.length / 85));
                    reserveForNotes = 10 + (estimatedNoteLines * 4.5);
                }

                let availableForImage = regionBottom - y - reserveForNotes;
                if (availableForImage < 6) availableForImage = 6; // Minimum height for image to be drawn

                const heightLimit = Math.min(maxHeight, availableForImage);
                let fitted = fitImageWithinBox(
                    shotImageMeta.width,
                    shotImageMeta.height,
                    contentWidth,
                    heightLimit,
                    Math.min(minHeight, availableForImage)
                );
                let imageWidth = fitted.width;
                let imageHeight = fitted.height;

                const remainingHeight = regionBottom - y - 4;
                if (remainingHeight <= 0) {
                    imageHeight = 0;
                } else if (imageHeight > remainingHeight) {
                    fitted = fitImageWithinBox(
                        shotImageMeta.width,
                        shotImageMeta.height,
                        contentWidth,
                        remainingHeight,
                        0
                    );
                    imageWidth = fitted.width;
                    imageHeight = fitted.height;
                }

                if (imageHeight > 8) {
                    const imageX = margin + ((contentWidth - imageWidth) / 2);
                    doc.addImage(shotImageSrc, 'PNG', imageX, y, imageWidth, imageHeight, undefined, 'FAST');
                    y += imageHeight + 2;
                }
            } catch (err) {
                console.error("PDF image section failed:", err);
            }
        }

        if (hasNote) {
            const cleanedNoteHtml = sanitizeHtmlForEditorAndExport(noteHtml, {
                maxFontPx: 24,
                keepLinks: false
            });

            doc.setFontSize(9);
            doc.setFont(undefined, 'bold');
            doc.setTextColor(52, 62, 73);
            doc.text("Notes", margin, y + 2);
            doc.setFont(undefined, 'normal');
            y += 4.5;

            if (cleanedNoteHtml) {
                let noteImg = await renderRichTextToCanvas(
                    `<div>${cleanedNoteHtml}</div>`,
                    noteRenderWidthPx,
                    {
                        fontSize: '15px',
                        maxFontPx: 24,
                        lineHeight: '1.55',
                        color: '#111827',
                        bgColor: '#ffffff',
                        scale: 2
                    }
                );

                if (noteImg) {
                    try {
                        const probe = await loadImageFromDataUrl(noteImg);
                        if (!probe || probe.width < 40 || probe.height < 16) {
                            noteImg = null;
                        }
                    } catch {
                        noteImg = null;
                    }
                }

                if (noteImg) {
                    if (fullPage) {
                        y = await addImageDataToPdfWithPaging(doc, noteImg, margin, y, contentWidth, {
                            marginMm: margin,
                            gapMm: 2,
                            compression: 'NONE'
                        });
                    } else {
                        const noteMeta = await loadImageFromDataUrl(noteImg);
                        const noteNaturalHeight = (noteMeta.height * contentWidth) / noteMeta.width;
                        const noteAllowedHeight = Math.max(0, regionBottom - y - 1);

                        if (noteAllowedHeight > 4) {
                            const renderHeight = Math.min(noteNaturalHeight, noteAllowedHeight);
                            doc.addImage(noteImg, 'PNG', margin, y, contentWidth, renderHeight, undefined, 'NONE');
                            y += renderHeight + 1;
                        }
                    }
                } else {
                    // Fallback 1: draw plain text through canvas so Unicode and spacing stay stable.
                    const plainNoteImg = await renderPlainTextToCanvas(noteTextForFallback || noteText, noteRenderWidthPx, {
                        fontSizePx: 16,
                        lineHeightPx: 24,
                        paddingPx: 16,
                        color: '#111827',
                        bgColor: '#ffffff',
                        scale: 2
                    });

                    if (plainNoteImg) {
                        if (fullPage) {
                            y = await addImageDataToPdfWithPaging(doc, plainNoteImg, margin, y, contentWidth, {
                                marginMm: margin,
                                gapMm: 2,
                                compression: 'NONE'
                            });
                        } else {
                            const noteMeta = await loadImageFromDataUrl(plainNoteImg);
                            const noteNaturalHeight = (noteMeta.height * contentWidth) / noteMeta.width;
                            const noteAllowedHeight = Math.max(0, regionBottom - y - 1);
                            if (noteAllowedHeight > 4) {
                                const renderHeight = Math.min(noteNaturalHeight, noteAllowedHeight);
                                doc.addImage(plainNoteImg, 'PNG', margin, y, contentWidth, renderHeight, undefined, 'NONE');
                                y += renderHeight + 1;
                            }
                        }
                    } else {
                        // Fallback 2 (last resort): jsPDF native text.
                        const lines = doc.splitTextToSize(noteText, contentWidth - 2);
                        if (fullPage) {
                            const lineHeight = 4.6;
                            const bottomLimit = pageHeight - margin;
                            for (const line of lines) {
                                if (y + lineHeight > bottomLimit) {
                                    doc.addPage();
                                    y = margin;
                                }
                                doc.setFontSize(10);
                                doc.setTextColor(47, 61, 74);
                                doc.text(line, margin, y + 3);
                                y += lineHeight;
                            }
                            y += 2;
                        } else {
                            const lineHeight = 4.3;
                            const noteAllowedHeight = Math.max(0, regionBottom - y - 1);
                            if (noteAllowedHeight > 4) {
                                const maxLines = Math.max(1, Math.floor(noteAllowedHeight / lineHeight));
                                const clipped = lines.slice(0, maxLines);
                                doc.setFontSize(9.5);
                                doc.setTextColor(47, 61, 74);
                                doc.text(clipped, margin, y + 3);
                                y += Math.min(noteAllowedHeight, (clipped.length * lineHeight));
                            }
                        }
                    }
                }
            }
        }

        return y;
    };

    const drawInFlowTOCMarker = (entry, y) => {
        const level = normalizeTOCLevel(entry.level);
        const indent = level === 'H1' ? 0 : (level === 'H2' ? 4 : 8);
        const fontSize = level === 'H1' ? 12 : (level === 'H2' ? 10.5 : 9.5);

        // Define named destination for precise linking
        if (typeof doc.addDestination === 'function') {
            // Unify with getItemKey (e.g., toc-12345) to ensure strings are safe and consistent.
            // Zoom 1 (instead of 0/inherit) is often more reliable across PDF viewers.
            const destKey = getItemKey(entry);
            doc.addDestination(destKey, 'XYZ', 0, y - 2, 1);
        }

        // Background for marker
        doc.setFillColor(240, 249, 255); // Sky-50 light blue
        doc.setDrawColor(186, 230, 253); // Sky-200
        doc.roundedRect(margin + indent, y, contentWidth - indent, 10, 1.5, 1.5, 'FD');

        // Marker Tag
        doc.setFillColor(14, 165, 233); // Sky-500
        doc.roundedRect(margin + indent + 2, y + 2.5, 18, 5, 1, 1, 'F');
        doc.setFontSize(7.5);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(255, 255, 255);
        doc.text(level, margin + indent + 11, y + 6.1, { align: 'center' });

        // Prefix & Title 
        doc.setFontSize(fontSize);
        doc.setTextColor(15, 23, 42);
        doc.setFont(undefined, 'bold');
        const fullDisplay = (entry.numPrefix || "") + entry.title;
        doc.text(fullDisplay, margin + indent + 22, y + 6.5);

        return y + 22; // Increased from 18 to 22 to prevent overlap and match sizing
    };

    await drawCoverPage(thumbnailDataUrl);

    if (sortedTocEntries.length > 0) {
        report("Rendering table of contents...");
        drawTOCSection();
    }

    // --- Unified Rendering Loop ---
    const allItems = [
        ...sortedShots.map((s, idx) => ({ type: 'shot', data: s, index: idx + 1, time: s.timestampMs || 0 })),
        ...sortedTocEntries.map(e => ({ type: 'toc', data: e, time: e.timestampMs || 0 }))
    ].sort((a, b) => a.time - b.time);

    // Performance: Chunk rendering with proper async yielding to prevent UI freeze
    const CHUNK_SIZE = 3; // Yield every 3 items for smoother UI
    const YIELD_DELAY_MS = 10; // Give UI thread 10ms to breathe

    if (allItems.length > 0) {
        doc.addPage();

        let layout = getSlotLayout(false); // After cover/toc, always normal top
        let slotIndex = 0;
        let yInPage = layout.slotsTop;

        // Initial branding for first content page
        drawSimpleBranding();

        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];

            // NON-BLOCKING: Yield to UI thread more frequently to prevent freeze
            if (i > 0 && i % CHUNK_SIZE === 0) {
                const progress = Math.round((i / allItems.length) * 100);
                report(`Rendering pages... ${progress}%`);

                // Use requestIdleCallback if available for optimal scheduling, fallback to setTimeout
                if (typeof requestIdleCallback === 'function') {
                    await new Promise(resolve => requestIdleCallback(resolve, { timeout: 50 }));
                } else {
                    await new Promise(resolve => setTimeout(resolve, YIELD_DELAY_MS));
                }
            }

            if (item.type === 'toc') {
                // Absolute Sync: use 22mm threshold matching sizing pass
                if (yInPage + 22 > pageHeight - margin) {
                    doc.addPage();
                    layout = getSlotLayout(false);
                    yInPage = layout.slotsTop;
                    slotIndex = 0;
                    drawSimpleBranding();
                }
                yInPage = drawInFlowTOCMarker(item.data, yInPage);
                continue;
            }

            // Also add destination for shot images if needed, but primarily markers
            if (item.type === 'shot' && typeof doc.addDestination === 'function') {
                doc.addDestination(`shot-${item.data.id}`, 'XYZ', 0, yInPage - 2, 0);
            }

            const shot = item.data;
            const itemKey = getItemKey(item);
            const cached = itemLayoutCache.get(itemKey) || { useFullPage: false, estH: 60 };
            const useFullPage = cached.useFullPage;
            const estH = cached.estH;

            report(`Rendering screenshot ${item.index} of ${sortedShots.length}...`);

            if (useFullPage) {
                // Absolute Sync: check against 20mm threshold
                if (slotIndex !== 0 || yInPage > layout.slotsTop + 20) {
                    doc.addPage();
                    layout = getSlotLayout(false);
                    yInPage = layout.slotsTop;
                    slotIndex = 0;
                    drawSimpleBranding();
                }

                const fullTop = yInPage;
                const fullBottom = yInPage + estH;
                await drawShotCard(shot, item.index, fullTop, fullBottom, { fullPage: true });
                yInPage = fullTop + estH + slotGap;
                slotIndex++;
                continue;
            }

            // Normal shot card rendering
            if (yInPage + estH > pageHeight - margin) {
                doc.addPage();
                layout = getSlotLayout(false);
                yInPage = layout.slotsTop;
                slotIndex = 0;
                drawSimpleBranding();
            }

            const slotTop = yInPage;
            const slotBottom = yInPage + estH;
            await drawShotCard(shot, item.index, slotTop, slotBottom, { fullPage: false });
            yInPage = slotTop + estH + slotGap;
            slotIndex++;
        }
    }

    report("Finalizing pages...");

    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);

        // Hide page numbers on Cover and TOC pages
        if (i <= frontPagesCount) {
            // No footer on front matter
        } else {
            // Aesthetic Footer line
            doc.setDrawColor(226, 232, 240);
            doc.setLineWidth(0.2);
            doc.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10);

            doc.setFontSize(8.5);
            doc.setTextColor(100, 116, 139);
            const relativePage = i - frontPagesCount;
            const relativeTotal = totalPages - frontPagesCount;
            doc.text(`Page ${relativePage} of ${relativeTotal}`, pageWidth - margin, pageHeight - 6, { align: 'right' });

            // Brand and Icon in footer
            if (appIconDataUrl) {
                doc.addImage(appIconDataUrl, 'PNG', margin, pageHeight - 9, 4, 4);
                doc.text(PDF_BRAND_NAME, margin + 5, pageHeight - 6);
            } else {
                doc.text(PDF_BRAND_NAME, margin, pageHeight - 6);
            }

            // "Back to TOC" link
            if (sortedTocEntries.length > 0) {
                doc.setTextColor(14, 165, 233); // Sky-500
                const backText = "Back to Table of Contents";
                doc.text(backText, margin + (contentWidth / 2), pageHeight - 6, { align: 'center' });
                const backWidth = doc.getTextWidth(backText);
                // Page 2 is always TOC start because Page 1 is Cover
                doc.link(margin + (contentWidth / 2) - (backWidth / 2), pageHeight - 9, backWidth, 4, { pageNumber: 2 });
            }
        }
    }

    report("Ready to save...");
    return doc;
}

async function handleExportPDF() {
    showExportProgressDialog("Choose save location...");

    try {
        const title = document.getElementById('video-title').textContent || "YouTube Notes";
        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
        const filename = `${safeTitle}_${Date.now().toString().slice(-4)}.pdf`;

        const fileHandle = await FileSystemModule.pickPdfSaveFileHandle(filename);
        if (!fileHandle) {
            showToast("PDF export cancelled", "info");
            return;
        }

        updateExportProgressDialog("Starting PDF export...");

        // Use the existing generatePDFDoc function (already tested and working)
        const doc = await generatePDFDoc((message) => {
            updateExportProgressDialog(message || "Exporting PDF...");
        });
        
        if (!doc) {
            hideExportProgressDialog();
            return;
        }

        updateExportProgressDialog("Saving PDF...");

        const pdfBlob = doc.output('blob');
        const saved = await FileSystemModule.writeFileHandle(fileHandle, pdfBlob);
        if (saved) {
            console.log("PDF saved via Save As dialog.");
            showToast("PDF saved successfully!", "success");
        } else {
            showToast("PDF export failed", "error");
        }
    } catch (err) {
        console.error("PDF export failed:", err);
        await showAlert("PDF export failed: " + err.message);
    } finally {
        hideExportProgressDialog();
    }
}

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.error("Failed to convert image to base64:", e);
        return null;
    }
}

async function handleExportWatchLaterPDF() {
    if (state.watchLaterList.length === 0) {
        await showAlert("Watch Later list is empty!");
        return;
    }

    showExportProgressDialog("Choose save location...");

    try {
        const filename = `YouTube_Watch_Later_${Date.now().toString().slice(-4)}.pdf`;
        const fileHandle = await FileSystemModule.pickPdfSaveFileHandle(filename);
        if (!fileHandle) {
            showToast("Watch Later export cancelled", "info");
            return;
        }

        updateExportProgressDialog("Starting Watch Later PDF export...");

        const doc = await generateWatchLaterPDFDoc((message) => {
            updateExportProgressDialog(message || "Exporting Watch Later List...");
        });
        
        if (!doc) {
            hideExportProgressDialog();
            return;
        }

        updateExportProgressDialog("Saving PDF...");

        const pdfBlob = doc.output('blob');
        const saved = await FileSystemModule.writeFileHandle(fileHandle, pdfBlob);
        if (saved) {
            showToast("Watch Later PDF saved successfully!", "success");
        } else {
            showToast("Watch Later export failed", "error");
        }
    } catch (err) {
        console.error("Watch Later PDF export failed:", err);
        await showAlert("Export failed: " + err.message);
    } finally {
        hideExportProgressDialog();
    }
}

async function generateWatchLaterPDFDoc(progressCallback = null) {
    if (!window.jspdf && !window.jsPDF) {
        await showAlert("PDF Library not loaded properly.");
        return null;
    }

    const jsPDFBuilder = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
    if (!jsPDFBuilder) {
        await showAlert("Could not initialize JS PDF builder.");
        return null;
    }

    const doc = new jsPDFBuilder();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;

    // Title
    doc.setFontSize(22);
    doc.setTextColor(40, 40, 40);
    doc.text("YouTube Watch Later List", margin, 30);

    // Metadata
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, margin, 40);
    doc.text(`Total Videos: ${state.watchLaterList.length}`, margin, 45);

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, 50, pageWidth - margin, 50);

    let y = 65;
    const sorted = [...state.watchLaterList].sort((a, b) => a.priority - b.priority || b.addedAt - a.addedAt);

    for (let i = 0; i < sorted.length; i++) {
        const item = sorted[i];

        // Page break check
        if (y > pageHeight - 50) {
            doc.addPage();
            y = 30;
        }

        // Fetch Thumbnail
        if (item.thumbnail) {
            const base64 = await imageUrlToBase64(item.thumbnail);
            if (base64) {
                try {
                    doc.addImage(base64, 'JPEG', margin, y - 5, 32, 18);
                } catch (e) {
                    console.error("Failed to add thumbnail to PDF:", e);
                }
            }
        }

        const contentX = margin + 38;

        // Priority Icon/Color
        let priorityColor = [100, 100, 100];
        if (item.priority === 1) priorityColor = [231, 76, 60]; // Red
        else if (item.priority === 2) priorityColor = [241, 196, 15]; // Yellow
        else if (item.priority === 3) priorityColor = [52, 152, 219]; // Blue

        // Priority Badge
        doc.setFillColor(...priorityColor);
        doc.roundedRect(contentX, y - 5, 12, 8, 1.5, 1.5, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(7);
        doc.text(`P${item.priority}`, contentX + 6, y + 0.5, { align: 'center' });

        // Title
        doc.setTextColor(30, 30, 30);
        doc.setFontSize(11);
        const splitTitle = doc.splitTextToSize(item.title, pageWidth - contentX - 25);
        doc.text(splitTitle, contentX + 15, y);
        
        y += (splitTitle.length * 5.5);

        // Subtext (Date Added)
        doc.setFontSize(8);
        doc.setTextColor(120, 120, 120);
        const dateStr = new Date(item.addedAt).toLocaleDateString();
        doc.text(`Added: ${dateStr} • Progress: ${item.progressPercentage}%`, contentX + 15, y);
        
        y += 5;

        // Link (Clickable)
        const url = `https://www.youtube.com/watch?v=${item.videoId}`;
        doc.setTextColor(52, 152, 219);
        doc.setFontSize(8);
        doc.textWithLink(url, contentX + 15, y, { url });
        
        y += 20; // Gap between items
        
        if (progressCallback) progressCallback(`Processing video ${i+1}/${sorted.length}`);
    }

    // Page Numbers
    const totalPages = doc.internal.getNumberOfPages();
    for (let j = 1; j <= totalPages; j++) {
        doc.setPage(j);
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(`Page ${j} of ${totalPages}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    }

    return doc;
}

let previewObserver = null;
let previewPageData = [];
let previewRenderedPages = new Set();

function getMeaningfulNoteTextForPreview(html) {
    const plain = getPlainTextFromHtmlForExport(html);
    const normalized = String(plain || "")
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.]+$/g, '')
        .trim();

    if (!normalized) return "";

    const placeholders = new Set([
        'no notes attached',
        'no note attached',
        'no notes',
        'none',
        'n/a',
        'na',
        '-'
    ]);

    return placeholders.has(normalized) ? "" : plain;
}

function buildPreviewPagePlan() {
    const pages = [];

    const sortedShots = [...state.screenshots].sort((a, b) => {
        const aVal = a.createdAt || a.timestampMs || 0;
        const bVal = b.createdAt || b.timestampMs || 0;
        return aVal - bVal;
    });

    const sortedTocEntries = sortTOCByTimeline(
        (Array.isArray(state.toc) ? state.toc : []).map((entry, idx) => normalizeTOCRecord(entry, idx))
    ).filter(entry => String(entry.title || "").trim().length > 0);

    if (sortedTocEntries.length > 0) {
        const tocLinesPerPage = 34;
        let current = [];
        let used = 0;

        sortedTocEntries.forEach((entry) => {
            const label = `${entry.timeFormatted || "00:00"} ${entry.title || ""}`;
            const estimatedLines = Math.max(1, Math.ceil(label.length / 60));
            if (used + estimatedLines > tocLinesPerPage && current.length > 0) {
                pages.push({ kind: 'toc', entries: current, continuation: pages.length > 0 });
                current = [];
                used = 0;
            }
            current.push(entry);
            used += estimatedLines;
        });

        if (current.length > 0) {
            pages.push({ kind: 'toc', entries: current, continuation: pages.length > 0 });
        }
    }

    let currentPage = null;
    sortedShots.forEach((shot, idx) => {
        const noteHtml = getScreenshotNoteHtml(shot);
        const noteText = getMeaningfulNoteTextForPreview(noteHtml);
        const estimatedLines = Math.ceil(noteText.length / 85);
        const useFullPage = noteText.length > 260 || estimatedLines > 4;

        if (useFullPage) {
            pages.push({ kind: 'shots', slots: [{ shot, index: idx + 1 }], full: true });
            currentPage = null;
            return;
        }

        if (!currentPage || currentPage.full || currentPage.slots.length >= 2) {
            currentPage = { kind: 'shots', slots: [], full: false };
            pages.push(currentPage);
        }

        currentPage.slots.push({ shot, index: idx + 1 });
    });

    return pages;
}

function renderPreviewPlaceholders(pages) {
    const container = document.getElementById('pdf-preview-pages');
    if (!container) return;
    container.innerHTML = '';
    pages.forEach((page, idx) => {
        const pageEl = document.createElement('div');
        pageEl.className = 'pdf-preview-page';
        pageEl.dataset.pageIndex = String(idx);
        pageEl.innerHTML = `<div class="preview-page-placeholder">Loading page ${idx + 1}...</div>`;
        container.appendChild(pageEl);
    });
}

function renderPreviewPage(pageEl, page, pageIndex) {
    if (!pageEl || !page) return;

    const inner = document.createElement('div');
    inner.className = 'pdf-preview-page-inner';

    if (pageIndex === 0) {
        const title = document.getElementById('video-title')?.textContent || "YouTube Notes";
        const durationText = document.getElementById('time-display')?.textContent || "";
        const totalDuration = durationText.split('/')[1]?.trim() || "Unknown";
        const generatedAt = new Date().toLocaleString();
        const meta = document.createElement('div');
        meta.className = 'preview-meta';
        meta.innerHTML = `
            <div><strong>${title}</strong></div>
            <div>Generated: ${generatedAt}</div>
            <div>Total Screenshots: ${state.screenshots.length}</div>
            <div>Video Duration: ${totalDuration}</div>
            <div>Source: ${state.metadata?.videoUrl || "YouTube"}</div>
        `;
        inner.appendChild(meta);
    }

    if (page.kind === 'toc') {
        const tocTitle = document.createElement('div');
        tocTitle.className = 'preview-toc-title';
        tocTitle.textContent = page.continuation ? 'Table of Contents (cont.)' : 'Table of Contents';
        inner.appendChild(tocTitle);

        const list = document.createElement('div');
        list.className = 'preview-toc-list';
        page.entries.forEach((entry) => {
            const row = document.createElement('div');
            const level = normalizeTOCLevel(entry.level);
            row.className = `preview-toc-entry preview-toc-level-${level.toLowerCase()}`;

            const time = document.createElement('div');
            time.className = 'preview-toc-time';
            time.textContent = entry.timeFormatted || "00:00";

            const title = document.createElement('div');
            title.textContent = entry.title || "";

            row.appendChild(time);
            row.appendChild(title);
            list.appendChild(row);
        });
        inner.appendChild(list);
    }

    if (page.kind === 'shots') {
        page.slots.forEach((slot) => {
            const shot = slot.shot;
            const shotWrap = document.createElement('div');
            shotWrap.className = 'preview-shot';
            // Tag with ID for dynamic background rehydration updates
            shotWrap.setAttribute('data-shot-id', shot.id || shot.filename);

            const title = document.createElement('div');
            title.className = 'preview-shot-title';
            title.textContent = `Screenshot ${slot.index} - ${shot.timeFormatted || "00:00"}`;
            shotWrap.appendChild(title);

            const img = document.createElement('img');
            img.className = 'preview-shot-image';
            if (shot.dataUrl) {
                img.src = shot.dataUrl;
            } else if (shot.missingOnDisk) {
                img.src = MISSING_SCREENSHOT_PLACEHOLDER_DATA_URL;
            } else {
                // Placeholder while background rehydration works
                img.src = TRANSPARENT_PIXEL_DATA_URL;
                img.classList.add('loading');
            }
            img.alt = `Screenshot ${slot.index}`;
            img.loading = 'lazy';
            shotWrap.appendChild(img);


            const noteHtml = getScreenshotNoteHtml(shot);
            const noteText = getMeaningfulNoteTextForPreview(noteHtml);
            if (noteText) {
                const noteWrap = document.createElement('div');
                noteWrap.className = 'preview-shot-notes';
                const cleaned = sanitizeHtmlForEditorAndExport(noteHtml, {
                    maxFontPx: 24,
                    keepLinks: false
                });
                noteWrap.innerHTML = `<div class="preview-notes-title">Notes</div>${cleaned || ''}`;
                shotWrap.appendChild(noteWrap);
            }

            inner.appendChild(shotWrap);
        });
    }

    pageEl.innerHTML = '';
    pageEl.appendChild(inner);
}

function setupPreviewObserver() {
    const container = document.getElementById('pdf-preview-pages');
    const scrollRoot = document.querySelector('#pdf-preview-overlay .preview-body');
    if (!container || !scrollRoot) return;

    if (previewObserver) {
        previewObserver.disconnect();
    }

    previewObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const idx = Number(entry.target.dataset.pageIndex);
            if (Number.isNaN(idx) || previewRenderedPages.has(idx)) return;
            renderPreviewPage(entry.target, previewPageData[idx], idx);
            previewRenderedPages.add(idx);
        });
    }, { root: scrollRoot, rootMargin: '400px 0px', threshold: 0.1 });

    container.querySelectorAll('.pdf-preview-page').forEach((pageEl) => {
        previewObserver.observe(pageEl);
    });
}

function openPdfPreviewModal() {
    const overlay = document.getElementById('pdf-preview-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
}

function closePdfPreviewModal() {
    const overlay = document.getElementById('pdf-preview-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');

    if (previewObserver) {
        previewObserver.disconnect();
        previewObserver = null;
    }
    previewRenderedPages = new Set();
    previewPageData = [];

    const container = document.getElementById('pdf-preview-pages');
    if (container) container.innerHTML = '';
}

async function initPreviewMode() {
    // Hide the main app container UI
    const container = document.querySelector('.app-container');
    if (container) container.style.display = 'none';

    // Show the preview overlay (already in HTML)
    const overlay = document.getElementById('pdf-preview-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.position = 'static'; // Allow it to take full page
        overlay.style.height = '100vh';
        overlay.style.backgroundColor = 'transparent';
        overlay.style.backdropFilter = 'none';

        const dialog = overlay.querySelector('.preview-modal');
        if (dialog) {
            dialog.style.width = '100%';
            dialog.style.height = '100%';
            dialog.style.maxWidth = 'none';
            dialog.style.borderRadius = '0';
        }

        // Setup Close Button
        const legacyCloseBtn = document.getElementById('btn-close-preview');
        if (legacyCloseBtn) {
            legacyCloseBtn.style.display = 'block';
            legacyCloseBtn.onclick = () => {
                closePDFPreview();
            };
        }
    }


    // Load data and render
    const targetVideoId = initialPanelUrlParams.get('videoId');
    const targetVideoTitle = initialPanelUrlParams.get('videoTitle');

    if (targetVideoId && targetVideoTitle) {
        currentVideoId = targetVideoId;
        currentVideoTitle = targetVideoTitle;

        // SKIP REDUNDANT SETUP: initFileSystem already called FileSystemModule.setup()
        // we only need to verify it succeeded here.
        if (!FileSystemModule.dirHandle) {
            // Fallback just in case race condition
            await FileSystemModule.setup();
        }

        if (!FileSystemModule.dirHandle) {
            console.error("PDF Preview: File system not initialized. Handle is missing.");
            showToast("Please reconnect your Save Folder in the side panel.");
            return;
        }

        // Wait for system to load video state from disk
        const pagesContainer = document.getElementById('pdf-preview-pages');
        if (pagesContainer) {
            pagesContainer.innerHTML = '<div class="preview-loading-msg">Fetching report structure...</div>';
        }

        // Wait for the JSON part of the state (now non-blocking for images if isPreview=true)
        await loadVideoState(targetVideoId, targetVideoTitle, true);

        // Trigger report build
        previewPageData = buildPreviewPagePlan();
        previewRenderedPages = new Set();

        if (pagesContainer) {
            pagesContainer.innerHTML = '';
            if (previewPageData.length === 0) {
                pagesContainer.innerHTML = '<div class="preview-empty-msg">No screenshots or notes found for this video.</div>';
            } else {
                renderPreviewPlaceholders(previewPageData);
                setupPreviewObserver();
            }
        }
    } else {
        console.error("PDF Preview: Missing videoId or videoTitle in URL parameters.");
    }
}

async function handlePreviewPDF() {
    if (state.screenshots.length === 0 && state.toc.length === 0) {
        showToast("Nothing to preview yet!");
        return;
    }

    // Build the preview URL
    const query = new URLSearchParams({
        tabId: String(currentTabId),
        videoId: String(currentVideoId),
        videoTitle: currentVideoTitle || state.metadata?.videoTitle || "Unknown Video",
        mode: 'preview'
    });
    const url = chrome.runtime.getURL(`sidepanel/panel.html?${query.toString()}`);

    console.time("PDF_PREVIEW_OPEN");

    // Open as a real popup window instead of an iframe.
    // The iframe approach is blocked by Brave Shields. A chrome.windows.create popup
    // is a first-class browser window that cannot be blocked by content blockers.
    try {
        const screen = await new Promise((resolve) => {
            chrome.tabs.sendMessage(currentTabId, { action: 'getScreenInfo' }, (res) => {
                resolve(chrome.runtime.lastError ? null : res);
            });
        });

        const width = Math.round((screen?.availWidth || 1920) * 0.65);
        const height = screen?.availHeight || 1080;
        const left = Math.round(((screen?.availWidth || 1920) - width) / 2);
        const top = screen?.availTop || 0;

        chrome.windows.create({
            url,
            type: 'popup',
            width,
            height,
            left,
            top
        });
    } catch (e) {
        console.warn("PDF Preview: Could not get screen info, falling back to default size.", e);
        chrome.windows.create({ url, type: 'popup', width: 1000, height: 850 });
    }

    console.timeEnd("PDF_PREVIEW_OPEN");
}

function closePDFPreview() {
    // With popup windows, the user closes the window directly — nothing to do from panel.
    // This is kept as a stub in case it's called from old code paths.
}


// ==========================================
// Utils
// ==========================================
// Auto Save / Load State to local JSON
// ==========================================
function buildStateSnapshot(forVideoId, forTitle = null, lastTimeMs = 0) {
    const targetVideoId = forVideoId || currentVideoId || state.metadata?.videoId || null;
    const targetTitle = forTitle || currentVideoTitle || state.metadata?.videoTitle || "Unknown Video";
    const fallbackUrl = targetVideoId ? `https://www.youtube.com/watch?v=${targetVideoId}` : "";
    const targetUrl = state.metadata?.videoUrl || fallbackUrl;

    return {
        // Strip base64 dataUrl from screenshots to prevent O(n^2) JSON stringify memory bloat
        // Fix #14: Optimize snapshot - avoid full map duplication if not needed
        screenshots: state.screenshots.map(shot => {
            const { dataUrl, missingOnDisk, ...rest } = shot;
            return rest;
        }),
        toc: Array.isArray(state.toc) ? state.toc : [],
        metadata: {
            ...state.metadata,
            videoId: targetVideoId,
            videoTitle: targetTitle,
            videoUrl: targetUrl,
            channel: state.metadata?.channel || "",
            lastTimeMs: lastTimeMs || state.metadata?.lastTimeMs || 0
        },
        updatedAt: new Date().toISOString()
    };
}

// Fix #8: Mutex lock to prevent race conditions during concurrent state saves
let saveVideoStateLock = false;
let pendingSaveRequested = false;
let saveVideoStateTimer = null;

async function saveVideoState(forVideoId = null, forTitle = null) {
    // If a save is in progress, mark that we need another save after it completes
    if (saveVideoStateLock) {
        pendingSaveRequested = true;
        return; // Don't start concurrent save
    }

    // Use a short debounce to batch rapid changes, but respect the lock
    if (saveVideoStateTimer) clearTimeout(saveVideoStateTimer);
    
    saveVideoStateTimer = setTimeout(async () => {
        // Double-check lock after timeout
        if (saveVideoStateLock) {
            pendingSaveRequested = true;
            return;
        }
        
        saveVideoStateLock = true;

        try {
            await saveVideoStateExecution(forVideoId, forTitle);
        } catch (err) {
            console.error("saveVideoState failed:", err);
        } finally {
            saveVideoStateLock = false;

            // If another save was requested while this one was running, trigger it
            if (pendingSaveRequested) {
                pendingSaveRequested = false;
                // Use setTimeout to avoid immediate recursion
                setTimeout(() => saveVideoState(forVideoId, forTitle), 50);
            }
        }
    }, 500);
}

async function saveVideoStateExecution(forVideoId = null, forTitle = null) {
    const targetVideoId = forVideoId || currentVideoId || state.metadata?.videoId;
    if (!FileSystemModule.dirHandle || !targetVideoId) return;

    // STRICT: Don't create folders or save files unless the user manually enabled the notebook for this video.
    if (!isNotebookEnabled) {
        console.log("Sidepanel: Skipping saveVideoState because Notebook is OFF for this video.");
        return;
    }

    try {
        const videoTitle = forTitle || currentVideoTitle || state.metadata?.videoTitle || "Unknown Video";
        // Prefer an existing folder resolved by videoId so a stale SPA title cannot
        // create a brand-new wrong-titled folder for this video's notes.
        let subFolder = await resolveVideoFolderHandleForVideoId(targetVideoId, videoTitle);
        if (!subFolder) {
            subFolder = await FileSystemModule.getVideoFolderHandle(videoTitle, true, targetVideoId);
        }
        if (!subFolder) {
            showFolderPermissionBannerIfNeeded();
            return;
        }

        // Try to get current time for resume logic
        let lastTimeMs = 0;
        try {
            const resp = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 1, 0);
            if (resp) lastTimeMs = resp.currentTimeMs;
        } catch (e) {
            console.debug('[Panel] Failed to get video state for save:', e);
        }

        const snapshot = buildStateSnapshot(targetVideoId, videoTitle, lastTimeMs);
        state.metadata = { ...snapshot.metadata };

        const data = JSON.stringify(snapshot, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const saved = await FileSystemModule.saveFile(VIDEO_STATE_FILENAME, blob, subFolder);
        if (!saved) {
            if (FileSystemModule.permissionNeedsUserGesture) {
                showFolderPermissionBannerIfNeeded();
            } else if (!FileSystemModule.dirHandle) {
                console.warn("saveVideoState: Failed because folder is missing.");
            } else {
                console.warn("saveVideoState: Failed (likely quota or lock).");
            }
            return;
        }

        upsertHistoryIndexEntry(snapshot, subFolder.name).catch(e => console.warn("[Panel] History index update failed:", e));
    } catch (e) {
        console.error("Failed to auto-save state", e);
    }
}

// Helper to format path for display
function getDisplayPath(fullPath) {
    if (!fullPath) return "";
    return fullPath.split('\\').pop().split('/').pop();
}

async function loadVideoState(forVideoId, forTitle, isPreviewOrOptions = false) {
    const isPreview = (typeof isPreviewOrOptions === 'object') ? !!isPreviewOrOptions.isPreview : !!isPreviewOrOptions;
    const isLazy = (typeof isPreviewOrOptions === 'object') ? !!isPreviewOrOptions.lazy : false;
    const skipRender = (typeof isPreviewOrOptions === 'object') ? !!isPreviewOrOptions.skipRender : false;

    if (!isLazy) {
        lastScreenshotHash = null;
        console.log("[Duplicate] Hash reset: loadVideoState started (non-lazy)");
    }

    // Returns: 'loaded' | 'empty' | 'blocked' | 'stale' | 'error'
    // Callers latch isDataLoadedForId only on 'loaded'/'empty' so failures retry.
    try {
        if (!FileSystemModule.dirHandle || !forVideoId || !forTitle) return 'blocked';

        // Save current scroll position BEFORE clearing UI (for returning to this video later)
        const scrollContainer = document.getElementById('tab-screenshots');
        if (scrollContainer && forVideoId && !isPreview) {
            savedScrollPositions.set(forVideoId, scrollContainer.scrollTop);
        }

        // Ensure we are still on the same video that we started loading for
        if (forVideoId !== currentVideoId) return 'stale';

        // Check if we actually have permission before trying to read (it won't prompt without a gesture)
        const options = { mode: 'readwrite' };
        if ((await FileSystemModule.dirHandle.queryPermission(options)) !== 'granted') {
            FileSystemModule.permissionNeedsUserGesture = true;
            if (!isPreview) showFolderPermissionBannerIfNeeded();
            return 'blocked';
        }

        // Final sanity check before the slow FS operations
        if (forVideoId !== currentVideoId) return 'stale';

        // Resolve folder BY VIDEOID first (history index / ownership scan) so a stale
        // SPA title cannot point the lookup at the wrong video's folder.
        const subFolder = await resolveVideoFolderHandleForVideoId(forVideoId, forTitle);
        if (!subFolder) {
            // Definitive "no notes yet" vs permission failure (must not latch the latter)
            return FileSystemModule.permissionNeedsUserGesture ? 'blocked' : 'empty';
        }

        // FOLDER EXISTS -> This video has internal data, so it IS a notebook
        if (!isPreview) setNotebookToggleState(true);

        // Final sanity check
        if (forVideoId !== currentVideoId) return 'stale';

        const fileHandle = await subFolder.getFileHandle(VIDEO_STATE_FILENAME);
        const file = await fileHandle.getFile();
        const text = await file.text();
        const loadedState = JSON.parse(text);

        // Re-check AFTER the awaits above: a video switch may have cleared/changed
        // the UI while we were reading; never repopulate stale data (Fix #4).
        if (forVideoId !== currentVideoId) return 'stale';

        // Restore interval setting
        if (loadedState && loadedState.metadata && loadedState.metadata.selectedInterval) {
            state.metadata.selectedInterval = loadedState.metadata.selectedInterval;
        } else {
            state.metadata.selectedInterval = "None";
        }

        // Keep root history index in sync with legacy or manually edited state files.
        if (!isPreview) {
            try {
                await upsertHistoryIndexEntry(loadedState, subFolder.name);
            } catch (historyErr) {
                console.warn("History index sync failed during load:", historyErr);
            }
        }

        if (forVideoId !== currentVideoId) return 'stale';

        // CRITICAL: Verify the loaded state belongs to the video we want.
        // If the YouTube SPA returned a stale title initially, we might have opened the
        // wrong folder. This prevents us from loading old video screenshots for a new video.
        if (loadedState && loadedState.metadata && loadedState.metadata.videoId && loadedState.metadata.videoId !== forVideoId) {
            console.warn("Sidepanel: State file videoId mismatch! Rejecting stale data.", loadedState.metadata.videoId, "!=", forVideoId);
            return 'empty';
        }

        if (loadedState && loadedState.screenshots && loadedState.screenshots.length > 0) {
            // Batch load screenshots into state (only if NOT lazy re-hydrating existing state)
            if (!isLazy) {
                state.screenshots = loadedState.screenshots.map((shot, idx) => normalizeScreenshotRecord(shot, idx));
            }

            // Trigger asynchronous parallel rehydration with custom options
            rehydrateActiveScreenshots(isPreviewOrOptions);

            // Sort by capture order
            state.screenshots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }

        if (loadedState && loadedState.toc && loadedState.toc.length > 0) {
            console.log("Sidepanel: Restoring", loadedState.toc.length, "TOC entries");
            state.toc = loadedState.toc.map((entry, idx) => normalizeTOCRecord(entry, idx));
            state.toc = sortTOCByCreated(state.toc);
        }

        // Resume video position (skip for preview and lazy re-hydration)
        if (!isPreview && !isLazy && loadedState && loadedState.metadata && loadedState.metadata.lastTimeMs > 0) {
            console.log("Sidepanel: Resuming video at", loadedState.metadata.lastTimeMs);
            setTimeout(() => {
                seekActiveYouTubeTab(loadedState.metadata.lastTimeMs);
            }, 1000); // Give content script a moment to stabilize
        }

        // Single render call for everything
        if (!isPreview && !skipRender) {
            // Wait for rehydration to finish then render the UI
            setTimeout(() => {
                // Abort if the user navigated to another video during the delay
                if (forVideoId !== currentVideoId) return;
                try {
                    renderMainGallery(() => {
                        // Restore scroll position after rendering is complete
                        const scrollEl = document.getElementById('tab-screenshots');
                        const listEl = document.getElementById('screenshots-list');
                        if (!scrollEl || !listEl) return;

                        const savedScroll = savedScrollPositions.get(forVideoId);

                        // Use a double requestAnimationFrame to ensure the browser has performed layout
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                if (savedScroll !== undefined && savedScroll > 0) {
                                    scrollEl.scrollTo({ top: savedScroll, behavior: 'auto' });
                                } else if (state.screenshots.length > 0) {
                                    // Default to showing the most recent screenshot if no saved position
                                    // Use scrollIntoView on the last child for maximum reliability in large lists
                                    const lastItem = listEl.lastElementChild;
                                    if (lastItem) {
                                        lastItem.scrollIntoView({ behavior: 'auto', block: 'end' });
                                    } else {
                                        scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'auto' });
                                    }

                                    // Final safety adjustment
                                    setTimeout(() => {
                                        const finalItem = listEl.lastElementChild;
                                        if (finalItem) finalItem.scrollIntoView({ behavior: 'auto', block: 'end' });
                                    }, 150);
                                }
                            });
                        });

                        // Sweep any screenshots stranded by a cancelled rehydration task
                        if (forVideoId === currentVideoId) {
                            rehydrateActiveScreenshots(typeof isPreviewOrOptions === 'object' ? isPreviewOrOptions : {});
                        }
                    });
                } catch (e) { console.error("Sidepanel: renderMainGallery failed", e); }

                try {
                    generateIntervalMarkers();
                } catch (e) { console.error("Sidepanel: generateIntervalMarkers failed", e); }

                try {
                    renderTOCList();
                } catch (e) { console.error("Sidepanel: renderTOCList failed", e); }
            }, isLazy ? 50 : 200); // Small delay to let rehydration blobs propagate
        }

        return 'loaded';
    } catch (err) {
        // Folder resolved but state file missing/invalid -> treat as definitive empty
        if (isMissingFileSystemEntryError(err)) {
            console.log("No previous state found to load. Fresh slate.");
            return 'empty';
        }
        if (isPermissionDeniedFileSystemError(err)) {
            FileSystemModule.permissionNeedsUserGesture = true;
            if (!isPreview) showFolderPermissionBannerIfNeeded();
            return 'blocked';
        }
        console.log("No previous state found to load or error reading file. Fresh slate.");
        console.error("Failed to load video state", err); // Added error logging for clarity
        return 'error';
    }
}

function setNotebookToggleState(isOn) {
    isNotebookEnabled = isOn;
    const toggle = document.getElementById('toggle-notebook');
    const text = document.getElementById('toggle-text');
    if (toggle && text) {
        toggle.checked = isOn;
        if (isOn) {
            text.textContent = 'On';
            text.classList.add('active');
        } else {
            text.textContent = 'Off';
            text.classList.remove('active');
        }
    }

    syncNotebookStateToContent(isOn);
}

function setAutoOpenToggleState(isOn) {
    isAutoOpenEnabled = isOn;
    const toggle = document.getElementById('toggle-auto-open');
    const text = document.getElementById('toggle-auto-open-text');
    if (toggle && text) {
        toggle.checked = isOn;
        if (isOn) {
            text.textContent = 'On';
            text.classList.add('active');
        } else {
            text.textContent = 'Off';
            text.classList.remove('active');
        }
    }

    try {
        chrome.storage.local.set({ isAutoOpenEnabled: isOn });
    } catch (err) {
        console.warn("Failed to save Auto-Open state:", err);
    }
}

async function initAutoOpenToggle() {
    const toggle = document.getElementById('toggle-auto-open');
    if (!toggle) return;

    try {
        const result = await chrome.storage.local.get('isAutoOpenEnabled');
        // Default to true if not set
        const isOn = result.isAutoOpenEnabled !== false;
        setAutoOpenToggleState(isOn);
    } catch (err) {
        console.warn("Failed to load Auto-Open state:", err);
        setAutoOpenToggleState(true);
    }

    toggle.addEventListener('change', (e) => {
        setAutoOpenToggleState(!!e.target.checked);
    });
}

function setCCToggleState(isOn) {
    isCaptionEnabled = isOn;
    const toggle = document.getElementById('toggle-cc-capture');
    const text = document.getElementById('toggle-cc-text');
    if (toggle && text) {
        toggle.checked = isOn;
        if (isOn) {
            text.textContent = 'On';
            text.classList.add('active');
        } else {
            text.textContent = 'Off';
            text.classList.remove('active');
        }
    }

    try {
        chrome.storage.local.set({ isCaptionEnabled: isOn });
    } catch (err) {
        console.warn("Failed to save CC toggle state:", err);
    }
}

async function initCCToggle() {
    const toggle = document.getElementById('toggle-cc-capture');
    if (!toggle) return;

    try {
        const result = await chrome.storage.local.get('isCaptionEnabled');
        // Default to false (clean screenshots) if not set
        const isOn = !!result.isCaptionEnabled;
        setCCToggleState(isOn);
    } catch (err) {
        console.warn("Failed to load CC toggle state:", err);
        setCCToggleState(false);
    }

    toggle.addEventListener('change', (e) => {
        setCCToggleState(!!e.target.checked);
    });
}

// Reset UI specifically to clear data on video change
// (Defined again above, removing this redundant copy)

// ==========================================
// Transcript Feature
// ==========================================

function initTranscriptRangeSettings() {
    const inputBefore = document.getElementById('transcript-before');
    const inputAfter = document.getElementById('transcript-after');

    if (!inputBefore || !inputAfter) return;

    // Load from storage
    chrome.storage.local.get(['transcriptRangePre', 'transcriptRangePost'], (data) => {
        if (data.transcriptRangePre !== undefined) inputBefore.value = data.transcriptRangePre;
        if (data.transcriptRangePost !== undefined) inputAfter.value = data.transcriptRangePost;
    });

    // Save on change
    const save = () => {
        const pre = parseInt(inputBefore.value) || 0;
        const post = parseInt(inputAfter.value) || 0;
        chrome.storage.local.set({ transcriptRangePre: pre, transcriptRangePost: post });
    };

    inputBefore.addEventListener('input', save);
    inputAfter.addEventListener('input', save);
}

async function getCachedTranscript(force = false) {
    if (cachedTranscriptSegments && !force) return cachedTranscriptSegments;
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return null;

    // Prove-in parameters from Copy (8): 2 retries, 250ms delay
    const response = await sendMessageWithRetry(tabId, { action: 'getTranscript' }, 2, 250);
    if (response?.success && response.segments) {
        cachedTranscriptSegments = normalizeTranscriptSegmentsForDisplay(response.segments);
        return cachedTranscriptSegments;
    }
    return null;
}

async function refreshTranscript() {
    if (!safeSetInnerHTML('transcript-content', '')) return;
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) {
        safeSetInnerHTML('transcript-content', `<div class="empty-state"><p>Please open a YouTube watch page first.</p></div>`);
        return;
    }

    safeSetInnerHTML('transcript-content', `<div class="empty-state"><p>Loading transcript...</p></div>`);

    const attempts = 3;
    const errors = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
        // Robust parameters: 2 retries, 250ms delay
        const response = await sendMessageWithRetry(tabId, { action: 'getTranscript' }, 2, 250);
        if (response?.success && response.segments) {
            const segments = normalizeTranscriptSegmentsForDisplay(response.segments);
            cachedTranscriptSegments = segments; // Synchronize cache
            displayTranscript(segments);
            return;
        }

        if (response?.error) {
            errors.push(response.error);
        } else if (response?.success && segments.length === 0) {
            errors.push("Transcript returned empty segments.");
        } else {
            errors.push("Could not reach video page.");
        }

        if (attempt < attempts) {
            safeSetInnerHTML('transcript-content', `<div class="empty-state"><p>Retrying transcript (${attempt}/${attempts})...</p></div>`);
            await new Promise(r => setTimeout(r, 650 * attempt));
        }
    }

    const uniqueErrors = Array.from(new Set(errors.filter(Boolean)));
    const errorMsg = uniqueErrors.slice(-2).join(' | ') || "Transcript is unavailable right now.";
    safeSetInnerHTML('transcript-content', `
        <div class="empty-state">
            <p style="color: var(--status-error);">${errorMsg}</p>
            <p style="font-size: 11px; margin-top: 8px; opacity: 0.75;">
                Tip: Keep the video playing for 2-3 seconds after seek/resize, then retry transcript.
            </p>
        </div>`);
}

function splitTranscriptTextForDisplay(text, maxChars = 120) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    if (normalized.length <= maxChars) return [normalized];

    const sentenceLike = normalized.match(/[^.!?;:]+[.!?;:]?|[^.!?;:]+$/g) || [normalized];
    const chunks = [];
    let buffer = '';

    const flush = () => {
        const clean = buffer.trim();
        if (clean) chunks.push(clean);
        buffer = '';
    };

    for (const partRaw of sentenceLike) {
        const part = partRaw.trim();
        if (!part) continue;
        const candidate = buffer ? `${buffer} ${part}` : part;
        if (candidate.length <= maxChars) {
            buffer = candidate;
            continue;
        }

        flush();

        if (part.length <= maxChars) {
            buffer = part;
            continue;
        }

        const words = part.split(' ');
        let line = '';
        for (const word of words) {
            const nextLine = line ? `${line} ${word}` : word;
            if (nextLine.length <= maxChars) {
                line = nextLine;
                continue;
            }
            const clean = line.trim();
            if (clean) chunks.push(clean);
            line = word;
        }
        const clean = line.trim();
        if (clean) chunks.push(clean);
    }

    flush();
    return chunks;
}

function normalizeTranscriptSegmentsForDisplay(segments) {
    const prepared = [];

    for (const rawSeg of segments || []) {
        const timeLabel = String(rawSeg?.time || '').trim();
        const tsFromField = Number(rawSeg?.timestampMs);
        const tsFromLabel = parseTimeToMs(timeLabel);
        const timestampMs = Number.isFinite(tsFromField) ? tsFromField : tsFromLabel;
        if (!Number.isFinite(timestampMs) || timestampMs < 0) continue;

        const textChunks = splitTranscriptTextForDisplay(rawSeg?.text || '', 120);
        for (const chunk of textChunks) {
            prepared.push({
                timestampMs,
                time: formatTime(timestampMs),
                text: chunk
            });
        }
    }

    prepared.sort((a, b) => a.timestampMs - b.timestampMs);

    const deduped = [];
    for (const seg of prepared) {
        const prev = deduped[deduped.length - 1];
        if (
            prev &&
            prev.text.toLowerCase() === seg.text.toLowerCase() &&
            Math.abs(prev.timestampMs - seg.timestampMs) < 300
        ) {
            continue;
        }
        deduped.push(seg);
    }
    return deduped;
}

function displayTranscript(segments) {
    if (!safeSetInnerHTML('transcript-content', '')) return;

    const list = document.getElementById('transcript-content');
    if (!list) return;

    const normalizedSegments = normalizeTranscriptSegmentsForDisplay(segments);
    if (!normalizedSegments.length) {
        list.innerHTML = `<div class="empty-state"><p>Transcript is empty.</p></div>`;
        return;
    }

    normalizedSegments.forEach(seg => {
        const item = document.createElement('div');
        item.className = 'transcript-item';
        item.innerHTML = `
            <span class="transcript-time">${escapeHtml(seg.time)}</span>
            <span class="transcript-text">${escapeHtml(seg.text)}</span>
        `;

        item.addEventListener('click', () => {
            const ms = parseTimeToMs(seg.time);
            if (ms === null) return;
            resolveActiveYouTubeTabId().then((tabId) => {
                if (Number.isInteger(tabId)) {
                    chrome.tabs.sendMessage(tabId, { action: 'seekTo', timeMs: ms });
                }
            });
        });

        list.appendChild(item);
    });
}

async function copyTranscriptToClipboard() {
    const copyModeSelect = document.getElementById('transcript-copy-mode');
    const copyMode = copyModeSelect ? copyModeSelect.value : 'all';
    const segments = document.querySelectorAll('.transcript-item');
    if (segments.length === 0) return;

    var filteredSegments = [];
    var copyStatus = document.getElementById('copy-status');
    var copyBtnText = document.getElementById('copy-btn-text');

    if (copyMode === 'interval') {
        var intervalSelect = document.getElementById('transcript-interval-select');
        var rangeVal = intervalSelect ? intervalSelect.value : '';
        if (!rangeVal) {
            showToast("Please select an interval range first.", "warning");
            return;
        }
        var parts = rangeVal.split('-');
        var startMs = parseFloat(parts[0]);
        var endMs = parseFloat(parts[1]);

        segments.forEach(function(s) {
            var timeEl = s.querySelector('.transcript-time');
            var textEl = s.querySelector('.transcript-text');
            if (!timeEl || !textEl) return;
            var time = timeEl.textContent;
            var text = textEl.textContent;
            var segMs = parseTimeToMs(time);
            if (segMs !== null && segMs >= startMs && segMs <= endMs) {
                filteredSegments.push({ time: time, text: text });
            }
        });
    } else if (copyMode === 'range') {
        var startInput = document.getElementById('transcript-range-start');
        var endInput = document.getElementById('transcript-range-end');
        var startVal = startInput ? startInput.value : '';
        var endVal = endInput ? endInput.value : '';

        if (!startVal || !endVal) {
            showToast("Please enter both start and end times.", "warning");
            return;
        }

        var startMs = parseTimeToMs(startVal);
        if (startMs === null) startMs = parseTimeToMs('00:' + startVal);
        var endMs = parseTimeToMs(endVal);
        if (endMs === null) endMs = parseTimeToMs('00:' + endVal);

        if (startMs === null || endMs === null) {
            showToast("Invalid time format. Use MM:SS or HH:MM:SS.", "error");
            return;
        }

        segments.forEach(function(s) {
            var timeEl = s.querySelector('.transcript-time');
            var textEl = s.querySelector('.transcript-text');
            if (!timeEl || !textEl) return;
            var time = timeEl.textContent;
            var text = textEl.textContent;
            var segMs = parseTimeToMs(time);
            if (segMs !== null && segMs >= startMs && segMs <= endMs) {
                filteredSegments.push({ time: time, text: text });
            }
        });
    } else {
        segments.forEach(function(s) {
            var timeEl = s.querySelector('.transcript-time');
            var textEl = s.querySelector('.transcript-text');
            if (!timeEl || !textEl) return;
            var time = timeEl.textContent;
            var text = textEl.textContent;
            filteredSegments.push({ time: time, text: text });
        });
    }

    if (filteredSegments.length === 0) {
        showToast("No transcript segments found in the selected range.", "warning");
        return;
    }

    var fullText = "";
    filteredSegments.forEach(function(seg) {
        fullText += '[' + seg.time + '] ' + seg.text + '\n';
    });

    try {
        await navigator.clipboard.writeText(fullText);
        if (copyBtnText) copyBtnText.classList.add('hidden');
        if (copyStatus) {
            copyStatus.classList.remove('hidden');
            copyStatus.textContent = 'Copied!';
        }

        setTimeout(function() {
            if (copyBtnText) copyBtnText.classList.remove('hidden');
            if (copyStatus) copyStatus.classList.add('hidden');
        }, 2000);
    } catch (err) {
        console.error("Copy failed", err);
        showToast("Failed to copy to clipboard.", "error");
    }
}

// Helper to parse "00:00" or "0:00:00" to MS
function parseTimeToMs(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':').map(p => parseInt(p, 10));
    let ms = 0;
    if (parts.length === 3) {
        ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    } else if (parts.length === 2) {
        ms = (parts[0] * 60 + parts[1]) * 1000;
    } else {
        return null;
    }
    return ms;
}


// Time Formatter - uses shared TimeUtils.formatTime() for consistency
// See utils/time.js for implementation
const formatTime = TimeUtils.formatTime;

// ==========================================
// Playback Duration Calculator
// ==========================================
let calcState = {
    totalDurationMs: 0,
    baseDurationMs: 0, // Duration used for calculation
    currentMs: 0,
    currentSpeed: 1.0,
    speeds: [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0],
    isInit: false
};

function initDurationCalculator() {
    if (calcState.isInit) return;

    document.getElementById('calc-close').addEventListener('click', closeDurationCalculator);
    document.getElementById('calc-btn-close-bottom').addEventListener('click', closeDurationCalculator);

    document.getElementById('calc-btn-set').addEventListener('click', () => {
        const input = document.getElementById('calc-custom-input').value.trim();
        let seconds = 0;
        if (input.includes(':')) {
            const parts = input.split(':').map(Number);
            if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
            else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
        } else {
            seconds = parseInt(input) || 0;
        }
        if (seconds > 0) {
            calcState.baseDurationMs = seconds * 1000;
            document.getElementById('calc-btn-reset').classList.remove('hidden');
            document.getElementById('calc-custom-input').value = '';
            updateDurationCalculations();
        }
    });

    document.getElementById('calc-btn-reset').addEventListener('click', () => {
        calcState.baseDurationMs = calcState.totalDurationMs;
        document.getElementById('calc-btn-reset').classList.add('hidden');
        updateDurationCalculations();
    });

    // Toggles
    const toggleSection = (btnId, sectionId, showText, hideText) => {
        document.getElementById(btnId).addEventListener('click', (e) => {
            const sec = document.getElementById(sectionId);
            const isHidden = sec.style.display === 'none';
            sec.style.display = isHidden ? 'block' : 'none';
            e.target.textContent = isHidden ? hideText : showText;
            e.target.classList.toggle('collapsed', !isHidden);
        });
    };
    toggleSection('calc-toggle-completion', 'calc-completion-section', 'Hide Video Completion Time', 'Show Video Completion Time');
    toggleSection('calc-toggle-schedule', 'calc-schedule-section', 'Hide Study Schedule Calculator', 'Show Study Schedule Calculator');

    // Completion / Schedule inputs
    document.getElementById('calc-chk-custom-start').addEventListener('change', (e) => {
        document.getElementById('calc-start-input').disabled = !e.target.checked;
        updateDurationCalculations();
    });
    document.getElementById('calc-start-input').addEventListener('input', updateDurationCalculations);
    document.getElementById('calc-chk-remaining').addEventListener('change', updateDurationCalculations);
    document.getElementById('calc-hours-input').addEventListener('input', updateDurationCalculations);
    document.getElementById('calc-days-input').addEventListener('input', updateDurationCalculations);

    calcState.isInit = true;
}

async function openDurationCalculator() {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) {
        await showAlert("Please open and play a YouTube video first.");
        return;
    }

    const stateResp = await sendMessageWithRetry(tabId, { action: 'getState' }, 3, 500);
    if (!stateResp || !stateResp.durationMs) {
        await showAlert("Could not get video state. Ensure the video is loaded and try again.");
        return;
    }

    initDurationCalculator();

    calcState.totalDurationMs = stateResp.durationMs;
    calcState.baseDurationMs = stateResp.durationMs;
    calcState.currentMs = stateResp.currentTimeMs;
    calcState.currentSpeed = stateResp.playbackRate || 1.0;

    if (!calcState.speeds.includes(calcState.currentSpeed)) {
        calcState.speeds.push(calcState.currentSpeed);
        calcState.speeds.sort((a, b) => a - b);
    }

    document.getElementById('calc-btn-reset').classList.add('hidden');
    document.getElementById('calc-toggle-completion').textContent = 'Hide Video Completion Time';
    document.getElementById('calc-toggle-completion').classList.remove('collapsed');
    document.getElementById('calc-completion-section').style.display = 'block';

    document.getElementById('calc-toggle-schedule').textContent = 'Hide Study Schedule Calculator';
    document.getElementById('calc-toggle-schedule').classList.remove('collapsed');
    document.getElementById('calc-schedule-section').style.display = 'block';

    updateDurationCalculations();
    document.getElementById('duration-calc-overlay').classList.remove('hidden');
}

function closeDurationCalculator() {
    document.getElementById('duration-calc-overlay').classList.add('hidden');
}

function formatCalcTime(ms) {
    if (ms <= 0) return "0m 0s";
    let seconds = Math.floor(ms / 1000);
    let h = Math.floor(seconds / 3600);
    let m = Math.floor((seconds % 3600) / 60);
    let s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}

function formatHoursMins(fractionalHours) {
    let minutes = Math.floor(fractionalHours * 60);
    let h = Math.floor(minutes / 60);
    let m = minutes % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}min`;
}

function updateDurationCalculations() {
    let calcDuration = calcState.baseDurationMs;

    if (document.getElementById('calc-chk-remaining').checked) {
        let remaining = calcState.baseDurationMs - calcState.currentMs;
        calcDuration = Math.max(0, remaining);
    }

    document.getElementById('calc-used-duration').textContent = formatCalcTime(calcDuration);

    // 1. Speeds Grid
    const grid = document.getElementById('calc-speed-grid');
    grid.innerHTML = '';
    calcState.speeds.forEach(speed => {
        const adjustedMs = calcDuration / speed;
        const isCurrent = Math.abs(speed - calcState.currentSpeed) < 0.01;

        const card = document.createElement('div');
        card.className = `speed-card ${isCurrent ? 'highlight' : ''}`;
        card.innerHTML = `
            <span class="speed-lbl">${speed}x</span>
            <span class="time-lbl">${formatCalcTime(adjustedMs)}</span>
        `;
        grid.appendChild(card);
    });

    // 2. Completion Time
    const startInput = document.getElementById('calc-start-input').value.trim();
    const useCustomStart = document.getElementById('calc-chk-custom-start').checked;

    let now = new Date();
    if (useCustomStart && startInput) {
        // Simple parser for HH:MM
        const timeMatch = startInput.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (timeMatch) {
            let h = parseInt(timeMatch[1], 10);
            const m = parseInt(timeMatch[2], 10);
            const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;

            if (ampm === 'pm' && h < 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;

            now.setHours(h, m, 0, 0);
            // If parsed time is >5 mins in the past compared to real now, assume it's for tomorrow
            if (now < new Date(Date.now() - 5 * 60000)) {
                now.setDate(now.getDate() + 1);
            }
        }
    }

    const compTableContainer = document.getElementById('calc-completion-table');
    if (calcDuration > 0) {
        let tableHTML = `<table class="comp-table"><tr><th>Speed</th><th class="right">Duration</th><th class="right">Finish Time</th></tr>`;
        calcState.speeds.forEach(speed => {
            const remMs = calcDuration / speed;
            const finishTime = new Date(now.getTime() + remMs);
            const isCurrent = Math.abs(speed - calcState.currentSpeed) < 0.01;

            // Format time nicely e.g "2:30 PM"
            const timeString = finishTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            // Check if it's tomorrow
            const isTomorrow = finishTime.getDate() !== now.getDate();
            const tomorrowStr = isTomorrow ? " <span style='font-size:10px; opacity:0.6;'>(Tom)</span>" : "";

            tableHTML += `<tr class="${isCurrent ? 'highlight' : ''}">
                <td>${speed}x</td>
                <td class="right">${formatCalcTime(remMs)}</td>
                <td class="right finish-time">${timeString}${tomorrowStr}</td>
            </tr>`;
        });
        tableHTML += `</table>`;
        compTableContainer.innerHTML = tableHTML;
    } else {
        compTableContainer.innerHTML = '';
    }

    // 3. Study Schedule
    const totalHours = (calcDuration / 1000) / 3600;

    // Option 1
    const opt1Res = document.getElementById('calc-opt1-result');
    const hoursPerDay = parseFloat(document.getElementById('calc-hours-input').value) || 1.0;
    if (hoursPerDay > 0) {
        let tbl = `<p class="fw-bold mb-2">\u{1F4C5} Completion Timeline for ${hoursPerDay}h daily:</p>
                   <table class="comp-table">`;
        calcState.speeds.forEach(speed => {
            const adjHours = totalHours / speed;
            const daysNeeded = adjHours / hoursPerDay;
            const daysFmt = daysNeeded < 0.9 ? "< 1 day" : `${daysNeeded.toFixed(1)} days`;
            const isCurrent = Math.abs(speed - calcState.currentSpeed) < 0.01;

            tbl += `<tr class="${isCurrent ? 'highlight' : ''}">
                <td>${speed}x speed</td>
                <td class="right text-dim">Complete in <b style="color:var(--text-color)">${daysFmt}</b></td>
            </tr>`;
        });
        tbl += `</table>`;
        opt1Res.innerHTML = tbl;
    }

    // Option 2
    const opt2Res = document.getElementById('calc-opt2-result');
    const targetDays = parseInt(document.getElementById('calc-days-input').value, 10) || 7;
    if (targetDays > 0) {
        let tbl = `<p class="fw-bold mb-2">\u23F0 Daily Hours Required to Complete in ${targetDays}d:</p>
                   <table class="comp-table">`;
        calcState.speeds.forEach(speed => {
            const adjHours = totalHours / speed;
            const hoursNeeded = adjHours / targetDays;
            const timeFmt = formatHoursMins(hoursNeeded) + " daily";
            const isCurrent = Math.abs(speed - calcState.currentSpeed) < 0.01;

            tbl += `<tr class="${isCurrent ? 'highlight' : ''}">
                <td>${speed}x speed</td>
                <td class="right text-dim">${timeFmt}</td>
            </tr>`;
        });
        tbl += `</table>`;
        opt2Res.innerHTML = tbl;
    }
}
// ---------------------------------------------------------
// Interval Markers Logic
// ---------------------------------------------------------

async function handleSetInterval() {
    const choices = [
        { value: "None", label: "None (Hide)", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>' },
        { value: "60", label: "1 Min", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "300", label: "5 Mins", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "600", label: "10 Mins", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "1200", label: "20 Mins", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "1800", label: "30 Mins", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "3600", label: "1 Hour", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "5400", label: "1.5 Hours", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "7200", label: "2 Hours", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "9000", label: "2.5 Hours", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' },
        { value: "Custom", label: "Custom...", icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>' }
    ];

    const result = await showPrompt("Select interval for timeline markers:", "None", choices);
    if (!result) return;

    if (result === "Custom") {
        const customVal = await showPrompt("Enter custom interval (e.g., '15m' or '2h' or '3600'):", "30m");
        if (customVal) {
            let seconds = 0;
            const match = customVal.match(/^(\d+)([smh]?)$/i);
            if (match) {
                const val = parseInt(match[1]);
                const unit = (match[2] || 's').toLowerCase();
                if (unit === 'm') seconds = val * 60;
                else if (unit === 'h') seconds = val * 3600;
                else seconds = val;

                if (seconds > 0) {
                    state.metadata.selectedInterval = seconds.toString();
                    generateIntervalMarkers();
                    saveVideoState();
                }
            } else {
                showToast("Invalid format! Use 5m, 1h, etc.", "error");
            }
        }
    } else {
        state.metadata.selectedInterval = result;
        generateIntervalMarkers();
        saveVideoState();
    }
}

function generateIntervalMarkers() {
    const intervalStr = state.metadata.selectedInterval;
    const container = document.getElementById('timeline-markers');
    if (!container) {
        console.warn("Sidepanel: timeline-markers container not found in DOM");
        return;
    }
    container.innerHTML = '';
    // Clear previous density classes
    container.classList.remove('compact-flags', 'mini-flags', 'micro-flags');
    state.intervalMarkers = [];

    if (!intervalStr || intervalStr === "None") {
        console.log("Sidepanel: Markers disabled (interval is None)");
        updateIntervalSelect(); // Clear interval select
        return;
    }

    const intervalSecs = parseInt(intervalStr);
    const durationMs = state.metadata.durationMs || 0;

    console.log(`Sidepanel: generateIntervalMarkers - Requesting markers for ${intervalStr}s. Duration: ${durationMs}ms`);

    if (durationMs <= 0 || isNaN(intervalSecs)) {
        console.log("Sidepanel: Delaying marker generation (no duration or invalid interval yet)");
        return;
    }

    const intervalMs = intervalSecs * 1000;
    const totalMarkersRequested = Math.floor(durationMs / intervalMs);

    // Adaptive Density Logic
    if (totalMarkersRequested > 100) {
        container.classList.add('micro-flags');
    } else if (totalMarkersRequested > 40) {
        container.classList.add('mini-flags');
    } else if (totalMarkersRequested > 15) {
        container.classList.add('compact-flags');
    }

    const colors = ["#e74c3c", "#8e44ad", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c", "#e67e22", "#16a085", "#c0392b", "#d35400"];

    let count = 1;
    for (let time = intervalMs; time < durationMs; time += intervalMs) {
        const percentage = (time / durationMs) * 100;
        const color = colors[(count - 1) % colors.length];

        state.intervalMarkers.push({ percentage, color, number: count });

        const marker = document.createElement('div');
        marker.className = 'timeline-marker';
        marker.style.left = `${percentage}%`;
        marker.style.setProperty('--marker-color', color);
        marker.title = `Interval ${count}: ${formatTime(time)}`;

        marker.innerHTML = `
            <div class="flag">
                <span class="flag-text">${count}</span>
            </div>
            <div class="pole"></div>
        `;

        container.appendChild(marker);
        count++;

        if (count > 800) { // Increased safety limit slightly
            console.warn("Sidepanel: Reached safety limit of 800 markers");
            break;
        }
    }

    updateIntervalSelect();
    console.log(`Sidepanel: Success! Generated ${count - 1} interval markers for ${intervalStr}s interval`);
}

// ==========================================
// Action: Watch Later
// ==========================================
function initWatchLaterTab() {
    const sortSelect = document.getElementById('sort-watch-later');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            renderWatchLaterList();
        });
    }
}

async function loadWatchLaterList() {
    try {
        const text = await FileSystemModule.getFileText(WATCH_LATER_FILENAME);
        if (!text) return;

        const data = JSON.parse(text);
        if (Array.isArray(data)) {
            state.watchLaterList = data;
            renderWatchLaterList();
        }
    } catch (err) {
        if (err.name !== 'NotFoundError' && err.name !== 'SyntaxError') {
            console.error("Panel: Failed to load Watch Later list:", err.name, err.message);
        }
    }
}

async function saveWatchLaterList() {
    if (!FileSystemModule.dirHandle) return false;
    try {
        const json = JSON.stringify(state.watchLaterList, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const saved = await FileSystemModule.saveFile(WATCH_LATER_FILENAME, blob);
        if (!saved && !FileSystemModule.permissionNeedsUserGesture) {
            console.warn("saveWatchLaterList: Save failed without gesture needed.");
        }
        return saved;
    } catch (err) {
        console.error("Failed to save Watch Later list:", err);
        return false;
    }
}

async function handleAddWatchLaterRequest(providedMetadata = null) {
    console.log("Sidepanel: handleAddWatchLaterRequest starting. currentVideoId:", currentVideoId);

    // If variables missing, try to recover from providedMetadata
    if ((!currentVideoId || !currentVideoTitle) && providedMetadata) {
        console.log("Sidepanel: Recovering metadata from message:", providedMetadata);
        currentVideoId = providedMetadata.videoId;
        currentVideoTitle = providedMetadata.title;
        state.metadata.videoId = providedMetadata.videoId;
        state.metadata.videoTitle = providedMetadata.title;
        state.metadata.videoUrl = providedMetadata.url;
        state.metadata.channel = providedMetadata.channel;
    }

    // Safety check: Ensure watchLaterList exists (prevents TypeError)
    if (!state.watchLaterList) {
        console.error("Sidepanel: watchLaterList missing from state! Re-initializing.");
        state.watchLaterList = [];
        await loadWatchLaterList();
    }

    if (!currentVideoId || !currentVideoTitle) {
        console.warn("Sidepanel: Cannot add to watch later - missing video metadata", { currentVideoId, currentVideoTitle });
        showToast("No video detected to add.", "warning");
        return;
    }

    // Check if already in list
    const existing = state.watchLaterList.find(item => item.videoId === currentVideoId);
    if (existing) {
        showToast("Video already in Watch Later list.", "info");
        return;
    }

    // Show Priority Choice Dialog
    const priorityChoices = [
        { label: "1 (Critical)", value: "1", icon: "\u{1F525}" },
        { label: "2 (High)", value: "2", icon: "\u2B50" },
        { label: "3 (Medium)", value: "3", icon: "\u{1F4CD}" },
        { label: "4 (Low)", value: "4", icon: "\u23F2" },
        { label: "5 (Optional)", value: "5", icon: "\u{1F4A1}" }
    ];

    const result = await showPrompt("Select Priority Level:", "", priorityChoices);
    if (!result) return; // Cancelled

    const priority = parseInt(result);
    const thumbnail = `https://i.ytimg.com/vi/${currentVideoId}/mqdefault.jpg`;

    // Progress estimation from current UI or 0
    let progress = 0;
    const progressFill = document.getElementById('progress-fill');
    if (progressFill) {
        progress = parseFloat(progressFill.style.width) || 0;
    }

    const newItem = {
        videoId: currentVideoId,
        title: currentVideoTitle,
        thumbnail: thumbnail,
        addedAt: Date.now(),
        priority: priority,
        progressPercentage: Math.round(progress),
        completed: progress >= 95
    };

    state.watchLaterList.unshift(newItem); // Add to top
    const saved = await saveWatchLaterList();
    if (saved) {
        renderWatchLaterList();
        showToast("Added to Watch Later!", "success");
    } else {
        // Rollback state if save failed
        state.watchLaterList.shift();
        if (FileSystemModule.permissionNeedsUserGesture) {
            showFolderPermissionBannerIfNeeded();
        } else {
            showToast("Failed to save Watch Later list. Check permissions.", "error");
        }
    }
}

function renderWatchLaterList() {
    const list = document.getElementById('watch-later-list');
    if (!list) return;

    if (state.watchLaterList.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <p>No videos added to Watch Later yet.</p>
                <p class="text-xs">Click the + icon in the YouTube player to add one.</p>
            </div>
        `;
        return;
    }

    // Sorting
    const sortVal = document.getElementById('sort-watch-later')?.value || 'date';
    const sorted = [...state.watchLaterList].sort((a, b) => {
        if (sortVal === 'priority') {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.addedAt - a.addedAt;
        }
        return b.addedAt - a.addedAt; // Default: newest first
    });

    list.innerHTML = '';
    sorted.forEach(item => {
        const card = document.createElement('div');
        card.className = `watch-later-item wl-priority-${item.priority}`;

        const dateStr = new Date(item.addedAt).toLocaleDateString();

        card.innerHTML = `
            <div class="wl-main-info">
                <div class="wl-thumb-container">
                    <img src="${escapeAttr(item.thumbnail)}" class="wl-thumb" loading="lazy">
                    <div class="wl-priority-badge">${escapeHtml(String(item.priority))}</div>
                </div>
                <div class="wl-details">
                    <div class="wl-title" title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</div>
                    <div class="wl-meta">Added: ${escapeHtml(dateStr)} • Priority: ${escapeHtml(String(item.priority))}</div>
                    <div class="wl-progress" title="${escapeAttr(String(item.progressPercentage))}% watched">
                        <div class="wl-progress-fill" style="width: ${escapeAttr(String(item.progressPercentage))}%"></div>
                    </div>
                </div>
            </div>
            <div class="wl-actions">
                <button class="wl-action-btn delete" title="Remove">Delete</button>
                <button class="wl-action-btn play" title="Play Now">Play</button>
            </div>
        `;

        card.querySelector('.delete').onclick = async () => {
            const originalList = [...state.watchLaterList];
            state.watchLaterList = state.watchLaterList.filter(i => i.videoId !== item.videoId);
            const saved = await saveWatchLaterList();
            if (saved) {
                renderWatchLaterList();
                showToast("Removed from Watch Later.", "info");
            } else {
                state.watchLaterList = originalList;
                if (FileSystemModule.permissionNeedsUserGesture) {
                    showFolderPermissionBannerIfNeeded();
                } else {
                    showToast("Failed to update Watch Later list.", "error");
                }
            }
        };

        card.querySelector('.play').onclick = () => {
            const url = `https://www.youtube.com/watch?v=${item.videoId}`;
            if (currentTabId) {
                chrome.tabs.update(currentTabId, { url: url });
            } else {
                window.open(url, '_blank');
            }
        };

        list.appendChild(card);
    });
}

// ==========================================
// Action: Countdown Manager
// ==========================================

async function loadCountdowns() {
    try {
        const text = await FileSystemModule.getFileText(COUNTDOWN_FILENAME);
        if (!text) return;

        const data = JSON.parse(text);
        if (Array.isArray(data)) {
            state.countdowns = data;
            renderCountdowns();
        }
    } catch (err) {
        if (err.name !== 'NotFoundError' && err.name !== 'SyntaxError') {
            console.error("Panel: Failed to load Countdowns list:", err.name, err.message);
        }
    }
}

async function saveCountdowns() {
    if (!FileSystemModule.dirHandle) return false;
    try {
        const json = JSON.stringify(state.countdowns, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const saved = await FileSystemModule.saveFile(COUNTDOWN_FILENAME, blob);
        return saved;
    } catch (err) {
        console.error("Failed to save Countdowns list:", err);
        return false;
    }
}

async function handleAddCountdownPrompt() {
    if (!FileSystemModule.dirHandle) {
        showToast("Please select a Save Folder first to save countdowns.", "warning");
        return;
    }

    // Quick prompt flow since we don't have a complex forms library
    const title = await showPrompt("Enter Countdown Title:", "New Goal");
    if (!title) return;

    // We'll calculate end date based on duration for simplicity, or user can put YYYY-MM-DD
    const durationInput = await showPrompt("Enter Duration in Days (or exact End Date YYYY-MM-DD):", "30");
    if (!durationInput) return;

    const today = new Date();
    const startDateStr = today.toISOString().split('T')[0];
    let endDateStr = "";

    const trimmedInput = String(durationInput).trim();
    const exactDateMatch = trimmedInput.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (exactDateMatch) {
        const parsed = new Date(`${exactDateMatch[1]}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) {
            showToast("Invalid date format. Use YYYY-MM-DD.", "error");
            return;
        }
        endDateStr = exactDateMatch[1];
    } else if (/^\d+$/.test(trimmedInput)) {
        const days = parseInt(trimmedInput, 10);
        const endDate = new Date(today);
        endDate.setDate(today.getDate() + days);
        endDateStr = endDate.toISOString().split('T')[0];
    } else {
        showToast("Invalid input. Use days (e.g. 30) or YYYY-MM-DD.", "error");
        return;
    }

    const newId = Date.now();
    state.countdowns.push({
        id: newId,
        title: title,
        startDate: startDateStr,
        endDate: endDateStr,
        isTransparent: false
    });

    const saved = await saveCountdowns();
    if (saved) {
        renderCountdowns();
        showToast("Countdown added!", "success");
    } else {
        state.countdowns.pop();
        if (FileSystemModule.permissionNeedsUserGesture) {
            showFolderPermissionBannerIfNeeded();
        } else {
            showToast("Failed to save countdown. Check permissions.", "error");
        }
    }
}

function renderCountdowns() {
    const list = document.getElementById('countdown-list');
    if (!list) return;

    if (state.countdowns.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <p>No countdowns created yet.</p>
                <p class="text-xs">Click + Add to create a new goal / countdown.</p>
            </div>
        `;
        return;
    }

    list.innerHTML = '';
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Normalize to start of day

    state.countdowns.forEach(c => {
        const card = document.createElement('div');
        card.className = "countdown-item";

        let parseError = false;
        let start, end, totalDays, passedDays, remainingDays, progress = 0;

        try {
            start = new Date(c.startDate);
            start.setMinutes(start.getMinutes() + start.getTimezoneOffset()); // Fix timezone shift

            end = new Date(c.endDate);
            end.setMinutes(end.getMinutes() + end.getTimezoneOffset());

            totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
            passedDays = Math.round((today - start) / (1000 * 60 * 60 * 24));
            remainingDays = Math.round((end - today) / (1000 * 60 * 60 * 24)) + 1;

            progress = Math.min(100, Math.max(0, Math.round((passedDays / totalDays) * 100)));
            if (isNaN(progress)) progress = 0;
        } catch (e) {
            parseError = true;
        }

        if (parseError) {
            card.innerHTML = `<div class="cd-error">Error parsing dates for ${escapeHtml(c.title)}</div>`;
            list.appendChild(card);
            return;
        }

        // Determine styles based on urgency
        let progressColor = "var(--primary-color)";
        let alertBadge = "";

        if (remainingDays <= 0) {
            progressColor = "#e74c3c"; // Red
            alertBadge = `<span class="cd-badge critical"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> Deadline Passed</span>`;
            progress = 100; // Cap
        } else if (progress >= 100) {
            progressColor = "#2ecc71"; // Green
            alertBadge = `<span class="cd-badge success"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="margin-right:3px"><polyline points="20 6 9 17 4 12"></polyline></svg> Completed</span>`;
        } else if (remainingDays <= 3) {
            progressColor = "#e67e22"; // Orange
            alertBadge = `<span class="cd-badge warning"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> Only ${remainingDays} days left</span>`;
        } else {
            alertBadge = `<span class="cd-badge info">${remainingDays} days left</span>`;
        }

        const isTransparent = c.isTransparent === true;

        let html = `
            <div class="cd-header">
                <div class="cd-title">${escapeHtml(c.title)}</div>
                <div class="cd-header-actions">
                    <label class="cd-transparency-toggle" title="Transparency Mode">
                        <input type="checkbox" class="cd-trans-check" data-id="${c.id}" ${isTransparent ? 'checked' : ''}>
                        <span class="cd-toggle-text">Clear</span>
                    </label>
                    <button class="cd-mini-btn" data-id="${c.id}">Mini View</button>
                    <button class="cd-delete-btn" data-id="${c.id}" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
            </div>
            
            <div class="cd-meta">
                <span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> ${escapeHtml(c.startDate)} - ${escapeHtml(c.endDate)}</span>
                <span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${totalDays} days total</span>
                ${alertBadge}
            </div>
            
            <div class="cd-progress-container">
                <div class="cd-progress-text">Progress: ${progress}%</div>
                <div class="cd-progress-track">
                    <div class="cd-progress-fill" style="width: ${progress}%; background-color: ${progressColor};"></div>
                </div>
            </div>
            
            <div class="cd-grid">
        `;

        // Checkboxes Grid (Max 30 days displayed to prevent lag if huge)
        const displayDays = Math.min(totalDays, 100);
        for (let i = 0; i < displayDays; i++) {
            const dayDate = new Date(start);
            dayDate.setDate(dayDate.getDate() + i);
            const isDone = dayDate <= today;
            const isToday = i === passedDays;

            let btnClass = "cd-day";
            let label = i + 1;
            if (isDone) {
                btnClass += " done";
                label = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            } else if (isToday) {
                btnClass += " today";
            }

            html += `<div class="${btnClass}">${label}</div>`;
        }

        html += `</div>`;



        card.innerHTML = html;

        // Bind delete action
        card.querySelector('.cd-delete-btn').addEventListener('click', async () => {
            if (await showConfirm(`Delete countdown "${c.title}"?`)) {
                const original = [...state.countdowns];
                state.countdowns = state.countdowns.filter(item => item.id !== c.id);
                if (state.activeMiniViewId === c.id) closeMiniView();
                
                const saved = await saveCountdowns();
                if (saved) {
                    renderCountdowns();
                } else {
                    state.countdowns = original;
                    if (FileSystemModule.permissionNeedsUserGesture) {
                        showFolderPermissionBannerIfNeeded();
                    } else {
                        showToast("Failed to delete countdown. Check permissions.", "error");
                    }
                }
            }
        });

        // Bind mini view toggle
        const miniBtn = card.querySelector('.cd-mini-btn');
        if (miniBtn) {
            miniBtn.addEventListener('click', () => toggleMiniView(c.id));
        }

        // Bind transparency toggle
        const transCheck = card.querySelector('.cd-trans-check');
        if (transCheck) {
            transCheck.addEventListener('change', async (e) => {
                const checked = e.target.checked;
                const cdItem = state.countdowns.find(item => item.id === c.id);
                if (cdItem) {
                    const originalVal = cdItem.isTransparent;
                    cdItem.isTransparent = checked;
                    const saved = await saveCountdowns();
                    if (saved) {
                        // If this is the active mini view, refresh it (keep tab scope)
                        if (state.activeMiniViewId === c.id) {
                            const refreshTabId = await resolveActiveYouTubeTabId();
                            const scopedTabId = Number.isInteger(refreshTabId) ? refreshTabId : getBoundTabId();
                            if (Number.isInteger(scopedTabId)) {
                                chrome.storage.local.set({
                                    [`activeCountdownMiniView:${scopedTabId}`]: {
                                        ...cdItem,
                                        tabId: scopedTabId
                                    }
                                });
                            }
                        }
                    } else {
                        cdItem.isTransparent = originalVal;
                        e.target.checked = originalVal;
                        if (FileSystemModule.permissionNeedsUserGesture) {
                            showFolderPermissionBannerIfNeeded();
                        } else {
                            showToast("Failed to update transparency.", "error");
                        }
                    }
                }
            });
        }

        list.appendChild(card);
    });

    // Auto-restore mini view if active
    if (state.activeMiniViewId) {
        toggleMiniView(state.activeMiniViewId, true);
    }
}

// ---------------------------------------------------------
// Mini View Overlay Logic
// ---------------------------------------------------------

async function toggleMiniView(id, forceRestore = false) {
    // If clicking same active ID, close it
    if (state.activeMiniViewId === id && !forceRestore) {
        closeMiniView();
        return;
    }

    const cd = state.countdowns.find(c => c.id === id);
    if (!cd) {
        closeMiniView();
        return;
    }

    state.activeMiniViewId = id;

    // Scope overlay to this panel's bound YouTube tab only (per-tab storage key).
    const targetTabId = await resolveActiveYouTubeTabId();
    const scopedTabId = Number.isInteger(targetTabId) ? targetTabId : getBoundTabId();
    if (!Number.isInteger(scopedTabId)) return;
    chrome.storage.local.set({
        [`activeCountdownMiniView:${scopedTabId}`]: {
            ...cd,
            tabId: scopedTabId
        }
    });
}

function closeMiniView() {
    state.activeMiniViewId = null;
    const ourTab = getBoundTabId() ?? (Number.isInteger(currentTabId) ? currentTabId : null);
    const keys = ['activeCountdownMiniView', 'activeCountdownMiniViewPos'];
    if (Number.isInteger(ourTab)) {
        keys.push(`activeCountdownMiniView:${ourTab}`, `activeCountdownMiniViewPos:${ourTab}`);
    }
    chrome.storage.local.remove(keys);
}

// Listen for the content-script closing the mini view (own tab key only)
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    const ourTab = getBoundTabId() ?? (Number.isInteger(currentTabId) ? currentTabId : null);
    if (Number.isInteger(ourTab)) {
        const ownKey = `activeCountdownMiniView:${ourTab}`;
        if (changes[ownKey] && !changes[ownKey].newValue) {
            state.activeMiniViewId = null;
            return;
        }
    }
    // Legacy single-key path: only clear when the closed overlay was ours (or unscoped).
    if (changes.activeCountdownMiniView && !changes.activeCountdownMiniView.newValue) {
        const prev = changes.activeCountdownMiniView.oldValue;
        const prevTab = Number.isInteger(prev?.tabId) ? prev.tabId : null;
        if (prevTab === null || ourTab === null || prevTab === ourTab) {
            state.activeMiniViewId = null;
        }
    }
});
