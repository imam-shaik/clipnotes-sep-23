// sidepanel/panel.js

let currentVideoId = null;
let currentVideoTitle = null;
let currentTabId = null;
const initialPanelUrlParams = new URLSearchParams(window.location.search);
const launchedForTabId = Number(initialPanelUrlParams.get('tabId'));
const panelMode = initialPanelUrlParams.get('mode') || '';
const launchedForHostWindowId = Number(initialPanelUrlParams.get('hostWindowId'));
const isDetachedPanel = panelMode === 'detached';
if (Number.isInteger(launchedForTabId)) {
    currentTabId = launchedForTabId;
}
let videoScrapeTimer = null;
let isNotebookEnabled = false;
let isDataLoadedForId = null; // Track if we've already loaded state for the current ID
let titleUsedForLoad = null; // Track which title was used for loading (to detect stale titles)
let isVideoPlaying = false; // Track playback status
let lastCaptureTime = 0; // Prevent spamming screenshots too fast
let panelHeartbeatTimer = null;
let disconnectedPollCount = 0;
let state = {
    screenshots: [], // { id, timestampMs, timeFormatted, dataUrl, noteHtml, filename, createdAt }
    toc: [],          // { id, timeFormatted, timestampMs, title }
    intervalMarkers: [], // [{ percentage, color, number }]
    metadata: {
        videoId: null,
        videoTitle: "",
        videoUrl: "",
        channel: "",
        lastTimeMs: 0,
        selectedInterval: "None"
    }
};

const VIDEO_STATE_FILENAME = 'video_notes_state.json';
const HISTORY_INDEX_FILENAME = 'history_index.json';

let isCapturing = false;      // Prevent multiple screenshots at once

// ==========================================
// Initialization
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    startPanelHeartbeat();
    initTheme();
    await initFileSystem();
    initTabs(); // Initialize tab switching
    initButtons();
    initOptInToggle();
    initMessageListeners(); // New: Listen for background/content signals
    pollCurrentVideo();
});

window.addEventListener('beforeunload', () => {
    stopPanelHeartbeat();
});

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

        // Wait before retrying
        await new Promise(r => setTimeout(r, delayMs));
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

    if (isDetachedPanel && Number.isInteger(launchedForTabId) && tab.id === launchedForTabId) {
        return !tab.url || isYouTubeWatchUrl(tab.url);
    }

    if (isDetachedPanel && Number.isInteger(launchedForTabId) && tab.id !== launchedForTabId) {
        return false;
    }

    if (
        isDetachedPanel &&
        Number.isInteger(launchedForHostWindowId) &&
        Number.isInteger(tab.windowId) &&
        tab.windowId !== launchedForHostWindowId
    ) {
        return false;
    }

    return isYouTubeWatchUrl(tab.url);
}

async function getValidatedWatchTab(tabId) {
    if (!Number.isInteger(tabId)) return null;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && isYouTubeWatchUrl(tab.url)) {
            return tab;
        }
    } catch (_) { }
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
        if (Number.isInteger(launchedForTabId) && tab.id === launchedForTabId) score += 300;
        if (Number.isInteger(launchedForHostWindowId) && tab.windowId === launchedForHostWindowId) score += 150;
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

function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Keep tab binding stable in detached mode; avoid drifting to unrelated YouTube tabs.
        if (sender && sender.tab && shouldTrackSenderTab(sender.tab)) {
            currentTabId = sender.tab.id;
        }

        if (message.type === 'CONTENT_READY') {
            console.log("Sidepanel: Content Script signaled READY for", message.videoId);
            // If it's a NEW video, trigger a video switch immediately
            if (message.videoId && currentVideoId !== message.videoId) {
                console.log("Sidepanel: CONTENT_READY triggered video switch:", currentVideoId, "->", message.videoId);
                currentVideoId = message.videoId;
                currentVideoTitle = null;
                isDataLoadedForId = null;
                clearVideoStateUI();
            }
            // Always check metadata for the current video
            checkMetadataImmediate();
        } else if (message.action === 'shortcutPressed') {
            console.log("Sidepanel: Shortcut detected:", message.key);
            if (message.key === 's') {
                handleCapture();
            } else if (message.key === 'z') {
                openLastScreenshotNote();
            } else if (message.key === 't') {
                handleAddTOC();
            } else if (message.key === 'a') {
                handleAreaCapture();
            }
        } else if (message.action === 'screenshotEdited') {
            console.log("Sidepanel: Screenshot edited result received for", message.shotId);
            handleScreenshotEditedResult(message.shotId, message.dataUrl);
            if (sendResponse) sendResponse({ success: true });
        }
    });
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
            const folderHandle = await FileSystemModule.getVideoFolderHandle(
                state.metadata.videoTitle || "Untitled",
                true,
                currentVideoId
            );
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
    chrome.tabs.sendMessage(tabId, { action: 'getMetadata' }, async (response) => {
        if (chrome.runtime.lastError || !response) return;
        if (response.videoId === currentVideoId) {
            handleMetadataResponse(response);
        }
    });
}

function handleMetadataResponse(response) {
    if (!response || !response.videoId) return;

    // Better generic check: skip if it's literally just "YouTube" or "YouTube Video"
    const isGeneric = !response.title ||
        response.title === "YouTube" ||
        response.title === "YouTube Video" ||
        response.title === "";

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
    if (isDataLoadedForId !== response.videoId && !isGeneric) {
        console.log("Sidepanel: Real metadata detected, loading state for", response.videoId, "Title:", response.title);

        // Update global tracking state fully
        currentVideoId = response.videoId;
        currentVideoTitle = response.title;
        state.metadata.videoId = response.videoId;
        state.metadata.videoTitle = response.title;
        state.metadata.videoUrl = response.url;
        state.metadata.channel = response.channel;

        isDataLoadedForId = response.videoId;
        titleUsedForLoad = response.title;
        loadVideoState(response.videoId, response.title);
    } else if (isDataLoadedForId === response.videoId && !isGeneric && titleUsedForLoad && titleUsedForLoad !== response.title) {
        // Title changed after initial load (e.g., stale SPA title -> real title)
        // Re-load with the correct title to get the right folder
        console.log("Sidepanel: Title changed after load, re-loading:", titleUsedForLoad, "->", response.title);
        currentVideoTitle = response.title;
        state.metadata.videoTitle = response.title;
        titleUsedForLoad = response.title;
        clearVideoStateUI();
        isDataLoadedForId = response.videoId; // Keep it set
        loadVideoState(response.videoId, response.title);
    } else if (isDataLoadedForId === response.videoId && state.screenshots.length > 0 && !isNotebookEnabled) {
        setNotebookToggleState(true);
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

            const normalizedChoices = choices.map((choice) => {
                if (choice && typeof choice === 'object') {
                    const value = choice.value ?? choice.label ?? "";
                    const label = choice.label ?? String(value || "");
                    return {
                        value: String(value),
                        label: String(label),
                        icon: choice.icon ? String(choice.icon) : ""
                    };
                }
                const val = String(choice ?? "");
                return { value: val, label: val, icon: "" };
            });

            normalizedChoices.forEach(choice => {
                const btn = document.createElement('button');
                btn.className = 'choice-btn';
                const iconHtml = choice.icon ? `<span class="choice-icon">${choice.icon}</span>` : '';
                btn.innerHTML = `${iconHtml}<span class="choice-label">${choice.label}</span>`;
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

async function resolveActiveYouTubeTabId() {
    if (isDetachedPanel && Number.isInteger(launchedForTabId)) {
        const lockedTab = await getValidatedWatchTab(launchedForTabId);
        if (lockedTab) {
            currentTabId = lockedTab.id;
            return currentTabId;
        }
    }

    if (Number.isInteger(currentTabId)) {
        const trackedTab = await getValidatedWatchTab(currentTabId);
        if (trackedTab) {
            return trackedTab.id;
        }
        currentTabId = null;
    }

    try {
        if (isDetachedPanel && Number.isInteger(launchedForHostWindowId)) {
            const [tabInHostWindow] = await chrome.tabs.query({ active: true, windowId: launchedForHostWindowId });
            if (tabInHostWindow && isYouTubeWatchUrl(tabInHostWindow.url)) {
                currentTabId = tabInHostWindow.id;
                return currentTabId;
            }
        }

        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab && isYouTubeWatchUrl(tab.url)) {
            currentTabId = tab.id;
            return currentTabId;
        }
    } catch (_) { }

    if (isDetachedPanel && Number.isInteger(launchedForHostWindowId)) {
        try {
            const hostTabs = await chrome.tabs.query({
                windowId: launchedForHostWindowId,
                url: ['*://*.youtube.com/watch*', '*://youtube.com/watch*']
            });
            const fallback = hostTabs.find(tab => isYouTubeWatchUrl(tab?.url));
            if (fallback) {
                currentTabId = fallback.id;
                return currentTabId;
            }
        } catch (_) { }
    }

    try {
        const allWatchTabs = await chrome.tabs.query({
            url: ['*://*.youtube.com/watch*', '*://youtube.com/watch*']
        });
        const best = pickBestYouTubeWatchTab(allWatchTabs);
        if (best && Number.isInteger(best.id)) {
            currentTabId = best.id;
            return currentTabId;
        }
    } catch (_) { }

    return null;
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
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return;
    chrome.runtime.sendMessage({ action: 'panelHeartbeat', tabId }, () => {
        if (chrome.runtime.lastError) {
            // Ignore background reload races.
        }
    });
}

async function sendPanelClosed() {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) return;
    chrome.runtime.sendMessage({ action: 'panelClosed', tabId }, () => {
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

function stopPanelHeartbeat() {
    if (panelHeartbeatTimer) {
        clearInterval(panelHeartbeatTimer);
        panelHeartbeatTimer = null;
    }
    sendPanelClosed();
}

async function handleCloseSidePanel() {
    const tabId = await resolveActiveYouTubeTabId();
    stopPanelHeartbeat();

    chrome.runtime.sendMessage({ action: 'closeSidePanel', tabId }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
            // Fallback if browser refuses close API in this context.
            window.close();
        }
    });
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

function showFolderPermissionBannerIfNeeded() {
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
        }
    });

    const fsState = await FileSystemModule.setup();
    if (fsState === false) {
        banner.classList.add('show');
    } else if (fsState === 'needs_permission') {
        showFolderPermissionBanner();
    }
}

// ==========================================
// Tabs & UI
// ==========================================
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active classes
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            // Add to targeted
            const targetId = e.target.getAttribute('data-tab');
            e.target.classList.add('active');
            document.getElementById(targetId).classList.add('active');

            if (targetId === 'tab-history') {
                refreshHistory();
            } else if (targetId === 'tab-transcript') {
                refreshTranscript();
            }
        });
    });
}

function initButtons() {
    // Primary Actions
    const btnCaptureFull = document.getElementById('btn-capture-full');
    const btnAddTOC = document.getElementById('btn-add-toc');
    const btnExportPDF = document.getElementById('btn-export-pdf');
    const btnPreviewPDF = document.getElementById('btn-preview-pdf');
    const btnClosePreview = document.getElementById('btn-close-preview');
    const btnClosePanel = document.getElementById('btn-close-panel');
    const btnCopyTranscript = document.getElementById('btn-copy-transcript');

    // Secondary Actions
    const btnCaptureArea = document.getElementById('btn-capture-area');
    const btnAutoScreenshot = document.getElementById('btn-auto-screenshot');
    const btnDurationCalc = document.getElementById('btn-duration-calc');
    const btnCreateBoard = document.getElementById('btn-create-board');
    const btnAddImg = document.getElementById('btn-add-image');

    // Listeners
    if (btnCaptureFull) btnCaptureFull.addEventListener('click', handleCapture);
    if (btnAddTOC) btnAddTOC.addEventListener('click', handleAddTOC);
    if (btnExportPDF) btnExportPDF.addEventListener('click', handleExportPDF);
    if (btnPreviewPDF) btnPreviewPDF.addEventListener('click', handlePreviewPDF);
    if (btnClosePreview) btnClosePreview.addEventListener('click', closePdfPreviewModal);
    if (btnClosePanel) btnClosePanel.addEventListener('click', handleCloseSidePanel);

    const previewOverlay = document.getElementById('pdf-preview-overlay');
    if (previewOverlay) {
        previewOverlay.addEventListener('click', (e) => {
            if (e.target === previewOverlay) {
                closePdfPreviewModal();
            }
        });
    }
    if (btnCopyTranscript) btnCopyTranscript.addEventListener('click', copyTranscriptToClipboard);

    if (btnCaptureArea) btnCaptureArea.addEventListener('click', handleAreaCapture);
    if (btnAutoScreenshot) btnAutoScreenshot.addEventListener('click', handleAutoScreenshotToggle);
    if (btnDurationCalc) btnDurationCalc.addEventListener('click', handleDurationCalculator);
    if (btnCreateBoard) btnCreateBoard.addEventListener('click', handleCreateBoard);
    if (document.getElementById('btn-set-interval')) {
        document.getElementById('btn-set-interval').addEventListener('click', handleSetInterval);
    }

    if (btnAddImg) btnAddImg.addEventListener('click', () => document.getElementById('input-add-image').click());

    const inputAddImg = document.getElementById('input-add-image');
    if (inputAddImg) inputAddImg.addEventListener('change', handleAddLocalImage);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
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
        }
    });
}

function openLastScreenshotNote() {
    if (state.screenshots.length === 0) return;

    // Sort screenshots by creation time to ensure we get the "last" one taken
    const shots = [...state.screenshots].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lastShot = shots[shots.length - 1];

    const card = document.getElementById(lastShot.id);
    if (card) {
        const noteContainer = card.querySelector('.note-container');
        const notesBtn = card.querySelector('.notes-toggle-btn');
        const editor = card.querySelector('.note-editor');

        if (!noteContainer.classList.contains('visible')) {
            notesBtn.click(); // This opens and focuses
        } else {
            editor.focus();
        }

        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ---------------------------------------------------------
// Secondary Action Handlers (WIP)
// ---------------------------------------------------------
async function handleAreaCapture() {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId) || isCapturing) return;

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

        if (!isNotebookEnabled) setNotebookToggleState(true);

        const targetVideoId = currentVideoId;
        const targetVideoTitle = currentVideoTitle;

        if (!targetVideoId || !targetVideoTitle || targetVideoTitle === "Loading...") {
            alert("Wait for the video title to load.");
            resetBtn();
            return;
        }

        if (!FileSystemModule.dirHandle) await FileSystemModule.setup();
        if (!FileSystemModule.dirHandle) {
            alert("Please select a Save Folder first.");
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
                        alert("Area capture failed: " + (response.error || "Unknown error"));
                    }
                    return;
                }

                const finalImageData = response.imageData;
                const finalTimeMs = response.currentTimeMs;
                const blob = dataURLtoBlob(finalImageData);
                const timeF = formatTime(finalTimeMs);
                const safeTimeStr = timeF.replace(/:/g, '-');
                const fileUnique = Date.now().toString().slice(-4);
                const filename = `AreaShot_${safeTimeStr}_${fileUnique}.png`;

                const subFolder = await FileSystemModule.getVideoFolderHandle(targetVideoTitle, true, targetVideoId);
                if (subFolder) {
                    const saved = await FileSystemModule.saveFile(filename, blob, subFolder);
                    if (saved && targetVideoId === currentVideoId) {
                        addScreenshotToUI(finalImageData, timeF, finalTimeMs, filename);
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

let autoScreenshotInterval = null;
function handleAutoScreenshotToggle(e) {
    const btn = e.currentTarget;
    if (autoScreenshotInterval) {
        clearInterval(autoScreenshotInterval);
        autoScreenshotInterval = null;
        btn.classList.remove('primary');
        btn.title = "Toggle Auto Screenshot";
        console.log("Auto Screenshot STOPPED.");
    } else {
        // We use an IIFE to handle the async prompt without making the click handler itself async, 
        // which could cause rapid double-click race conditions.
        (async () => {
            const intervalSecs = await showPrompt("Enter Auto-Screenshot interval in seconds (will only capture while video is PLAYING):", "10");
            if (intervalSecs && !isNaN(intervalSecs)) {
                const ms = parseInt(intervalSecs) * 1000;
                autoScreenshotInterval = setInterval(() => {
                    if (isVideoPlaying) {
                        console.log("Auto-capturing because video is playing...");
                        handleCapture();
                    } else {
                        console.log("Auto-capture skipped: Video is paused/off.");
                    }
                }, ms);
                btn.classList.add('primary');
                btn.title = "Auto Screenshot ON (Click to Stop)";
                console.log(`Auto Screenshot ENABLED every ${intervalSecs} seconds.`);
            }
        })();
    }
}

async function handleDurationCalculator() {
    await openDurationCalculator();
}

function syncNotebookStateToContent(isOn) {
    const enabled = !!isOn;

    try {
        chrome.storage.local.set({ ynNotebookEnabled: enabled });
    } catch (err) {
        console.warn("Failed to sync notebook state to extension storage:", err);
    }

    resolveActiveYouTubeTabId().then((tabId) => {
        if (!Number.isInteger(tabId)) return;
        chrome.tabs.sendMessage(tabId, { action: 'setNotebookEnabled', enabled }, () => {
            if (chrome.runtime.lastError) {
                // Content script may not be injected yet; storage sync covers late injection.
            }
        });
    });
}

function initOptInToggle() {
    const toggle = document.getElementById('toggle-notebook');

    // Load initial state from localStorage
    const savedState = localStorage.getItem('ynNotebookEnabled');
    if (savedState === 'true') {
        setNotebookToggleState(true);
    } else if (savedState === 'false') {
        setNotebookToggleState(false);
    } else {
        // DEFAULT: OFF for new users, but once they turn it ON, it sticks.
        setNotebookToggleState(false);
    }

    toggle.addEventListener('change', (e) => {
        setNotebookToggleState(!!e.target.checked);
        if (isNotebookEnabled && currentVideoId && FileSystemModule.dirHandle) {
            // If they just turned it on, auto-save state to create the folder immediately
            saveVideoState(currentVideoId);
        }
    });
}

// ==========================================
// Video Integration Polling
// ==========================================
async function pollCurrentVideo() {
    // Repeatedly check the active tab for a youtube video to connect to
    setInterval(async () => {
        const tab = await resolveTrackedYouTubeTab();
        if (tab && isYouTubeWatchUrl(tab.url)) {
            disconnectedPollCount = 0;
            currentTabId = tab.id;
            // PRE-CHECK: Detect video change from URL instantly
            try {
                const urlObj = new URL(tab.url);
                const urlParams = new URLSearchParams(urlObj.search);
                const urlVideoId = urlParams.get('v');

                if (urlVideoId && currentVideoId !== urlVideoId) {
                    console.log("Sidepanel: Instant URL-based navigation detected:", urlVideoId);
                    currentVideoId = urlVideoId;
                    currentVideoTitle = null; // Reset title to require fresh load
                    isDataLoadedForId = null; // Reset load tracker
                    clearVideoStateUI();
                }
            } catch (urlErr) { console.warn("Invalid URL in poll check:", tab.url); }

            // Using the retry wrapper here prevents errors when content script is still injecting
            const metaResponse = await sendMessageWithRetry(currentTabId, { action: 'getMetadata' }, 1, 0); // Quick check
            if (metaResponse && metaResponse.videoId === currentVideoId) {
                handleMetadataResponse(metaResponse);
            }

            const stateResponse = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 1, 0); // Quick check
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
    }, 1000);
}

function updateTimeline(vidState) {
    if (!vidState) return;
    const currentStr = formatTime(vidState.currentTimeMs);
    const durStr = formatTime(vidState.durationMs);

    document.getElementById('time-display').textContent = `${currentStr} / ${durStr}`;

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
    document.getElementById('progress-percentage').textContent = `${Math.round(pct)}%`;
}

// ==========================================
// Action: Screenshot Capture
// ==========================================
async function handleCapture() {
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId) || isCapturing) return;

    const btn = document.getElementById('btn-capture-full');
    const originalText = btn.innerHTML;

    const resetBtn = () => {
        isCapturing = false;
        btn.innerHTML = originalText;
        btn.disabled = false;
    };

    try {
        isCapturing = true;
        btn.innerHTML = `<span>ðŸ“¸ Capturing...</span>`;
        btn.disabled = true;

        // AUTO-OPT-IN: If they click capture but toggle is OFF, just turn it ON
        if (!isNotebookEnabled) {
            console.log("Sidepanel: Auto-enabling notebook for capture");
            setNotebookToggleState(true);
        }

        // LOCK: Capture the current target video ID and title locally
        // This ensures that even if the user navigates while the capture is processing, 
        // the data goes to the correct (old) folder.
        const targetVideoId = currentVideoId;
        const targetVideoTitle = currentVideoTitle;

        if (!targetVideoId || !targetVideoTitle || targetVideoTitle === "Loading...") {
            alert("Please wait a moment for the YouTube video title to load.\n\nIf it takes too long, try refreshing the YouTube page.");
            resetBtn();
            return;
        }

        if (!FileSystemModule.dirHandle) {
            console.log("Sidepanel: No dirHandle in memory, attempting setup recovery...");
            await FileSystemModule.setup();
        }

        if (!FileSystemModule.dirHandle) {
            alert("Please select a Save Folder (top right icon) before taking screenshots so they can save directly to Windows!");
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

        const response = await sendMessageWithRetry(tabId, { action: 'captureScreenshot' }, 5, 500);
        try {
            let finalImageData = null;
            let finalTimeMs = 0;

            // If content script failed (usually due to YouTube cross-origin canvas taint)
            if (!response || !response.success) {
                console.warn("Canvas capture failed or no response, falling back to chrome.tabs.captureVisibleTab", response?.error);

                // Fallback: Capture the entire visible tab via Chrome API
                try {
                    finalImageData = await chrome.tabs.captureVisibleTab(null, { format: 'png', quality: 100 });
                    console.log("Sidepanel: Capture successful via fallback (captureVisibleTab)");

                    // We still need the timestamp, so ask the content script just for the state
                    const stateResp = await new Promise(res => chrome.tabs.sendMessage(tabId, { action: 'getState' }, res));
                    finalTimeMs = stateResp ? stateResp.currentTimeMs : 0;

                } catch (fallbackErr) {
                    console.error("Sidepanel: Both capture methods failed", fallbackErr);
                    alert("Both native and fallback capture methods failed.");
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

            const blob = dataURLtoBlob(finalImageData);
            const timeF = formatTime(finalTimeMs);
            const safeTimeStr = timeF.replace(/:/g, '-');
            const fileUnique = Date.now().toString().slice(-4);
            const filename = `Screenshot_${safeTimeStr}_${fileUnique}.png`;

            // Save DIRECTLY to local windows sub-folder using the LOCKED target title
            const subFolder = await FileSystemModule.getVideoFolderHandle(targetVideoTitle, true, targetVideoId);

            if (!subFolder) {
                if (!showFolderPermissionBannerIfNeeded()) {
                    alert("Could not create or access a sub-folder for this video. Please check your folder permissions.");
                }
                return; // Exit inner try, finally will run
            }

            const saved = await FileSystemModule.saveFile(filename, blob, subFolder);

            if (saved) {
                console.log("Saved directly to Windows sub-folder:", filename);
                // Only add to UI if we successfully saved to Disk (source of truth)
                addScreenshotToUI(finalImageData, timeF, finalTimeMs, filename);
            } else {
                showFolderPermissionBannerIfNeeded();
            }

        } catch (innerErr) {
            console.error("Capture Logic Error:", innerErr);
            alert("An error occurred while saving the screenshot.");
        } finally {
            resetBtn();
        }
    } catch (err) {
        console.error("Capture Error:", err);
        alert("An error occurred starting the capture process.");
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
            alert("Please select a Save Folder (top right icon) first!");
            inputElement.value = '';
            return;
        }

        const targetVideoId = currentVideoId;
        const targetVideoTitle = currentVideoTitle;

        if (!targetVideoId || !targetVideoTitle) {
            alert("Please wait for the video to load before adding images.");
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
                alert("Could not access video folder.");
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
            } catch (tErr) { }

            const timeF = formatTime(currentTimeMs);

            // 5. Add to UI
            addScreenshotToUI(dataUrl, timeF, currentTimeMs, filename, "<i>External image.</i>");

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
        alert("Failed to add image: " + err.message);
    } finally {
        inputElement.value = '';
    }
}


function dataURLtoBlob(dataurl) {
    let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

// ==========================================
// Gallery Rendering (Interleaved)
// ==========================================
function renderMainGallery() {
    const list = document.getElementById('screenshots-list');
    if (!list) return;

    list.innerHTML = '';

    // Combine screenshots (ORIGINAL references) with TOC entries
    // We sort combined items by timestampMs for a logical interleaved timeline,
    // BUT the user asked for new screenshots to appear at the bottom "after 7 screenshot".
    // To satisfy both:
    // 1. Screenshots themselves should likely be sorted by capture order (createdAt) if that's what user prefers.
    // 2. Or we keep timestampMs but the user's specific complaint is about them adding "at top".
    // If they add at top, it means current sort is ascending and new one is earlier?
    // Actually, if I take a shot at 10:00 and then 05:00, 05:00 goes to top. User wants it at bottom.
    // So we sort screenshots by createdAt.

    const sortedShots = [...state.screenshots].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const sortedToc = sortTOCByCreated(state.toc);

    const items = [
        ...sortedShots.map(s => ({ ref: s, type: 'screenshot', sortVal: s.createdAt || 0 })),
        // IMPORTANT: Use createdAt here (same unit as screenshots) to prevent TOC jumping to top.
        ...sortedToc.map(t => ({ ref: t, type: 'toc', sortVal: t.createdAt || 0 }))
    ];

    // If we interleave them, we need a common sort value. 
    // If we want "Order Taken", we use createdAt for shots. 
    // But TOC doesn't have createdAt usually. 
    // Let's stick to simple: Screenshots by capture order, TOC interleaved.
    // Actually, user just said "newly taking that screenshot that are adding at top and not after 7 screenshot".
    // This strongly implies capture order.

    // Sort all by capture order if possible, fallback to timestampMs
    items.sort((a, b) => a.sortVal - b.sortVal);

    if (items.length === 0) {
        const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
        list.innerHTML = `<div class="empty-state">${svgIcon}<p>No screenshots or markers yet.</p></div>`;
        return;
    }

    let shotCounter = 1;
    items.forEach(item => {
        if (item.type === 'screenshot') {
            const card = createScreenshotCard(item.ref, shotCounter++);
            list.appendChild(card);
        } else {
            const tocElement = createTOCGalleryElement(item.ref);
            list.appendChild(tocElement);
        }
    });
}

function createTOCGalleryElement(entry) {
    const level = normalizeTOCLevel(entry.level);
    const item = document.createElement('div');
    item.className = `toc-gallery-item toc-gallery-${level.toLowerCase()}`;
    item.id = entry.id;
    item.innerHTML = `
        <div class="toc-indicator"></div>
        <div class="toc-content">
            <div class="toc-header">
                <span class="toc-level-chip">${level}</span>
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
                    <button class="toc-action-btn toc-delete-btn" title="Delete Marker">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="toc-title" contenteditable="true">${entry.title}</div>
        </div>
    `;

    item.querySelector('.toc-time-btn').addEventListener('click', () => {
        seekActiveYouTubeTab(entry.timestampMs);
    });

    const titleEdit = item.querySelector('.toc-title');
    titleEdit.addEventListener('input', () => {
        entry.title = titleEdit.innerText;
        saveVideoState(currentVideoId);
        renderTOCList();
    });

    item.querySelector('.toc-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        titleEdit.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEdit);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });

    item.querySelector('.toc-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm("Delete this marker?")) {
            state.toc = state.toc.filter(t => t.id !== entry.id);
            renderMainGallery();
            renderTOCList();
            saveVideoState(currentVideoId);
        }
    });

    return item;
}

function createScreenshotCard(shot, index) {
    const noteHtml = getScreenshotNoteHtml(shot);
    if (shot.noteHtml !== noteHtml) {
        shot.noteHtml = noteHtml;
    }
    const hasNote = noteHtml && noteHtml.trim().replace(/<[^>]*>/g, '').trim().length > 0;
    const card = document.createElement('div');
    card.className = 'screenshot-card';
    card.id = shot.id;
    card.innerHTML = `
        <div class="card-img-container">
            <img src="${shot.dataUrl}" class="card-img" alt="Screenshot at ${shot.timeFormatted}" />
        </div>
        <div class="card-controls-bar">
            <div class="card-info">
                <span class="card-time">&#9201; ${shot.timeFormatted}</span>
                <span class="card-divider">|</span>
                <span class="card-index">#${index}</span>
            </div>
            <div class="card-actions">
                <button class="card-action-btn notes-toggle-btn ${hasNote ? 'active' : ''}" title="Toggle Notes (ðŸ“)">&#128221;</button>
                <button class="card-action-btn expand-btn" title="View in Full Editor (â¤¢)">&#10562;</button>
                <button class="card-action-btn edit-btn" title="Edit Screenshot (âœï¸)">&#9998;</button>
                <button class="card-action-btn toc-add-btn" title="Open TOC Dialog for this screenshot">&#128209;</button>
                <button class="card-action-btn seek-btn" title="Seek to Timestamp">&#9654;</button>
                <button class="card-action-btn open-btn" title="Download Image (â¬‡ï¸)">&#11118;</button>
                <button class="card-action-btn delete-btn" title="Delete Screenshot (ðŸ—‘ï¸)">&#128465;</button>
            </div>
        </div>
        <div class="note-container ${hasNote ? 'visible' : ''}">
            <div class="note-toolbar">
                <button class="toolbar-btn" data-cmd="bold" title="Bold"><strong>B</strong></button>
                <button class="toolbar-btn" data-cmd="italic" title="Italic"><em>I</em></button>
                <button class="toolbar-btn" data-cmd="underline" title="Underline"><u>U</u></button>
                <button class="toolbar-btn" data-cmd="backColor" data-val="#FFFF00" title="Highlight">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#FFFF00" stroke="#888" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
                </button>
                <button class="toolbar-btn" data-cmd="removeFormat" title="Clear Formatting">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="20" y2="20"/><path d="M8.5 14.5L4 19l1.5-4.5"/><path d="M12 3L5.5 17.5"/><path d="M12 3l6.5 14.5"/><path d="M19 9H9"/></svg>
                </button>
                <button class="toolbar-btn list-style-btn" data-marker="&#10145;" title="Arrow List">&#10145;</button>
                <button class="toolbar-btn list-style-btn" data-marker="&#9989;" title="Check List">&#9989;</button>
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
    card.querySelectorAll('.toolbar-btn:not(.list-style-btn)').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const cmd = btn.getAttribute('data-cmd');
            const val = btn.getAttribute('data-val');
            document.execCommand(cmd, false, val || null);
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
        const details = await collectTOCEntryDetails(`Marker @ ${shot.timeFormatted || '00:00'}`, 'H2');
        if (!details) return;

        if (targetId === currentVideoId) {
            addTOCToUI(details.title, shot.timeFormatted || formatTime(shot.timestampMs || 0), shot.timestampMs || 0, null, details.level);
            document.querySelector('.tab-btn[data-tab="tab-toc"]').click();
        } else {
            const pendingEntry = normalizeTOCRecord({
                id: `toc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                timeFormatted: shot.timeFormatted || formatTime(shot.timestampMs || 0),
                timestampMs: shot.timestampMs || 0,
                title: details.title,
                level: details.level,
                createdAt: Date.now()
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
        // Update the ORIGINAL state entry directly via the reference
        shot.noteHtml = editor.innerHTML;

        // SAFETY NET: Also update by ID in case the reference got detached
        const stateEntry = state.screenshots.find(s => s.id === shot.id);
        if (stateEntry && stateEntry !== shot) {
            stateEntry.noteHtml = editor.innerHTML;
        }

        // Debounce save: wait 500ms after last keystroke before saving to disk
        clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(() => {
            saveVideoState(currentVideoId);
        }, 500);
    });

    editor.addEventListener('paste', (event) => {
        handleNoteEditorPaste(event, editor, shot);
    });

    return card;
}

// Open the screenshot in the system's default image viewer (Windows Photo Viewer, etc.)
async function openScreenshotInSystemViewer(shotId) {
    const shot = state.screenshots.find(s => s.id === shotId);
    if (!shot || !shot.dataUrl) return;

    try {
        // We use the Downloads API to "open" the file.
        // Chrome downloads it (to memory/temp) and then we call 'open'.
        // This is the only way for an extension to launch a system app for a specific file.
        const blob = await (await fetch(shot.dataUrl)).blob();
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().getTime();
        const filename = `screenshot_${shotId}_${timestamp}.png`;

        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false,
            conflictAction: 'overwrite'
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download failed:", chrome.runtime.lastError);
                return;
            }
            // Once downloaded, open it
            chrome.downloads.open(downloadId);

            // Cleanup the blob URL after a delay
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        });
    } catch (err) {
        console.error("Failed to open system viewer:", err);
    }
}

// â”€â”€ Internal Image Editor (Opens in a New Window) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openScreenshotEditor(shotId) {
    const shot = state.screenshots.find(s => s.id === shotId);
    if (!shot || !shot.dataUrl) return;

    // Prepare state for the editor window
    const editState = {
        id: shot.id,
        dataUrl: shot.dataUrl,
        timeFormatted: shot.timeFormatted
    };

    // Store in chrome.storage.local so the new window can pick it up
    chrome.storage.local.set({ [`edit_state_${shotId}`]: editState }, () => {
        // Calculate center position
        const width = Math.min(window.screen.availWidth - 100, 1200);
        const height = Math.min(window.screen.availHeight - 100, 900);
        const left = (window.screen.availWidth - width) / 2;
        const top = (window.screen.availHeight - height) / 2;

        chrome.windows.create({
            url: chrome.runtime.getURL(`sidepanel/editor.html?shotId=${shotId}&videoId=${currentVideoId}`),
            type: 'popup',
            width: width,
            height: height,
            left: Math.round(left),
            top: Math.round(top),
            focused: true
        });
    });
}

/**
 * Creates a blank whiteboard or blackboard image and launches the editor.
 */
async function handleCreateBoard() {
    if (!currentVideoId) {
        alert("Please connect to a video first.");
        return;
    }

    const choices = [
        { label: 'Whiteboard (Bright)', value: 'white', icon: 'â¬œ' },
        { label: 'Blackboard (Dark)', value: 'black', icon: 'â¬›' }
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

    const dataUrl = canvas.toDataURL('image/png');
    const blob = dataURLtoBlob(dataUrl);

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
    setTimeout(() => openScreenshotEditor(id), 500);
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
function addScreenshotToUI(dataUrl, timeStr, timeMs, filename, initialNoteHtml = "", isRestoring = false, existingId = null, existingCreatedAt = null) {
    const shotId = existingId || `shot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const item = {
        id: shotId,
        timestampMs: timeMs,
        timeFormatted: timeStr,
        filename: filename,
        dataUrl: dataUrl,
        noteHtml: getScreenshotNoteHtml({ noteHtml: initialNoteHtml }),
        createdAt: existingCreatedAt || Date.now()
    };
    state.screenshots.push(item);

    // Sort by creation time (Capture Order) to satisfy "after 7 screenshot" requirement
    state.screenshots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    renderMainGallery();

    if (!isRestoring) {
        setTimeout(() => {
            const card = document.getElementById(shotId);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
        saveVideoState(currentVideoId);
    }
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
    const choices = ['H1', 'H2', 'H3'];
    const picked = await showPrompt("Select TOC level:", normalizeTOCLevel(defaultLevel), choices);
    if (!picked) return null;
    return normalizeTOCLevel(picked);
}

// â”€â”€ Big Note Editor Overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openBigNoteEditor(shotId, inlineEditor) {
    const overlay = document.createElement('div');
    overlay.className = 'big-editor-overlay';
    overlay.innerHTML = `
        <div class="big-editor-dialog">
            <div class="big-editor-header">
                <span>&#9998; Edit Note</span>
                <button class="big-editor-close" title="Close">&#10005;</button>
            </div>
            <div class="big-editor-toolbar">
                <button data-cmd="bold" title="Bold"><strong>B</strong></button>
                <button data-cmd="italic" title="Italic"><em>I</em></button>
                <button data-cmd="underline" title="Underline"><u>U</u></button>
                <button data-cmd="backColor" data-val="#FFFF00" title="Highlight">&#9999;</button>
                <button data-cmd="insertUnorderedList" title="Bullet List">&#8226; List</button>
                <button data-cmd="removeFormat" title="Clear Format">Clear</button>
            </div>
            <div class="big-editor-content" contenteditable="true"></div>
            <div class="big-editor-footer">
                <button class="big-editor-cancel">Cancel</button>
                <button class="big-editor-save">&#10003; Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const bigEditor = overlay.querySelector('.big-editor-content');
    bigEditor.innerHTML = inlineEditor.innerHTML;

    overlay.querySelectorAll('.big-editor-toolbar button').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const cmd = btn.getAttribute('data-cmd');
            const val = btn.getAttribute('data-val');
            document.execCommand(cmd, false, val || null);
            bigEditor.focus();
        });
    });

    bigEditor.focus();

    overlay.querySelector('.big-editor-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.big-editor-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.big-editor-save').addEventListener('click', () => {
        inlineEditor.innerHTML = bigEditor.innerHTML;
        inlineEditor.dispatchEvent(new Event('input', { bubbles: true }));
        // Ensure note container is visible
        const noteContainer = inlineEditor.closest('.note-container');
        if (noteContainer) noteContainer.classList.add('visible');
        const notesBtn = inlineEditor.closest('.screenshot-card')?.querySelector('.notes-toggle-btn');
        if (notesBtn) notesBtn.classList.add('active');
        overlay.remove();
    });

    // Close on overlay click
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}


async function deleteScreenshot(shotId) {
    if (!confirm("Are you sure you want to delete this screenshot and its nodes?")) return;

    const idx = state.screenshots.findIndex(s => s.id === shotId);
    if (idx !== -1) {
        state.screenshots.splice(idx, 1);
        const cardEl = document.getElementById(shotId);
        if (cardEl) cardEl.remove();

        // If list is empty, restore empty state
        if (state.screenshots.length === 0) {
            const list = document.getElementById('screenshots-list');
            const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
            list.innerHTML = `<div class="empty-state">${svgIcon}<p>No screenshots taken yet.</p></div>`;
        } else {
            // Re-index remaining screenshots in chronological order
            const cards = Array.from(document.querySelectorAll('.screenshot-card'));
            cards.forEach((card, i) => {
                const indexSpan = card.querySelector('.meta-index');
                if (indexSpan) indexSpan.textContent = `#${i + 1}`;
            });
        }

        await saveVideoState(currentVideoId);
    }
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
        showFolderPermissionBannerIfNeeded();
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
    await writeHistoryIndexEntries(entries);
}

async function removeHistoryIndexEntry(folderName, videoId = null) {
    if (!FileSystemModule.dirHandle || !folderName) return;
    const entries = await readHistoryIndexEntries();
    const filtered = entries.filter(entry => {
        if (videoId && entry.videoId === videoId) return false;
        return entry.folderName !== folderName;
    });
    await writeHistoryIndexEntries(filtered);
}

async function scanFoldersForHistoryEntries() {
    const folders = await FileSystemModule.listSubFolders();
    const entries = [];
    for (const folder of folders) {
        try {
            const stateFile = await folder.getFileHandle(VIDEO_STATE_FILENAME);
            const file = await stateFile.getFile();
            const text = await file.text();
            const vState = JSON.parse(text);
            entries.push(buildHistoryEntryFromState(vState, folder.name));
        } catch (_) {
            // Ignore folders without a valid state file.
        }
    }
    return sortHistoryEntries(entries);
}

function renderHistoryEntry(list, entry) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const title = entry.videoTitle || entry.folderName || "Unknown Video";
    const url = entry.videoUrl || "#";

    item.innerHTML = `
        <div class="history-header">
            <div class="history-title">${title}</div>
            <button class="history-delete-btn" title="Delete all data for this video">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </div>
        <div class="history-meta">
            <div class="history-stats">
                <span class="stat-tag">${entry.shotCount || 0} shots</span>
                <span class="stat-tag">${entry.tocCount || 0} markers</span>
            </div>
            <div class="history-channel">${entry.channel || 'YouTube'}</div>
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
        if (!confirm(`CRITICAL: Delete ALL screenshots and notes for "${title}"?\nThis will remove the local folder: ${entry.folderName}`)) {
            return;
        }

        const success = await FileSystemModule.deleteDirectory(entry.folderName);
        if (!success) {
            alert("Failed to delete folder. Check permissions.");
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
    const list = document.getElementById('history-list');
    list.innerHTML = '<div class="empty-state"><p>Scanning for history...</p></div>';

    if (!FileSystemModule.dirHandle) {
        list.innerHTML = '<div class="empty-state"><p>Select a folder to see history.</p></div>';
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
            list.innerHTML = '<div class="empty-state"><p>No recorded notes found in this folder.</p></div>';
            return;
        }

        list.innerHTML = '';
        for (const entry of entries) {
            renderHistoryEntry(list, entry);
        }

        if (!list.querySelector('.history-item')) {
            list.innerHTML = '<div class="empty-state"><p>No valid history files found.</p></div>';
        }

    } catch (err) {
        console.error("History refresh failed:", err);
        list.innerHTML = '<div class="empty-state"><p>Failed to scan folders.</p></div>';
    }
}
// ==========================================
// Action: Table of Contents
// ==========================================
async function collectTOCEntryDetails(defaultTitle = "Key Moment", defaultLevel = "H2") {
    const titleInput = await showPrompt("Enter marker name:", defaultTitle);
    const cleanedTitle = String(titleInput || "").trim();
    if (!cleanedTitle) return null;

    const level = await promptTOCLevel(defaultLevel);
    if (!level) return null;

    return { title: cleanedTitle, level: normalizeTOCLevel(level) };
}

async function handleAddTOC() {
    if (!currentTabId || !currentVideoId) {
        console.warn("Sidepanel: Cannot add TOC, missing tab or video ID");
        return;
    }

    // AUTO-OPT-IN: If toggle is OFF, turn it ON
    if (!isNotebookEnabled) {
        console.log("Sidepanel: Auto-enabling notebook for TOC entry");
        setNotebookToggleState(true);
    }

    const targetId = currentVideoId;
    const targetTitle = currentVideoTitle;

    // Use retry logic in case they click TOC immediately after URL changes but script hasn't loaded
    const response = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 10, 500);

    if (!response) {
        console.warn("Sidepanel: Failed to get video state for TOC after retries.");
        alert("Could not read current video time yet. Wait a few seconds for the page to fully load, then try TOC again.");
        return;
    }

    const timeMs = response.currentTimeMs;
    const timeStr = formatTime(timeMs);
    const details = await collectTOCEntryDetails("Key Moment", "H2");

    if (details) {
        console.log("Sidepanel: Adding TOC Entry:", details.title, timeStr, details.level);

        // Only add to UI if we're still on the same video
        if (targetId === currentVideoId) {
            addTOCToUI(details.title, timeStr, timeMs, null, details.level);

            // Switch to Timeline tab so user SEES it
            document.querySelector('.tab-btn[data-tab="tab-toc"]').click();
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
    renderMainGallery();
    saveVideoState(currentVideoId);
}

function renderTOCList() {
    const list = document.getElementById('toc-list');
    list.innerHTML = '';

    if (!Array.isArray(state.toc) || state.toc.length === 0) {
        list.innerHTML = `<div class="empty-state"><p>No timeline markers added.</p></div>`;
        return;
    }

    // NOTEUP behavior: timeline list is ordered by video time.
    const timelineOrdered = sortTOCByTimeline(state.toc);
    state.toc = timelineOrdered.map((entry, idx) => normalizeTOCRecord(entry, idx));

    state.toc.forEach(entry => {
        const level = normalizeTOCLevel(entry.level);
        const item = document.createElement('div');
        item.className = `toc-item toc-item-${level.toLowerCase()}`;
        item.innerHTML = `
            <div class="toc-time">${entry.timeFormatted}</div>
            <select class="toc-level" title="TOC Level">
                <option value="H1" ${level === 'H1' ? 'selected' : ''}>H1</option>
                <option value="H2" ${level === 'H2' ? 'selected' : ''}>H2</option>
                <option value="H3" ${level === 'H3' ? 'selected' : ''}>H3</option>
            </select>
            <div class="toc-text" contenteditable="true">${entry.title}</div>
            <button class="toc-delete" title="Delete Entry">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        `;

        // Click on time to seek
        item.querySelector('.toc-time').addEventListener('click', () => {
            seekActiveYouTubeTab(entry.timestampMs);
        });

        const levelSelect = item.querySelector('.toc-level');
        levelSelect.addEventListener('change', () => {
            entry.level = normalizeTOCLevel(levelSelect.value);
            item.className = `toc-item toc-item-${entry.level.toLowerCase()}`;
            saveVideoState();
            renderMainGallery();
        });

        // Edit title inline
        const textEdit = item.querySelector('.toc-text');
        textEdit.addEventListener('input', () => {
            entry.title = textEdit.innerText;
            saveVideoState();
            renderMainGallery();
        });

        // Delete
        item.querySelector('.toc-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            state.toc = state.toc.filter(t => t.id !== entry.id);
            renderTOCList();
            renderMainGallery();
            saveVideoState();
        });

        list.appendChild(item);
    });
}

function clearVideoStateUI() {
    state = {
        screenshots: [],
        toc: [],
        intervalMarkers: [],
        metadata: {
            videoId: currentVideoId,
            videoTitle: currentVideoTitle || "",
            videoUrl: "", // Will be filled by poll Metadata
            channel: "",
            selectedInterval: "None"
        }
    };
    isDataLoadedForId = null; // Reset load tracker
    const timelineMarkers = document.getElementById('timeline-markers');
    if (timelineMarkers) timelineMarkers.innerHTML = '';
    const svgIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
    document.getElementById('screenshots-list').innerHTML = `<div class="empty-state">${svgIcon}<p>No screenshots taken yet.</p></div>`;
    document.getElementById('toc-list').innerHTML = `<div class="empty-state"><p>No timeline markers added.</p></div>`;

    // Clear transcript UI to prevent "ghost" data
    const transcriptList = document.getElementById('transcript-content');
    if (transcriptList) {
        transcriptList.innerHTML = `<div class="empty-state"><p>Click "ðŸ“œ Transcript" to load the text for this video.</p></div>`;
    }

    // setNotebookToggleState(false); // REMOVED: Persistence now global
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

function normalizeInlineStyleForExport(styleText, maxFontPx = 16) {
    const allowedProps = new Set([
        'font-weight',
        'font-style',
        'text-decoration',
        'background-color',
        'text-align',
        'line-height',
        'white-space',
        'font-size'
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
                const clamped = Math.max(12, Math.min(maxFontPx, px));
                output.push(`font-size:${clamped}px`);
            }
            continue;
        }

        if (allowedProps.has(prop)) {
            output.push(`${prop}:${val}`);
        }
    }

    return output.join('; ');
}

function sanitizeHtmlForEditorAndExport(html, options = {}) {
    if (!html) return "";

    const maxFontPx = Number.isFinite(options.maxFontPx) ? options.maxFontPx : 16;
    const keepLinks = !!options.keepLinks;

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild || doc.body;

    root.querySelectorAll('script,style,meta,link,iframe,object,embed').forEach(el => el.remove());

    const allowedTags = new Set([
        'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'P', 'DIV', 'BR', 'UL', 'OL', 'LI', 'SPAN',
        'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
        'PRE', 'CODE', 'BLOCKQUOTE'
    ]);
    const allowedAttrs = new Set(['style', 'href', 'colspan', 'rowspan', 'target', 'rel']);

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
            return candidate;
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

function handleNoteEditorPaste(event, editor, shot) {
    event.preventDefault();
    const clipboard = event.clipboardData || window.clipboardData;
    if (!clipboard) return;

    const html = clipboard.getData('text/html');
    const text = clipboard.getData('text/plain') || "";

    let insertHtml = "";
    if (html && html.trim()) {
        insertHtml = sanitizeHtmlForEditorAndExport(html, { maxFontPx: 16, keepLinks: true });
    }
    if (!insertHtml) {
        insertHtml = plainTextToEditorHtml(text);
    }
    if (!insertHtml) return;

    document.execCommand('insertHTML', false, insertHtml);
    shot.noteHtml = editor.innerHTML;
    const stateEntry = state.screenshots.find(s => s.id === shot.id);
    if (stateEntry && stateEntry !== shot) {
        stateEntry.noteHtml = editor.innerHTML;
    }
    saveVideoState(currentVideoId);
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
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
            let svgUrl = null;
            img.onload = () => {
                ctx.drawImage(img, 0, 0);
                if (svgUrl) URL.revokeObjectURL(svgUrl);
                cleanup();
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => {
                if (svgUrl) URL.revokeObjectURL(svgUrl);
                cleanup();
                resolve(null);
            };
            try {
                const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
                svgUrl = URL.createObjectURL(svgBlob);
                img.src = svgUrl;
            } catch (blobErr) {
                console.error("Failed to build SVG blob for PDF text rendering:", blobErr);
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

    return canvas.toDataURL('image/png');
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
        doc.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', xMm, yMm, widthMm, sliceHeightMm, undefined, compression);

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
        alert("Nothing to export yet!");
        return null;
    }

    if (!window.jspdf && !window.jsPDF) {
        alert("PDF Library not loaded properly.");
        return null;
    }

    const jsPDFBuilder = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
    if (!jsPDFBuilder) {
        alert("Could not initialize JS PDF builder.");
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

    const doc = new jsPDFBuilder({
        orientation: 'p',
        unit: 'mm',
        format: 'a4',
        compress: true
    });

    const title = document.getElementById('video-title').textContent || "YouTube Notes";
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

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2);
    const mmToPx = 96 / 25.4;
    const noteRenderWidthPx = Math.max(560, Math.round(contentWidth * mmToPx));
    const slotGap = 8;
    const firstPageSlotsTop = 40;
    const normalPageSlotsTop = margin;

    const getSlotLayout = (isFirstPage) => {
        const slotsTop = isFirstPage ? firstPageSlotsTop : normalPageSlotsTop;
        const available = pageHeight - margin - slotsTop;
        return {
            slotsTop,
            slotHeight: (available - slotGap) / 2
        };
    };

    const drawMetadataHeader = () => {
        doc.setFillColor(246, 248, 251);
        doc.setDrawColor(221, 227, 235);
        doc.roundedRect(margin, margin, contentWidth, 22, 2, 2, 'FD');

        doc.setFontSize(13);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(23, 50, 74);
        doc.text(title.length > 96 ? `${title.substring(0, 96)}...` : title, margin + 2, margin + 6);

        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(90, 105, 120);
        doc.text(`Generated: ${generatedAt}`, margin + 2, margin + 12);
        doc.text(`Total Screenshots: ${sortedShots.length}`, margin + 2, margin + 16);
        doc.text(`Video Duration: ${totalDuration}`, margin + 62, margin + 16);
        doc.text(`Source: ${state.metadata.videoUrl || "YouTube"}`, margin + 2, margin + 20);
    };

    const drawTOCHeading = (isContinuation = false) => {
        doc.setFontSize(13);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(23, 50, 74);
        doc.text(isContinuation ? "Table of Contents (cont.)" : "Table of Contents", margin, margin + 28);
    };

    const drawTOCSection = () => {
        if (sortedTocEntries.length === 0) return;

        const bottomLimit = pageHeight - margin - 8;
        let y = margin + 34;
        drawTOCHeading(false);

        for (const entry of sortedTocEntries) {
            const level = normalizeTOCLevel(entry.level);
            const indent = level === 'H1' ? 0 : (level === 'H2' ? 6 : 12);
            const lineHeight = level === 'H1' ? 5.2 : (level === 'H2' ? 4.8 : 4.6);

            if (level === 'H1') {
                doc.setFontSize(11.5);
                doc.setFont(undefined, 'bold');
                doc.setTextColor(21, 45, 68);
            } else if (level === 'H2') {
                doc.setFontSize(10.5);
                doc.setFont(undefined, 'bold');
                doc.setTextColor(33, 56, 79);
            } else {
                doc.setFontSize(10);
                doc.setFont(undefined, 'normal');
                doc.setTextColor(53, 72, 90);
            }

            const label = `${entry.timeFormatted}  ${entry.title}`;
            const lines = doc.splitTextToSize(label, contentWidth - indent);
            const required = (lines.length * lineHeight) + 1.4;

            if (y + required > bottomLimit) {
                doc.addPage();
                y = margin + 10;
                drawTOCHeading(true);
                y = margin + 16;
            }

            doc.text(lines, margin + indent, y);
            y += required;
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

        doc.setFontSize(11);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(11, 116, 222);
        doc.text(`Screenshot ${shotIndex} - ${shot.timeFormatted || "00:00"}`, margin, y);
        doc.setFont(undefined, 'normal');
        y += 5;

        if (hasShotImage) {
            try {
                const shotImageMeta = await loadImageFromDataUrl(shot.dataUrl);
                if (!shotImageMeta || !shotImageMeta.width || !shotImageMeta.height) {
                    throw new Error("Could not load screenshot image metadata.");
                }
                const maxHeight = fullPage ? 120 : 112;
                const minHeight = fullPage ? 48 : 34;

                let reserveForNotes = 0;
                if (hasNote) {
                    const estimatedNoteLines = Math.max(1, Math.ceil(noteText.length / 85));
                    reserveForNotes = fullPage
                        ? Math.min(80, 16 + (estimatedNoteLines * 4.2))
                        : Math.min(52, 10 + (estimatedNoteLines * 4.5));
                }

                let availableForImage = regionBottom - y - reserveForNotes;
                if (availableForImage < minHeight) availableForImage = minHeight;

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
                    doc.addImage(shot.dataUrl, 'PNG', imageX, y, imageWidth, imageHeight, undefined, 'FAST');
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

    drawMetadataHeader();
    if (sortedTocEntries.length > 0) {
        report("Rendering table of contents...");
        drawTOCSection();
    }

    if (sortedShots.length > 0) {
        if (sortedTocEntries.length > 0) {
            doc.addPage();
        }

        let layout = getSlotLayout(sortedTocEntries.length === 0);
        let slotIndex = 0;

        for (let i = 0; i < sortedShots.length; i++) {
            const shot = sortedShots[i];
            const noteText = getMeaningfulNoteText(getScreenshotNoteHtml(shot));
            const estimatedLines = Math.ceil(noteText.length / 85);
            const useFullPage = noteText.length > 260 || estimatedLines > 4;

            report(`Rendering screenshot ${i + 1} of ${sortedShots.length}...`);

            if (useFullPage) {
                if (slotIndex !== 0) {
                    doc.addPage();
                    layout = getSlotLayout(false);
                    slotIndex = 0;
                }

                const fullTop = layout.slotsTop;
                const fullBottom = pageHeight - margin;
                await drawShotCard(shot, i + 1, fullTop, fullBottom, { fullPage: true });

                if (i < sortedShots.length - 1) {
                    doc.addPage();
                    layout = getSlotLayout(false);
                    slotIndex = 0;
                }
                continue;
            }

            const slotTop = layout.slotsTop + (slotIndex * (layout.slotHeight + slotGap));
            const slotBottom = slotTop + layout.slotHeight;
            await drawShotCard(shot, i + 1, slotTop, slotBottom, { fullPage: false });

            slotIndex += 1;
            if (slotIndex >= 2 && i < sortedShots.length - 1) {
                doc.addPage();
                layout = getSlotLayout(false);
                slotIndex = 0;
            }
        }
    }

    report("Finalizing pages...");

    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(9);
        doc.setTextColor(146, 155, 165);
        doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
        doc.text("YouTube Notes Export", margin, pageHeight - 6);
    }

    report("Ready to save...");
    return doc;
}

async function handleExportPDF() {
    showExportProgressDialog("Preparing export...");

    try {
        const doc = await generatePDFDoc((message) => {
            updateExportProgressDialog(message || "Exporting PDF...");
        });
        if (!doc) {
            hideExportProgressDialog();
            return;
        }

        updateExportProgressDialog("Opening Save As dialog...");

        const title = document.getElementById('video-title').textContent || "YouTube Notes";
        const pdfBlob = doc.output('blob');
        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
        const filename = `Notes_${safeTitle}_${Date.now().toString().slice(-4)}.pdf`;

        const saved = await FileSystemModule.saveFileAs(filename, pdfBlob);
        if (saved) {
            console.log("PDF saved via Save As dialog.");
        }
    } catch (err) {
        console.error("PDF export failed:", err);
        alert("PDF export failed. Please try again.");
    } finally {
        hideExportProgressDialog();
    }
}

let previewBlobUrl = null;
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
        const estimatedLines = Math.max(1, Math.ceil(noteText.length / 85));
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

            const title = document.createElement('div');
            title.className = 'preview-shot-title';
            title.textContent = `Screenshot ${slot.index} - ${shot.timeFormatted || "00:00"}`;
            shotWrap.appendChild(title);

            if (shot.dataUrl) {
                const img = document.createElement('img');
                img.className = 'preview-shot-image';
                img.src = shot.dataUrl;
                img.alt = `Screenshot ${slot.index}`;
                img.loading = 'lazy';
                shotWrap.appendChild(img);
            }

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

async function handlePreviewPDF() {
    if (state.screenshots.length === 0 && state.toc.length === 0) {
        alert("Nothing to preview yet!");
        return;
    }

    previewPageData = buildPreviewPagePlan();
    previewRenderedPages = new Set();
    renderPreviewPlaceholders(previewPageData);
    openPdfPreviewModal();
    setupPreviewObserver();
}

function closePDFPreview() {
    // This function is now deprecated as we use a new tab, but kept empty for safety
    // if any old listeners still try to call it.
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
        screenshots: Array.isArray(state.screenshots) ? state.screenshots : [],
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

async function saveVideoState(forVideoId = null, forTitle = null) {
    const targetVideoId = forVideoId || currentVideoId || state.metadata?.videoId;
    if (!FileSystemModule.dirHandle || !targetVideoId) return;

    try {
        const videoTitle = forTitle || currentVideoTitle || state.metadata?.videoTitle || "Unknown Video";
        const subFolder = await FileSystemModule.getVideoFolderHandle(videoTitle, true, targetVideoId);
        if (!subFolder) {
            showFolderPermissionBannerIfNeeded();
            return;
        }

        // Try to get current time for resume logic
        let lastTimeMs = 0;
        try {
            const resp = await sendMessageWithRetry(currentTabId, { action: 'getState' }, 1, 0);
            if (resp) lastTimeMs = resp.currentTimeMs;
        } catch (e) { }

        const snapshot = buildStateSnapshot(targetVideoId, videoTitle, lastTimeMs);
        state.metadata = { ...snapshot.metadata };

        const data = JSON.stringify(snapshot, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const saved = await FileSystemModule.saveFile(VIDEO_STATE_FILENAME, blob, subFolder);
        if (!saved) {
            showFolderPermissionBannerIfNeeded();
            return;
        }

        await upsertHistoryIndexEntry(snapshot, subFolder.name);
    } catch (e) {
        console.error("Failed to auto-save state", e);
    }
}

// Helper to format path for display
function getDisplayPath(fullPath) {
    if (!fullPath) return "";
    return fullPath.split('\\').pop().split('/').pop();
}

async function loadVideoState(forVideoId, forTitle) {
    if (!FileSystemModule.dirHandle || !forVideoId || !forTitle) return;

    // Ensure we are still on the same video that we started loading for
    if (forVideoId !== currentVideoId) return;

    // Check if we actually have permission before trying to read (it won't prompt without a gesture)
    const options = { mode: 'readwrite' };
    if ((await FileSystemModule.dirHandle.queryPermission(options)) !== 'granted') {
        FileSystemModule.permissionNeedsUserGesture = true;
        showFolderPermissionBannerIfNeeded();
        return;
    }

    try {
        // Final sanity check before the slow FS operations
        if (forVideoId !== currentVideoId) return;

        // CRITICAL: Use the specifically verified Title "forTitle" instead of reading from DOM
        // Passing forVideoId allows ID-level verification to prevent mismatches
        const subFolder = await FileSystemModule.getVideoFolderHandle(forTitle, false, forVideoId);
        if (!subFolder) {
            // No folder exists yet -> Definitely OFF? NO, global state now.
            // setNotebookToggleState(false); // REMOVED: Persistence now global
            return;
        }

        // FOLDER EXISTS -> This video is opted-in
        // setNotebookToggleState(true); // REMOVED: Persistence now global

        // Final sanity check
        if (forVideoId !== currentVideoId) return;

        const fileHandle = await subFolder.getFileHandle(VIDEO_STATE_FILENAME);
        const file = await fileHandle.getFile();
        const text = await file.text();
        const loadedState = JSON.parse(text);

        // Restore interval setting
        if (loadedState && loadedState.metadata && loadedState.metadata.selectedInterval) {
            state.metadata.selectedInterval = loadedState.metadata.selectedInterval;
        } else {
            state.metadata.selectedInterval = "None";
        }

        // Keep root history index in sync with legacy or manually edited state files.
        try {
            await upsertHistoryIndexEntry(loadedState, subFolder.name);
        } catch (historyErr) {
            console.warn("History index sync failed during load:", historyErr);
        }

        // CRITICAL: Verify the loaded state belongs to the video we want.
        // If the YouTube SPA returned a stale title initially, we might have opened the
        // wrong folder. This prevents us from loading old video screenshots for a new video.
        if (loadedState && loadedState.metadata && loadedState.metadata.videoId && loadedState.metadata.videoId !== forVideoId) {
            console.warn("Sidepanel: State file videoId mismatch! Rejecting stale data.", loadedState.metadata.videoId, "!=", forVideoId);
            return;
        }

        if (loadedState && loadedState.screenshots && loadedState.screenshots.length > 0) {
            // Batch load screenshots into state
            state.screenshots = loadedState.screenshots.map((shot, idx) => normalizeScreenshotRecord(shot, idx));
            // Sort by capture order
            state.screenshots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }

        if (loadedState && loadedState.toc && loadedState.toc.length > 0) {
            console.log("Sidepanel: Restoring", loadedState.toc.length, "TOC entries");
            state.toc = loadedState.toc.map((entry, idx) => normalizeTOCRecord(entry, idx));
            state.toc = sortTOCByCreated(state.toc);
        }

        // Resume video position
        if (loadedState && loadedState.metadata && loadedState.metadata.lastTimeMs > 0) {
            console.log("Sidepanel: Resuming video at", loadedState.metadata.lastTimeMs);
            setTimeout(() => {
                seekActiveYouTubeTab(loadedState.metadata.lastTimeMs);
            }, 1000); // Give content script a moment to stabilize
        }

        // Single render call for everything
        renderMainGallery();
        generateIntervalMarkers();
        renderTOCList();

    } catch (err) {
        console.log("No previous state found to load or error reading file. Fresh slate.");
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

    try {
        localStorage.setItem('ynNotebookEnabled', isNotebookEnabled.toString());
    } catch (err) {
        console.warn("Failed to persist notebook toggle state:", err);
    }

    syncNotebookStateToContent(isNotebookEnabled);
}

// Reset UI specifically to clear data on video change
// (Defined again above, removing this redundant copy)

// ==========================================
// Transcript Feature
// ==========================================
async function refreshTranscript() {
    const list = document.getElementById('transcript-content');
    const tabId = await resolveActiveYouTubeTabId();
    if (!Number.isInteger(tabId)) {
        list.innerHTML = `<div class="empty-state"><p>Please open a YouTube watch page first.</p></div>`;
        return;
    }
    list.innerHTML = `<div class="empty-state"><p>Loading transcript...</p></div>`;

    const attempts = 3;
    const errors = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = await sendMessageWithRetry(tabId, { action: 'getTranscript' }, 2, 250);
        const segments = normalizeTranscriptSegmentsForDisplay(response?.segments);

        if (response?.success && segments.length > 0) {
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
            list.innerHTML = `<div class="empty-state"><p>Retrying transcript (${attempt}/${attempts})...</p></div>`;
            await new Promise(r => setTimeout(r, 650 * attempt));
        }
    }

    const uniqueErrors = Array.from(new Set(errors.filter(Boolean)));
    const errorMsg = uniqueErrors.slice(-2).join(' | ') || "Transcript is unavailable right now.";
    list.innerHTML = `
        <div class="empty-state">
            <p style="color: var(--status-error);">${errorMsg}</p>
            <p style="font-size: 11px; margin-top: 8px; opacity: 0.75;">
                Tip: Keep the video playing for 2-3 seconds after seek/resize, then retry transcript.
            </p>
        </div>`;
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
    const list = document.getElementById('transcript-content');
    list.innerHTML = '';

    const normalizedSegments = normalizeTranscriptSegmentsForDisplay(segments);
    if (!normalizedSegments.length) {
        list.innerHTML = `<div class="empty-state"><p>Transcript is empty.</p></div>`;
        return;
    }

    normalizedSegments.forEach(seg => {
        const item = document.createElement('div');
        item.className = 'transcript-item';
        item.innerHTML = `
            <span class="transcript-time">${seg.time}</span>
            <span class="transcript-text">${seg.text}</span>
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
    const segments = document.querySelectorAll('.transcript-item');
    if (segments.length === 0) return;

    let fullText = "";
    segments.forEach(s => {
        const time = s.querySelector('.transcript-time').textContent;
        const text = s.querySelector('.transcript-text').textContent;
        fullText += `[${time}] ${text}\n`;
    });

    try {
        await navigator.clipboard.writeText(fullText);
        const btn = document.getElementById('btn-copy-transcript');
        const oldText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.background = 'var(--status-success)';
        setTimeout(() => {
            btn.textContent = oldText;
            btn.style.background = '';
        }, 2000);
    } catch (err) {
        console.error("Copy failed", err);
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

// Helper for display path
function getDisplayPath(fullPath) {
    if (!fullPath) return "";
    return fullPath.split('\\').pop().split('/').pop();
}

// ==========================================
// Time Formatter
// ==========================================
function formatTime(ms) {
    if (ms < 0) return "00:00";
    let seconds = Math.floor(ms / 1000);
    let minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    let hours = Math.floor(minutes / 60);
    minutes = minutes % 60;
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

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
        alert("Please open and play a YouTube video first.");
        return;
    }

    const stateResp = await sendMessageWithRetry(tabId, { action: 'getState' }, 3, 500);
    if (!stateResp || !stateResp.durationMs) {
        alert("Could not get video state. Ensure the video is loaded and try again.");
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
        let tbl = `<p class="fw-bold mb-2">ðŸ“… Completion Timeline for ${hoursPerDay}h daily:</p>
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
        let tbl = `<p class="fw-bold mb-2">â° Daily Hours Required to Complete in ${targetDays}d:</p>
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
                alert("Invalid format! Use numbers followed by s, m, or h (e.g., 5m, 1h).");
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
    if (!container) return;

    container.innerHTML = '';
    state.intervalMarkers = [];

    if (!intervalStr || intervalStr === "None") return;

    const intervalSecs = parseInt(intervalStr);
    const durationMs = state.metadata.durationMs || 0;

    // If duration isn't loaded yet, we can't generate markers. 
    // updateTimeline will call this once duration is detected.
    if (durationMs <= 0 || isNaN(intervalSecs)) {
        console.log("Sidepanel: Delaying marker generation (no duration yet)");
        return;
    }

    const intervalMs = intervalSecs * 1000;
    const colors = ["#e74c3c", "#8e44ad", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c", "#e67e22", "#16a085", "#c0392b", "#d35400"];

    let count = 1;
    // Start from the first interval
    for (let time = intervalMs; time < durationMs; time += intervalMs) {
        const percentage = (time / durationMs) * 100;
        const color = colors[(count - 1) % colors.length];

        state.intervalMarkers.push({ percentage, color, number: count });

        const marker = document.createElement('div');
        marker.className = 'timeline-marker';
        marker.style.left = `${percentage}%`;
        marker.style.setProperty('--marker-color', color);

        marker.innerHTML = `
            <div class="flag">
                <span class="flag-text">${count}</span>
            </div>
            <div class="pole"></div>
        `;

        container.appendChild(marker);
        count++;

        if (count > 500) break; // Extended safety limit for long videos
    }

    console.log(`Sidepanel: Generated ${count - 1} interval markers for ${intervalStr}s interval`);
}


