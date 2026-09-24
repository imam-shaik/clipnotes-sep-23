// background/service-worker.js

const detachedPanelWindowByTab = new Map();
const relatedWindowsByTab = new Map(); // tabId -> Set of windowIds (detached panels, editors)
const DETACHED_PANEL_MIN_WIDTH = 180;
const DETACHED_PANEL_MAX_WIDTH = 480;
const DETACHED_PANEL_DEFAULT_WIDTH = 350;
const DETACHED_PANEL_MIN_HEIGHT = 640;
const HOST_MIN_CONTENT_WIDTH = 760;
const DETACHED_JOIN_OVERLAP = 9;

const TIMEOUT_CONFIG = {
  WINDOW_STATE_MAX_WAIT: 1500, // Max wait for maximize/restore transitions
  WINDOW_STATE_NORMAL_WAIT: 1000,
  DETACHED_SYNC_LOCK: 600, // Increased from 450ms to 600ms to prevent feedback loops
  BOUNDS_CHANGE_DEBOUNCE: 150, // Increased from 100ms to 150ms for stability
  POLL_INTERVAL_FAST: 50,
  POLL_INTERVAL_NORMAL: 200
};

// Keep track of original maximize states during tiling
const tilingRestoreStates = new Map();

// tabId -> Map<panelInstanceId, lastHeartbeatTs>
// Multiple panel instances may share a tab; close one must not mark the tab closed.
const panelHeartbeatByTab = new Map();
const LEGACY_PANEL_INSTANCE = '__default__';

function setPanelHeartbeat(tabId, instanceId = LEGACY_PANEL_INSTANCE) {
  if (!Number.isInteger(tabId)) return;
  let byInstance = panelHeartbeatByTab.get(tabId);
  if (!byInstance) {
    byInstance = new Map();
    panelHeartbeatByTab.set(tabId, byInstance);
  }
  byInstance.set(String(instanceId || LEGACY_PANEL_INSTANCE), Date.now());
}

function clearPanelHeartbeat(tabId, instanceId) {
  if (!Number.isInteger(tabId)) return;
  if (instanceId == null) {
    panelHeartbeatByTab.delete(tabId);
    return;
  }
  const byInstance = panelHeartbeatByTab.get(tabId);
  if (!byInstance) return;
  byInstance.delete(String(instanceId));
  if (byInstance.size === 0) panelHeartbeatByTab.delete(tabId);
}

// Fix #1: Persist detached panel state to survive service worker restarts
const STORAGE_KEY_DETACHED_PANELS = 'detachedPanelState_v1';

// Load persisted state on service worker startup
async function loadDetachedPanelState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_DETACHED_PANELS);
    const state = result[STORAGE_KEY_DETACHED_PANELS];
    if (state && typeof state === 'object') {
      // Restore detachedPanelWindowByTab
      if (state.panels) {
        for (const [tabIdStr, panelData] of Object.entries(state.panels)) {
          const tabId = parseInt(tabIdStr, 10);
          if (Number.isInteger(tabId)) {
            detachedPanelWindowByTab.set(tabId, panelData);
          }
        }
      }
      // Restore relatedWindowsByTab
      if (state.relatedWindows) {
        for (const [tabIdStr, windowIds] of Object.entries(state.relatedWindows)) {
          const tabId = parseInt(tabIdStr, 10);
          if (Number.isInteger(tabId) && Array.isArray(windowIds)) {
            relatedWindowsByTab.set(tabId, new Set(windowIds));
          }
        }
      }
      console.log(`[SW] Restored ${detachedPanelWindowByTab.size} detached panel(s) from storage`);
    }
  } catch (err) {
    console.error('[SW] Failed to load detached panel state:', err);
  }
}

// Save detached panel state to storage
async function saveDetachedPanelState() {
  try {
    const state = {
      panels: {},
      relatedWindows: {}
    };
    
    // Convert Maps to plain objects for storage
    for (const [tabId, entry] of detachedPanelWindowByTab.entries()) {
      state.panels[tabId] = entry;
    }
    
    for (const [tabId, windowSet] of relatedWindowsByTab.entries()) {
      state.relatedWindows[tabId] = Array.from(windowSet);
    }
    
    await chrome.storage.local.set({ [STORAGE_KEY_DETACHED_PANELS]: state });
  } catch (err) {
    console.error('[SW] Failed to save detached panel state:', err);
  }
}

// Initialize: Load persisted state
loadDetachedPanelState();

// Helper to wait for a window to reach a certain state (Fix #3)
async function waitForWindowState(windowId, targetState, maxWaitMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const win = await chrome.windows.get(windowId);
      if (win.state === targetState) return true;
    } catch (e) {
      break;
    }
    await new Promise(r => setTimeout(r, TIMEOUT_CONFIG.POLL_INTERVAL_FAST));
  }
  return false;
}

// 1. Consolidated Message Dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openBigEditor') {
    handleOpenBigEditor(message, sender, sendResponse);
    return true;
  } else if (message.action === 'syncNoteEdit') {
    handleSyncNoteEdit(message, sender, sendResponse);
    return true;
  } else if (message.action === 'openSidePanel') {
    handleOpenSidePanel(message, sender, sendResponse);
    return true;
  } else if (message.action === 'closeSidePanel') {
    handleCloseSidePanel(message, sender, sendResponse);
    return true;
  } else if (message.action === 'panelHeartbeat') {
    handlePanelHeartbeat(message, sender, sendResponse);
    return false;
  } else if (message.action === 'panelClosed') {
    handlePanelClosed(message, sender, sendResponse);
    return false;
  } else if (message.action === 'isPanelOpen') {
    handleIsPanelOpen(message, sender, sendResponse);
    return false;
  } else if (message.action === 'contentScriptReady') {
    handleContentScriptReady(message, sender, sendResponse);
    return false;
  } else if (message.action === 'getMyTabId') {
    sendResponse({
      success: true,
      tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null
    });
    return false;
  }
});

function handleOpenBigEditor(message, sender, sendResponse) {
  const { shotId, videoId, videoTitle, html } = message;
  // Per-shot buffer key so concurrent big editors cannot clobber each other.
  const bufferKey = shotId ? `bigEditorBuffer:${shotId}` : 'bigEditorBuffer';
  chrome.storage.local.set({ [bufferKey]: { shotId, html }, bigEditorBuffer: { shotId, html } }, () => {
    const query = new URLSearchParams({
      shotId,
      videoId,
      videoTitle: videoTitle || "Video Note",
      tabId: Number.isInteger(message.tabId) ? String(message.tabId) : ''
    });
    const url = chrome.runtime.getURL(`sidepanel/note-editor-big.html?${query.toString()}`);

    chrome.windows.create({
      url,
      type: "popup",
      width: 1000,
      height: 800,
      focused: true
    }).then(created => {
      if (created && created.id) {
        const tabId = message.tabId || sender?.tab?.id;
        if (tabId) {
          if (!relatedWindowsByTab.has(tabId)) relatedWindowsByTab.set(tabId, new Set());
          relatedWindowsByTab.get(tabId).add(created.id);
          // Persist state change
          saveDetachedPanelState();
        }
      }
    });
    sendResponse({ success: true });
  });
}

function handleSyncNoteEdit(message, sender, sendResponse) {
  chrome.runtime.sendMessage({
    type: 'NOTE_SYNCED',
    shotId: message.shotId,
    videoId: message.videoId,
    tabId: Number.isInteger(message.tabId) ? message.tabId : null,
    html: message.html
  });
  sendResponse({ success: true });
}

function handleOpenSidePanel(message, sender, sendResponse) {
  const tabId = sender?.tab?.id;
  if (!tabId) {
    sendResponse({ success: false, error: 'Missing tab id' });
    return;
  }
  openNotesPanelForTab(tabId, sender?.tab?.windowId)
    .then((ok) => sendResponse({ success: ok }))
    .catch(() => sendResponse({ success: false }));
}

function handleCloseSidePanel(message, sender, sendResponse) {
  const requestedTabId = Number(message.tabId);
  const tabId = Number.isInteger(requestedTabId) ? requestedTabId : sender?.tab?.id;
  if (!tabId) {
    sendResponse({ success: false, error: 'Missing tab id' });
    return;
  }
  closeNotesPanelForTab(tabId)
    .then((ok) => sendResponse({ success: ok }))
    .catch(() => sendResponse({ success: false }));
}

function handlePanelHeartbeat(message, sender, sendResponse) {
  const tabId = Number(message.tabId);
  if (Number.isInteger(tabId)) {
    setPanelHeartbeat(tabId, message.panelInstanceId || LEGACY_PANEL_INSTANCE);
  }
  sendResponse({ success: true });
}

function handlePanelClosed(message, sender, sendResponse) {
  const tabId = Number(message.tabId);
  if (Number.isInteger(tabId)) {
    // Only remove this panel instance; other panels on the tab keep the heartbeat alive.
    clearPanelHeartbeat(tabId, message.panelInstanceId || LEGACY_PANEL_INSTANCE);
  }
  sendResponse({ success: true });
}

function handleIsPanelOpen(message, sender, sendResponse) {
  const tabId = sender?.tab?.id;
  sendResponse({ success: true, open: isPanelOpenForTab(tabId) });
}

function handleContentScriptReady(message, sender, sendResponse) {
  try {
    chrome.runtime.sendMessage(
      {
        type: 'CONTENT_READY',
        videoId: message.videoId,
        tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null
      },
      () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      }
    );
  } catch (e) {
    console.warn('[SW] Failed to send message to panel:', e);
  }
  sendResponse({ success: true });
}
function isPanelOpenForTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const byInstance = panelHeartbeatByTab.get(tabId);
  if (!byInstance || byInstance.size === 0) return false;
  const now = Date.now();
  let anyLive = false;
  for (const [instanceId, ts] of Array.from(byInstance.entries())) {
    if (now - ts <= 4000) {
      anyLive = true;
    } else {
      byInstance.delete(instanceId);
    }
  }
  if (byInstance.size === 0) panelHeartbeatByTab.delete(tabId);
  return anyLive;
}

async function resolveHostWindowForTab(tabId, hostWindowIdHint) {
  const hintedWindowId = Number(hostWindowIdHint);
  if (Number.isInteger(hintedWindowId)) {
    try {
      return await chrome.windows.get(hintedWindowId);
    } catch (_) {
      // Fall through to tab lookup.
    }
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (Number.isInteger(tab?.windowId)) {
      return await chrome.windows.get(tab.windowId);
    }
  } catch (e) {
    console.debug('[SW] Failed to resolve host window for tab:', tabId, e);
  }

  return null;
}

function pickDetachedPanelWidth(hostWidth) {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) {
    return DETACHED_PANEL_DEFAULT_WIDTH;
  }
  const byRatio = Math.round(hostWidth * 0.28);
  return Math.max(DETACHED_PANEL_MIN_WIDTH, Math.min(DETACHED_PANEL_MAX_WIDTH, byRatio));
}

function clampDetachedPanelWidth(width) {
  const value = Number(width);
  if (!Number.isFinite(value) || value <= 0) return DETACHED_PANEL_DEFAULT_WIDTH;
  return Math.max(DETACHED_PANEL_MIN_WIDTH, Math.min(DETACHED_PANEL_MAX_WIDTH, Math.round(value)));
}

function joinedPanelLeft(hostLeft, hostWidth) {
  return Math.round(hostLeft + hostWidth - DETACHED_JOIN_OVERLAP);
}

function lockDetachedSync(entry) {
  if (!entry) return;
  entry.syncLockUntil = Date.now() + TIMEOUT_CONFIG.DETACHED_SYNC_LOCK;
}

function isDetachedSyncLocked(entry) {
  return Number(entry?.syncLockUntil) > Date.now();
}

function findDetachedEntryByWindowId(windowId) {
  for (const [tabId, entry] of detachedPanelWindowByTab.entries()) {
    if (Number(entry?.panelWindowId) === windowId) {
      return { tabId, entry, role: "panel" };
    }
    if (Number(entry?.hostWindowId) === windowId) {
      return { tabId, entry, role: "host" };
    }
  }
  return null;
}

async function syncDetachedPairFromHost(tabId) {
  const entry = detachedPanelWindowByTab.get(tabId);
  if (!entry) return false;

  const hostWindowId = Number(entry.hostWindowId);
  const panelWindowId = Number(entry.panelWindowId);
  if (!Number.isInteger(hostWindowId) || !Number.isInteger(panelWindowId)) return false;

  try {
    const [hostWindow, panelWindow] = await Promise.all([
      chrome.windows.get(hostWindowId),
      chrome.windows.get(panelWindowId)
    ]);
    if (!hostWindow || !panelWindow) return false;
    if (hostWindow.state !== "normal" || panelWindow.state !== "normal") return false;

    const panelWidth = clampDetachedPanelWidth(panelWindow.width || entry.panelWidth);
    const nextLeft = Math.round(joinedPanelLeft(hostWindow.left, hostWindow.width));
    const nextTop = Math.round(hostWindow.top);
    const nextHeight = Math.max(DETACHED_PANEL_MIN_HEIGHT, hostWindow.height);

    // ENHANCED DELTA CHECK: Skip if already aligned within 3 pixels (increased from 2px for OS tolerance)
    const deltaL = Math.abs(Number(panelWindow.left) - nextLeft);
    const deltaT = Math.abs(Number(panelWindow.top) - nextTop);
    const deltaW = Math.abs(Number(panelWindow.width) - panelWidth);
    const deltaH = Math.abs(Number(panelWindow.height) - nextHeight);
    
    // Increased tolerance to 3px to account for OS rounding and DPI scaling
    if (deltaL < 3 && deltaT < 3 && deltaW < 3 && deltaH < 3) {
      return true;
    }

    lockDetachedSync(entry);
    await chrome.windows.update(panelWindowId, {
      left: nextLeft,
      top: nextTop,
      width: panelWidth,
      height: nextHeight
    });

    entry.panelWidth = panelWidth;
    setPanelHeartbeat(tabId);

    // Persist widths
    chrome.storage.local.set({
      lastPreferredHostWidth: hostWindow.width,
      lastPreferredPanelWidth: panelWidth
    });

    return true;
  } catch (_) {
    return false;
  }
}

async function syncDetachedPairFromPanel(tabId) {
  const entry = detachedPanelWindowByTab.get(tabId);
  if (!entry) return false;

  const hostWindowId = Number(entry.hostWindowId);
  const panelWindowId = Number(entry.panelWindowId);
  if (!Number.isInteger(hostWindowId) || !Number.isInteger(panelWindowId)) return false;

  try {
    const [hostWindow, panelWindow] = await Promise.all([
      chrome.windows.get(hostWindowId),
      chrome.windows.get(panelWindowId)
    ]);
    if (!hostWindow || !panelWindow) return false;
    if (hostWindow.state !== "normal" || panelWindow.state !== "normal") return false;

    const proposedHostWidth = panelWindow.left - hostWindow.left + DETACHED_JOIN_OVERLAP;
    const panelWidth = clampDetachedPanelWidth(panelWindow.width || entry.panelWidth);

    // If panel was moved far away, snap it back to host instead of exploding host width.
    if (!Number.isFinite(proposedHostWidth) || proposedHostWidth < (HOST_MIN_CONTENT_WIDTH * 0.5) || proposedHostWidth > 4000) {
      return await syncDetachedPairFromHost(tabId);
    }

    const hostWidth = Math.max(HOST_MIN_CONTENT_WIDTH, Math.round(proposedHostWidth));
    const panelLeft = Math.round(joinedPanelLeft(hostWindow.left, hostWidth));
    const panelTop = Math.round(hostWindow.top);
    const panelHeight = Math.max(DETACHED_PANEL_MIN_HEIGHT, hostWindow.height);

    // ENHANCED DELTA CHECK: Increased tolerance to 3px to prevent feedback loops
    const hDeltaW = Math.abs(Number(hostWindow.width) - hostWidth);
    const pDeltaL = Math.abs(Number(panelWindow.left) - panelLeft);
    const pDeltaT = Math.abs(Number(panelWindow.top) - panelTop);
    const pDeltaW = Math.abs(Number(panelWindow.width) - panelWidth);
    const pDeltaH = Math.abs(Number(panelWindow.height) - panelHeight);

    // Increased tolerance to 3px to account for OS rounding and DPI scaling
    if (hDeltaW < 3 && pDeltaL < 3 && pDeltaT < 3 && pDeltaW < 3 && pDeltaH < 3) {
      return true;
    }

    lockDetachedSync(entry);
    await chrome.windows.update(hostWindowId, {
      left: hostWindow.left,
      top: hostWindow.top,
      width: hostWidth,
      height: hostWindow.height
    });
    await chrome.windows.update(panelWindowId, {
      left: panelLeft,
      top: panelTop,
      width: panelWidth,
      height: panelHeight
    });

    entry.panelWidth = panelWidth;
    setPanelHeartbeat(tabId);

    // Persist widths
    chrome.storage.local.set({
      lastPreferredHostWidth: hostWidth,
      lastPreferredPanelWidth: panelWidth
    });

    return true;
  } catch (_) {
    return false;
  }
}

async function openDetachedPanelWindow(tabId, hostWindowIdHint) {
  const existingEntry = detachedPanelWindowByTab.get(tabId);
  const existingWindowId = Number(existingEntry?.panelWindowId);
  if (Number.isInteger(existingWindowId)) {
    try {
      await chrome.windows.update(existingWindowId, { focused: true });
      await syncDetachedPairFromHost(tabId);
      return true;
    } catch (_) {
      detachedPanelWindowByTab.delete(tabId);
    }
  }

  let hostWindow = await resolveHostWindowForTab(tabId, hostWindowIdHint);
  if (!hostWindow) return false;

  const originalHostState = hostWindow.state || "normal";
  const originalHostBounds = {
    left: hostWindow.left,
    top: hostWindow.top,
    width: hostWindow.width,
    height: hostWindow.height
  };

  // 1. Foolproof Native Screen Measurement
  // We briefly maximize the window to ask the OS EXACTLY what the monitor bounds are,
  // including all invisible border compensations and taskbars.
  let screenBounds = null;
  if (originalHostState === "maximized") {
    screenBounds = hostWindow;
  } else {
    try {
      await chrome.windows.update(hostWindow.id, { state: "maximized" });
      // Use config for robust wait
      await waitForWindowState(hostWindow.id, "maximized", TIMEOUT_CONFIG.WINDOW_STATE_MAX_WAIT);
      screenBounds = await chrome.windows.get(hostWindow.id);
    } catch (_) {
      screenBounds = hostWindow; // absolute fallback
    }
  }

  // 2. Put host back into "normal" state so we can freely position it
  try {
    await chrome.windows.update(hostWindow.id, { state: "normal" });
    // Use config for robust wait
    await waitForWindowState(hostWindow.id, "normal", TIMEOUT_CONFIG.WINDOW_STATE_NORMAL_WAIT);
  } catch (e) {
    console.warn('[SW] Failed to set host window to normal state:', e);
  }

  // Retrieve last saved panel width (ignore host width to ensure full-screen fill)
  let storedPanelWidth = null;
  try {
    const data = await chrome.storage.local.get(['lastPreferredPanelWidth']);
    if (data.lastPreferredPanelWidth) {
      storedPanelWidth = clampDetachedPanelWidth(data.lastPreferredPanelWidth);
    }
  } catch (e) {
    console.debug('[SW] Failed to retrieve stored panel width:', e);
  }

  const baseLeft = Number(screenBounds.left);
  const baseTop = Number(screenBounds.top);
  const totalAvailableWidth = Number(screenBounds.width);
  const totalAvailableHeight = Number(screenBounds.height);

  const panelWidth = storedPanelWidth || pickDetachedPanelWidth(totalAvailableWidth);
  const panelHeight = Math.max(DETACHED_PANEL_MIN_HEIGHT, totalAvailableHeight);

  // 3. FORCE Tiling: Ensure host + panel EXACTLY fill the totalAvailableWidth
  // We ignore storedHostWidth here to guarantee the "Full Screen Opening" objective.
  const resizedHostWidth = totalAvailableWidth - panelWidth + DETACHED_JOIN_OVERLAP;

  let left;
  let top = baseTop;
  let hostResizeRestore = null;

  if (Number.isFinite(resizedHostWidth) && resizedHostWidth >= HOST_MIN_CONTENT_WIDTH) {
    try {
      // Use absolute coordinates from maximized state to cover entire workspace
      await chrome.windows.update(hostWindow.id, {
        state: "normal",
        left: Math.round(baseLeft),
        top: Math.round(baseTop),
        width: Math.round(resizedHostWidth),
        height: Math.round(totalAvailableHeight)
      });

      left = Math.round(joinedPanelLeft(baseLeft, resizedHostWidth));
      hostResizeRestore = {
        hostWindowId: hostWindow.id,
        restoreState: originalHostState,
        left: Math.round(originalHostBounds.left),
        top: Math.round(originalHostBounds.top),
        width: Math.round(originalHostBounds.width),
        height: Math.round(originalHostBounds.height)
      };
    } catch (err) {
      console.warn("SW: Failed to update host bounds:", err);
      left = joinedPanelLeft(baseLeft, Math.max(HOST_MIN_CONTENT_WIDTH, resizedHostWidth));
    }
  } else {
    left = joinedPanelLeft(baseLeft, totalAvailableWidth);
  }

  const query = new URLSearchParams({
    tabId: String(tabId),
    mode: "detached",
    hostWindowId: String(hostWindow?.id || "")
  });
  const url = chrome.runtime.getURL(`sidepanel/panel.html?${query.toString()}`);
  try {
    const createOptions = {
      url,
      type: "popup",
      width: panelWidth,
      height: panelHeight,
      focused: true
    };
    if (Number.isInteger(left)) createOptions.left = left;
    if (Number.isInteger(top)) createOptions.top = top;

    const created = await chrome.windows.create({
      ...createOptions
    });
    if (Number.isInteger(created?.id)) {
      detachedPanelWindowByTab.set(tabId, {
        panelWindowId: created.id,
        hostWindowId: hostWindow.id,
        panelWidth,
        syncLockUntil: Date.now() + 1500, // Lock for 1.5s to allow OS animations to finish
        hostResizeRestore
      });
      // Track related window
      if (!relatedWindowsByTab.has(tabId)) relatedWindowsByTab.set(tabId, new Set());
      relatedWindowsByTab.get(tabId).add(created.id);

      // Persist state to survive service worker restarts
      saveDetachedPanelState();

      // Initial tiling is already perfected by the created/update calls with shared bounds.
      // Re-triggering sync immediately would just risk race conditions with partially applied OS bounds.
    }
    return true;
  } catch (_) {
    if (hostResizeRestore && Number.isInteger(hostResizeRestore.hostWindowId)) {
      try {
        await chrome.windows.update(hostResizeRestore.hostWindowId, {
          left: hostResizeRestore.left,
          top: hostResizeRestore.top,
          width: hostResizeRestore.width,
          height: hostResizeRestore.height
        });
        if (hostResizeRestore.restoreState && hostResizeRestore.restoreState !== "normal") {
          await chrome.windows.update(hostResizeRestore.hostWindowId, {
            state: hostResizeRestore.restoreState
          });
        }
      } catch (e) {
        console.warn('[SW] Failed to restore host window bounds:', e);
      }
    }
    return false;
  }
}

async function openNotesPanelForTab(tabId, hostWindowIdHint = null) {
  if (!Number.isInteger(tabId)) return false;

  const windowId = Number.isInteger(hostWindowIdHint) ? hostWindowIdHint : null;

  if (chrome.sidePanel?.setOptions && chrome.sidePanel?.open) {
    try {
      // Session claim: panel adopts this if Chrome strips ?tabId= from the path.
      if (chrome.storage?.session?.set) {
        try {
          await chrome.storage.session.set({
            pendingSidePanelTabId: tabId,
            pendingSidePanelWindowId: windowId,
            pendingSidePanelToken: `${tabId}:${Date.now()}`,
            pendingSidePanelOpenedAt: Date.now()
          });
        } catch (_) { /* session storage optional */ }
      }
      const pathQuery = new URLSearchParams({ tabId: String(tabId) });
      if (Number.isInteger(windowId)) pathQuery.set('hostWindowId', String(windowId));
      await chrome.sidePanel.setOptions({
        tabId,
        path: `sidepanel/panel.html?${pathQuery.toString()}`,
        enabled: true
      });
      await chrome.sidePanel.open({ tabId });
      setPanelHeartbeat(tabId);
      return true;
    } catch (_) {
      // Fall back to detached panel window (installed app windows may block sidePanel.open()).
    }
  }

  const detachedOpened = await openDetachedPanelWindow(tabId, hostWindowIdHint);
  if (detachedOpened) {
    setPanelHeartbeat(tabId);
    return true;
  }

  return false;
}

async function closeNotesPanelForTab(tabId) {
  if (!Number.isInteger(tabId)) return false;

  panelHeartbeatByTab.delete(tabId);

  if (chrome.storage?.session?.remove) {
    try {
      await chrome.storage.session.remove([
        'pendingSidePanelTabId',
        'pendingSidePanelWindowId',
        'pendingSidePanelToken',
        'pendingSidePanelOpenedAt'
      ]);
    } catch (_) { /* ignore */ }
  }

  let closedAnything = false;

  const detachedEntry = detachedPanelWindowByTab.get(tabId);
  const detachedWindowId = Number(detachedEntry?.panelWindowId);
  if (Number.isInteger(detachedWindowId)) {
    detachedPanelWindowByTab.delete(tabId);
    try {
      await chrome.windows.remove(detachedWindowId);
      closedAnything = true;
    } catch (e) {
      // Window already closed or inaccessible.
      console.debug('[SW] Window already closed or inaccessible:', winId, e);
    }
  }

  // Close all other related windows (e.g. Big Editor)
  const related = relatedWindowsByTab.get(tabId);
  if (related) {
    related.forEach(winId => {
      chrome.windows.remove(winId).catch((err) => {
        console.debug('[SW] Failed to close related window:', winId, err);
      });
    });
    relatedWindowsByTab.delete(tabId);
  }

  const hostResizeRestore = detachedEntry?.hostResizeRestore;
  if (
    hostResizeRestore &&
    Number.isInteger(hostResizeRestore.hostWindowId)
  ) {
    try {
      await chrome.windows.update(hostResizeRestore.hostWindowId, {
        left: hostResizeRestore.left,
        top: hostResizeRestore.top,
        width: hostResizeRestore.width,
        height: hostResizeRestore.height
      });
      if (hostResizeRestore.restoreState && hostResizeRestore.restoreState !== "normal") {
        await chrome.windows.update(hostResizeRestore.hostWindowId, {
          state: hostResizeRestore.restoreState
        });
      }
    } catch (_) {
      // Host window may have been closed or moved manually.
    }
  }

  if (chrome.sidePanel?.setOptions) {
    try {
      await chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel/panel.html",
        enabled: false
      });
      closedAnything = true;
    } catch (_) {
      // Ignore and rely on detached-window close path if used.
    }
  }

  return closedAnything;
}

// Initialize context menus and listeners
chrome.runtime.onInstalled.addListener(async (details) => {
  // Create context menu
  chrome.contextMenus.create({
    id: "open-notes-panel",
    title: "Open YouTube Notes Panel",
    contexts: ["all"],
    documentUrlPatterns: ["*://*.youtube.com/watch*"]
  });

  // Mass-inject into existing YouTube tabs on install/update
  // This allows the extension to work immediately without a page refresh
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://*.youtube.com/*"]
    });

    for (const tab of tabs) {
      // Inject main content script
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content-script.js"]
      }).catch(err => console.warn(`Failed to inject content script into tab ${tab.id}:`, err));

      // Inject page bridge (MAIN world)
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/page-bridge.js"],
        world: "MAIN"
      }).catch(err => console.warn(`Failed to inject page bridge into tab ${tab.id}:`, err));

      // Inject styles
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content/content-styles.css"]
      }).catch(err => console.warn(`Failed to inject CSS into tab ${tab.id}:`, err));
    }
    console.log(`Mass-injected into ${tabs.length} tabs.`);
  } catch (err) {
    console.error("Mass-injection failed:", err);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-notes-panel") {
    openNotesPanelForTab(tab?.id, tab?.windowId).catch((err) => {
      console.error('[SW] Failed to open notes panel from context menu:', err);
    });
  }
});

// Automatically trigger side panel globally or on icon click
chrome.action.onClicked.addListener((tab) => {
  openNotesPanelForTab(tab?.id, tab?.windowId).catch((err) => {
    console.error('[SW] Failed to open notes panel from action click:', err);
  });
});


chrome.tabs.onRemoved.addListener((tabId) => {
  panelHeartbeatByTab.delete(tabId);
  const entry = detachedPanelWindowByTab.get(tabId);
  const panelWindowId = Number(entry?.panelWindowId);
  const hostResizeRestore = entry?.hostResizeRestore;
  detachedPanelWindowByTab.delete(tabId);
  if (Number.isInteger(panelWindowId)) {
    chrome.windows.remove(panelWindowId).catch((err) => {
      console.debug('[SW] Failed to remove panel window on tab close:', err);
    });
  }

  // Clear auto-open timer for this tab
  if (autoOpenTimers.has(tabId)) {
    clearTimeout(autoOpenTimers.get(tabId));
    autoOpenTimers.delete(tabId);
  }

  // Close all other related windows (e.g. Big Editor)
  const related = relatedWindowsByTab.get(tabId);
  if (related) {
    related.forEach(winId => {
      chrome.windows.remove(winId).catch((err) => {
        console.debug('[SW] Failed to close related window on tab close:', winId, err);
      });
    });
    relatedWindowsByTab.delete(tabId);
  }

  // Persist state change
  saveDetachedPanelState();

  if (hostResizeRestore && Number.isInteger(hostResizeRestore.hostWindowId)) {
    chrome.windows.update(hostResizeRestore.hostWindowId, {
      left: hostResizeRestore.left,
      top: hostResizeRestore.top,
      width: hostResizeRestore.width,
      height: hostResizeRestore.height
    }).then(() => {
      if (hostResizeRestore.restoreState && hostResizeRestore.restoreState !== "normal") {
        return chrome.windows.update(hostResizeRestore.hostWindowId, { state: hostResizeRestore.restoreState });
      }
    }).catch((err) => {
      console.warn('[SW] Failed to restore host window bounds on panel close:', err);
    });
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [tabId, entry] of detachedPanelWindowByTab.entries()) {
    const panelWindowId = Number(entry?.panelWindowId);
    const hostWindowId = Number(entry?.hostWindowId);

    if (panelWindowId === windowId) {
      detachedPanelWindowByTab.delete(tabId);
      panelHeartbeatByTab.delete(tabId);
      const hostResizeRestore = entry?.hostResizeRestore;
      if (hostResizeRestore && Number.isInteger(hostResizeRestore.hostWindowId)) {
        chrome.windows.update(hostResizeRestore.hostWindowId, {
          left: hostResizeRestore.left,
          top: hostResizeRestore.top,
          width: hostResizeRestore.width,
          height: hostResizeRestore.height
        }).then(() => {
          if (hostResizeRestore.restoreState && hostResizeRestore.restoreState !== "normal") {
            return chrome.windows.update(hostResizeRestore.hostWindowId, { state: hostResizeRestore.restoreState });
          }
        }).catch((err) => {
          console.warn('[SW] Failed to restore host window bounds on window remove:', err);
        });
      }
      // Persist state change
      saveDetachedPanelState();
      break;
    }

    // If host window closes, force-close detached panel and all related extension windows.
    if (hostWindowId === windowId) {
      detachedPanelWindowByTab.delete(tabId);
      panelHeartbeatByTab.delete(tabId);

      if (Number.isInteger(panelWindowId) && panelWindowId !== windowId) {
        chrome.windows.remove(panelWindowId).catch((err) => {
          console.debug('[SW] Failed to remove panel window on host close:', err);
        });
      }

      const related = relatedWindowsByTab.get(tabId);
      if (related) {
        related.forEach((winId) => {
          if (winId !== windowId && winId !== panelWindowId) {
            chrome.windows.remove(winId).catch((err) => {
              console.debug('[SW] Failed to close related window on host close:', winId, err);
            });
          }
        });
        relatedWindowsByTab.delete(tabId);
      }
      // Persist state change
      saveDetachedPanelState();
      break;
    }
  }

  // Also remove from relatedWindowsByTab
  for (const [tabId, windowSet] of relatedWindowsByTab.entries()) {
    if (windowSet.has(windowId)) {
      windowSet.delete(windowId);
      if (windowSet.size === 0) relatedWindowsByTab.delete(tabId);
    }
  }

  // Cleanup debounce timers for the closing window
  if (boundsChangeDebounceTimers.has(windowId)) {
    clearTimeout(boundsChangeDebounceTimers.get(windowId));
    boundsChangeDebounceTimers.delete(windowId);
  }
  
  // Persist state change
  saveDetachedPanelState();
});

const boundsChangeDebounceTimers = new Map();

// Helper function to execute bounds change sync logic
function onBoundsChangedExecution(windowId) {
  const match = findDetachedEntryByWindowId(windowId);
  if (!match) return;
  
  const { tabId, entry, role } = match;
  if (isDetachedSyncLocked(entry)) return;
  
  // --- CRITICAL FIX: Leader/Follower Architecture ---
  // ONLY sync when the HOST (leader) window moves.
  // Ignore all movements from the panel (follower) itself.
  // This breaks the feedback loop that causes high-CPU thrashing.
  if (role === "host") {
    syncDetachedPairFromHost(tabId).catch((err) => {
      console.warn("Host-led sync failed:", err);
    });
  }
  // By removing the 'else' block, the panel can no longer
  // trigger a resize on the host, preventing the loop.
  // --- END OF FIX ---
}

chrome.windows.onBoundsChanged.addListener((window) => {
  const windowId = Number(window?.id);
  if (!Number.isInteger(windowId)) return;

  const match = findDetachedEntryByWindowId(windowId);
  if (!match) return;

  const { tabId, entry, role } = match;
  if (isDetachedSyncLocked(entry)) return;

  // Debounce rapid resize events to prevent CPU thrashing (per-window)
  if (boundsChangeDebounceTimers.has(windowId)) {
    clearTimeout(boundsChangeDebounceTimers.get(windowId));
  }

  const timer = setTimeout(() => {
    boundsChangeDebounceTimers.delete(windowId);
    onBoundsChangedExecution(windowId);
  }, TIMEOUT_CONFIG.BOUNDS_CHANGE_DEBOUNCE);

  boundsChangeDebounceTimers.set(windowId, timer);
});

const autoOpenTimers = new Map();

// Keep per-tab side panel paths unique so switching tabs reloads the panel
// bound to THAT tab (Chrome may skip reload when path strings match).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !tab.url.includes('youtube.com/watch')) return;
    if (!chrome.sidePanel?.setOptions) return;
    const pathQuery = new URLSearchParams({ tabId: String(tabId) });
    if (Number.isInteger(tab.windowId)) pathQuery.set('hostWindowId', String(tab.windowId));
    await chrome.sidePanel.setOptions({
      tabId,
      path: `sidepanel/panel.html?${pathQuery.toString()}`,
      enabled: true
    });
  } catch (_) { /* tab may be gone */ }
});

// Auto-open logic on navigation
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com/watch')) {
    try {
      // Check if auto-open is enabled (default true)
      const data = await chrome.storage.local.get('isAutoOpenEnabled');
      const isAutoOpenEnabled = data.isAutoOpenEnabled !== false; // Correct default to true

      if (isAutoOpenEnabled) {
        // Check if panel is already open to avoid duplicate/flicker
        if (!isPanelOpenForTab(tabId)) {
          // Clear any existing timer for this tab
          if (autoOpenTimers.has(tabId)) {
            clearTimeout(autoOpenTimers.get(tabId));
          }

          // Small delay to ensure content script is ready or page is stable
          const timer = setTimeout(async () => {
            autoOpenTimers.delete(tabId);
            try {
              // Re-check if still on watch page and panel still not open
              const currentTab = await chrome.tabs.get(tabId).catch(() => null);
              if (currentTab?.url?.includes('youtube.com/watch') && !isPanelOpenForTab(tabId)) {
                await openNotesPanelForTab(tabId, currentTab.windowId);
              }
            } catch (err) {
              console.warn("Auto-open background check failed:", err);
            }
          }, 1000);

          autoOpenTimers.set(tabId, timer);
        }
      }
    } catch (e) {
      console.error('Auto-open failed:', e);
    }
  }
});
