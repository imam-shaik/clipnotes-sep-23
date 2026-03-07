// background/service-worker.js

const panelHeartbeatByTab = new Map();

function isPanelOpenForTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const ts = panelHeartbeatByTab.get(tabId);
  if (!ts) return false;
  return (Date.now() - ts) <= 7000;
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
    chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel/panel.html",
      enabled: true
    });
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => { });
  }
});

// Automatically trigger side panel globally or on icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel/panel.html",
    enabled: true
  });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => { });
});

// Listener to handle messages from content script or panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openSidePanel') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Missing tab id' });
      return false;
    }

    chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel/panel.html",
      enabled: true
    });
    chrome.sidePanel.open({ tabId }).then(() => {
      panelHeartbeatByTab.set(tabId, Date.now());
      sendResponse({ success: true });
    }).catch(() => {
      sendResponse({ success: false });
    });
    return true;
  }

  if (message.action === 'closeSidePanel') {
    const requestedTabId = Number(message.tabId);
    const tabId = Number.isInteger(requestedTabId) ? requestedTabId : sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Missing tab id' });
      return false;
    }

    panelHeartbeatByTab.delete(tabId);

    chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel/panel.html",
      enabled: false
    }).then(() => {
      sendResponse({ success: true });
    }).catch(() => {
      sendResponse({ success: false });
    });
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
});
