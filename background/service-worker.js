// background/service-worker.js

const panelHeartbeatByTab = new Map();
const detachedPanelWindowByTab = new Map();
const DETACHED_PANEL_MIN_WIDTH = 380;
const DETACHED_PANEL_MAX_WIDTH = 480;
const DETACHED_PANEL_DEFAULT_WIDTH = 430;
const DETACHED_PANEL_MIN_HEIGHT = 640;
const HOST_MIN_CONTENT_WIDTH = 760;
const DETACHED_SYNC_LOCK_MS = 450;
const DETACHED_JOIN_OVERLAP = 8;

function isPanelOpenForTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const ts = panelHeartbeatByTab.get(tabId);
  if (!ts) return false;
  return (Date.now() - ts) <= 7000;
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
  } catch (_) { }

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
  entry.syncLockUntil = Date.now() + DETACHED_SYNC_LOCK_MS;
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
    const nextLeft = joinedPanelLeft(hostWindow.left, hostWindow.width);
    const nextTop = hostWindow.top;
    const nextHeight = Math.max(DETACHED_PANEL_MIN_HEIGHT, hostWindow.height);

    lockDetachedSync(entry);
    await chrome.windows.update(panelWindowId, {
      left: nextLeft,
      top: nextTop,
      width: panelWidth,
      height: nextHeight
    });

    entry.panelWidth = panelWidth;
    panelHeartbeatByTab.set(tabId, Date.now());
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
    const panelLeft = joinedPanelLeft(hostWindow.left, hostWidth);
    const panelTop = hostWindow.top;
    const panelHeight = Math.max(DETACHED_PANEL_MIN_HEIGHT, hostWindow.height);

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
    panelHeartbeatByTab.set(tabId, Date.now());
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
  const originalHostState = hostWindow?.state || "normal";
  const originalHostBounds = hostWindow ? {
    left: hostWindow.left,
    top: hostWindow.top,
    width: hostWindow.width,
    height: hostWindow.height
  } : null;

  if (hostWindow && hostWindow.state === "maximized") {
    try {
      await chrome.windows.update(hostWindow.id, { state: "normal" });
      hostWindow = await chrome.windows.get(hostWindow.id);
    } catch (_) {
      // If normalization fails, continue with current bounds.
    }
  }
  const layoutBase = (originalHostState === "maximized" && originalHostBounds) ? originalHostBounds : hostWindow;
  const panelWidth = pickDetachedPanelWidth(layoutBase?.width);
  const panelHeight = Math.max(DETACHED_PANEL_MIN_HEIGHT, Number(layoutBase?.height) || 900);

  let left;
  let top;
  let hostResizeRestore = null;

  if (hostWindow && Number.isInteger(layoutBase?.left) && Number.isInteger(layoutBase?.top)) {
    const baseLeft = layoutBase.left;
    const baseTop = layoutBase.top;
    const baseWidth = Number(layoutBase.width);
    const baseHeight = Number(layoutBase.height);
    top = baseTop;

    if (
      hostWindow.state === "normal" &&
      Number.isFinite(baseWidth) &&
      Number.isFinite(baseHeight) &&
      (baseWidth - panelWidth + DETACHED_JOIN_OVERLAP) >= HOST_MIN_CONTENT_WIDTH
    ) {
      const resizedHostWidth = baseWidth - panelWidth + DETACHED_JOIN_OVERLAP;
      try {
        await chrome.windows.update(hostWindow.id, {
          left: baseLeft,
          top: baseTop,
          width: resizedHostWidth,
          height: baseHeight
        });
        left = joinedPanelLeft(baseLeft, resizedHostWidth);
        hostResizeRestore = {
          hostWindowId: hostWindow.id,
          restoreState: originalHostState,
          left: originalHostBounds?.left ?? baseLeft,
          top: originalHostBounds?.top ?? baseTop,
          width: originalHostBounds?.width ?? baseWidth,
          height: originalHostBounds?.height ?? baseHeight
        };
      } catch (_) {
        left = joinedPanelLeft(baseLeft, Math.max(HOST_MIN_CONTENT_WIDTH, baseWidth - panelWidth + DETACHED_JOIN_OVERLAP));
      }
    } else if (Number.isFinite(baseWidth)) {
      left = joinedPanelLeft(baseLeft, baseWidth);
    }
  }

  const query = new URLSearchParams({
    tabId: String(tabId),
    mode: "detached"
  });
  if (Number.isInteger(hostWindow?.id)) {
    query.set("hostWindowId", String(hostWindow.id));
  }
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
        hostWindowId: Number.isInteger(hostWindow?.id) ? hostWindow.id : null,
        panelWidth,
        syncLockUntil: 0,
        hostResizeRestore
      });
      await syncDetachedPairFromHost(tabId);
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
      } catch (_) { }
    }
    return false;
  }
}

async function openNotesPanelForTab(tabId, hostWindowIdHint = null) {
  if (!Number.isInteger(tabId)) return false;

  if (chrome.sidePanel?.setOptions && chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel/panel.html",
        enabled: true
      });
      await chrome.sidePanel.open({ tabId });
      panelHeartbeatByTab.set(tabId, Date.now());
      return true;
    } catch (_) {
      // Fall back to detached panel window (installed app windows may block sidePanel.open()).
    }
  }

  const detachedOpened = await openDetachedPanelWindow(tabId, hostWindowIdHint);
  if (detachedOpened) {
    panelHeartbeatByTab.set(tabId, Date.now());
    return true;
  }

  return false;
}

async function closeNotesPanelForTab(tabId) {
  if (!Number.isInteger(tabId)) return false;

  panelHeartbeatByTab.delete(tabId);

  let closedAnything = false;

  const detachedEntry = detachedPanelWindowByTab.get(tabId);
  const detachedWindowId = Number(detachedEntry?.panelWindowId);
  if (Number.isInteger(detachedWindowId)) {
    detachedPanelWindowByTab.delete(tabId);
    try {
      await chrome.windows.remove(detachedWindowId);
      closedAnything = true;
    } catch (_) {
      // Window already closed.
    }
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
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-notes-panel",
    title: "Open YouTube Notes Panel",
    contexts: ["all"],
    documentUrlPatterns: ["*://*.youtube.com/watch*"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-notes-panel") {
    openNotesPanelForTab(tab?.id, tab?.windowId).catch(() => { });
  }
});

// Automatically trigger side panel globally or on icon click
chrome.action.onClicked.addListener((tab) => {
  openNotesPanelForTab(tab?.id, tab?.windowId).catch(() => { });
});

// Listener to handle messages from content script or panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openSidePanel') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Missing tab id' });
      return false;
    }

    openNotesPanelForTab(tabId, sender?.tab?.windowId)
      .then((ok) => sendResponse({ success: ok }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.action === 'closeSidePanel') {
    const requestedTabId = Number(message.tabId);
    const tabId = Number.isInteger(requestedTabId) ? requestedTabId : sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Missing tab id' });
      return false;
    }

    closeNotesPanelForTab(tabId)
      .then((ok) => sendResponse({ success: ok }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.action === 'panelHeartbeat') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      panelHeartbeatByTab.set(tabId, Date.now());
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'panelClosed') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      panelHeartbeatByTab.delete(tabId);
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'isPanelOpen') {
    const tabId = sender?.tab?.id;
    sendResponse({ success: true, open: isPanelOpenForTab(tabId) });
    return false;
  }

  if (message.action === 'contentScriptReady') {
    // Notify the side panel that content script is ready
    // CRITICAL: Side panel may not be open, so we MUST handle the error
    try {
      chrome.runtime.sendMessage(
        { type: 'CONTENT_READY', videoId: message.videoId },
        () => {
          // Check for error (side panel not listening) and ignore it
          if (chrome.runtime.lastError) {
            // Totally normal — side panel may not be open yet
          }
        }
      );
    } catch (e) {
      // Swallow: Side panel not available
    }
    sendResponse({ success: true });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelHeartbeatByTab.delete(tabId);
  const entry = detachedPanelWindowByTab.get(tabId);
  const panelWindowId = Number(entry?.panelWindowId);
  const hostResizeRestore = entry?.hostResizeRestore;
  detachedPanelWindowByTab.delete(tabId);
  if (Number.isInteger(panelWindowId)) {
    chrome.windows.remove(panelWindowId).catch(() => { });
  }
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
    }).catch(() => { });
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [tabId, entry] of detachedPanelWindowByTab.entries()) {
    if (Number(entry?.panelWindowId) === windowId) {
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
        }).catch(() => { });
      }
      break;
    }
  }
});

chrome.windows.onBoundsChanged.addListener((window) => {
  const windowId = Number(window?.id);
  if (!Number.isInteger(windowId)) return;

  const match = findDetachedEntryByWindowId(windowId);
  if (!match) return;

  const { tabId, entry, role } = match;
  if (isDetachedSyncLocked(entry)) return;

  if (role === "host") {
    syncDetachedPairFromHost(tabId).catch(() => { });
    return;
  }
  syncDetachedPairFromPanel(tabId).catch(() => { });
});
