(function() {
const TIMEOUT_CONFIG = {
    BRIDGE_DATA_MAX_WAIT: 4000,   // Increased from 3000ms for high-latency systems
    ANIMATION_FEEDBACK: 150,
    PLAYER_POLL_RATE: 500,
    NAV_FALLBACK_POLL: 5000,
    RETRY_DELAY_BASE: 300,
    ENABLE_DEBUG: false
};

function debugLog(...args) {
    if (TIMEOUT_CONFIG.ENABLE_DEBUG) console.log("[DEBUG]", ...args);
}

class YouTubeNotesContent {
    constructor() {
        this.video = null;
        this.videoId = this.extractVideoId();
        this.lastUrl = window.location.href;
        this.activationLauncher = null;
        this.notebookEnabled = false;
        this.isPanelOpen = false;
        this.myTabId = null;
        this.panelStatePollTimer = null;
        this.storageListenerAttached = false;
        this._playerInterval = null;
        this._playerIntervalRate = 500;
        this.setupPlayerObserver();
        this._navInterval = null;
        this._playerInjectionInterval = null;
        this._messageListener = null;
        this._storageChangeListener = null;
        this._miniViewStorageChangeListener = null;
        this._keyboardListener = null;
        this._miniViewDragCleanup = null;
        this._destroyed = false;
        this.setupNavigationObserver();
        this.injectCSS();
        this.removeLegacyActivationPrompt();
        this.setupActivationLauncher();
        this.setupMessageListener();
        this.setupKeyboardShortcuts();
        this.resolveMyTabId().finally(() => this.setupMiniViewListener());
        // console.log("YouTube Notes Extension: Content Script Initialized.");
    }

    resolveMyTabId() {
        if (!chrome?.runtime?.sendMessage) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: 'getMyTabId' }, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                        return;
                    }
                    this.myTabId = Number.isInteger(response?.tabId) ? response.tabId : null;
                    resolve(this.myTabId);
                });
            } catch (_) {
                resolve(null);
            }
        });
    }

    shouldRenderMiniView(cd) {
        if (!cd) return false;
        // Require explicit target tab so other windows never show this overlay.
        if (!Number.isInteger(cd.tabId)) return false;
        if (!Number.isInteger(this.myTabId)) return false;
        return cd.tabId === this.myTabId;
    }

    isRuntimeAvailable() {
        try {
            return !!chrome.runtime?.id;
        } catch (_) {
            return false;
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._navInterval) clearInterval(this._navInterval);
        if (this._playerInjectionInterval) clearInterval(this._playerInjectionInterval);
        if (this._playerInterval) clearTimeout(this._playerInterval);
        if (this.panelStatePollTimer) clearInterval(this.panelStatePollTimer);

        this._navInterval = null;
        this._playerInjectionInterval = null;
        this._playerInterval = null;
        this.panelStatePollTimer = null;

        // Clean up navigation listeners
        if (this._navCleanup) this._navCleanup();

        if (this._keyboardListener) {
            window.removeEventListener('keydown', this._keyboardListener, true);
            this._keyboardListener = null;
        }

        const safelyRemoveListener = (parent, listener) => {
            if (!listener || !parent?.removeListener) return;
            try {
                parent.removeListener(listener);
            } catch (e) {
                // Ignore "Extension context invalidated" errors
            }
        };

        safelyRemoveListener(chrome?.runtime?.onMessage, this._messageListener);
        this._messageListener = null;

        safelyRemoveListener(chrome?.storage?.onChanged, this._storageChangeListener);
        this._storageChangeListener = null;
        this.storageListenerAttached = false;

        safelyRemoveListener(chrome?.storage?.onChanged, this._miniViewStorageChangeListener);
        this._miniViewStorageChangeListener = null;

        if (typeof this._miniViewDragCleanup === 'function') {
            try { this._miniViewDragCleanup(); } catch (e) {
                console.debug('[ContentScript] MiniViewDragCleanup failed:', e);
            }
            this._miniViewDragCleanup = null;
        }

        // Clean up playback event listeners
        if (this._playbackRateListener && this.video) {
            this.video.removeEventListener('ratechange', this._playbackRateListener);
            this._playbackRateListener = null;
        }
        if (this._seekListener && this.video) {
            this.video.removeEventListener('seeked', this._seekListener);
            this._seekListener = null;
        }

        this.removeMiniView();
        this.closeFloatingReport();
        if (this.activationLauncher?.parentNode) {
            this.activationLauncher.remove();
        }
    }

    // Request player + timedtext bridge data from the MAIN-world script.
    getBridgeData() {
        return new Promise((resolve) => {
            let timeout;
            const handler = function (e) {
                clearTimeout(timeout);
                document.removeEventListener('__yt_notes_player_response__', handler);
                try {
                    resolve(e.detail ? JSON.parse(e.detail) : null);
                } catch (err) {
                    resolve(null);
                }
            };
            timeout = setTimeout(() => {
                document.removeEventListener('__yt_notes_player_response__', handler);
                resolve(null);
            }, TIMEOUT_CONFIG.BRIDGE_DATA_MAX_WAIT);
            document.addEventListener('__yt_notes_player_response__', handler, { once: true });
            document.dispatchEvent(new Event('__yt_notes_get_player_response__'));
        });
    }

    // Event-driven check for URL changes (SPA Navigation)
    setupNavigationObserver() {
        if (this._navCleanup) this._navCleanup();
        
        const handleNav = () => {
            if (!this.isRuntimeAvailable()) return;
            const currentUrl = window.location.href;
            if (this.lastUrl !== currentUrl) {
                const oldUrl = this.lastUrl;
                this.lastUrl = currentUrl;
                this.onPageTransition(oldUrl, currentUrl);
            }
        };

        window.addEventListener('yt-navigate-finish', handleNav);
        window.addEventListener('yt-page-data-updated', handleNav);
        
        // Very slow fallback poll (5s) for extreme stability
        this._navInterval = setInterval(() => {
            if (!this.isRuntimeAvailable()) {
                this.destroy();
                return;
            }
            handleNav();
        }, TIMEOUT_CONFIG.NAV_FALLBACK_POLL);

        this._navCleanup = () => {
            window.removeEventListener('yt-navigate-finish', handleNav);
            window.removeEventListener('yt-page-data-updated', handleNav);
            if (this._navInterval) clearInterval(this._navInterval);
        };
    }

    onPageTransition(oldUrl, newUrl) {
        // console.log("YouTube Notes: SPA Navigation detected.");

        // 1. Video ID Change logic
        const newId = this.extractVideoId();
        if (newId && newId !== this.videoId) {
            debugLog("YouTube Notes: New video ID:", newId);
            this.videoId = newId;
            this.video = null;

            // Proper reset for the new video
            if (this._playerInterval) clearTimeout(this._playerInterval);
            this._playerInterval = null;
            this._playerIntervalRate = 500;
            this.setupPlayerObserver();

            chrome.runtime.sendMessage({ action: 'contentScriptReady', videoId: this.videoId }, () => {
                if (chrome.runtime.lastError) { /* normal */ }
            });
        }

        // 2. UI Cleanup / Refresh
        this.removeLegacyActivationPrompt();
        this.refreshActivationLauncherFromStorage();
        this.refreshPanelOpenState();

        // 3. Navigation away from watch page
        if (!this.isWatchPage()) {
            console.log("YouTube Notes: Navigated away from watch page. Cleaning up watch-specific tasks.");
            // Drop stale videoId so getMetadata cannot report the previous video
            // with document.title like "(11) YouTube".
            this.videoId = null;
            this.video = null;
            if (this._playerInterval) clearTimeout(this._playerInterval);
            this._playerInterval = null;
            if (this._playerInjectionInterval) clearInterval(this._playerInjectionInterval);
            this._playerInjectionInterval = null;
            this.setActivationLauncherVisible(false);
            this.closeFloatingReport();
        }
    }

    isWatchPage() {
        return window.location.pathname === '/watch';
    }

    setupActivationLauncher() {
        this.removeLegacyActivationPrompt();
        this.ensureActivationLauncher();
        this.setActivationLauncherVisible(true);
        this.attachStorageListener();
        this.refreshActivationLauncherFromStorage();
        this.refreshPanelOpenState(); // Initial check
    }

    removeLegacyActivationPrompt() {
        const selectors = [
            '#yt-notes-open-prompt',
            '#yt-notes-activation-prompt',
            '#yt-notes-prompt',
            '.yt-notes-prompt'
        ];

        const removed = new Set();
        for (const selector of selectors) {
            const nodes = document.querySelectorAll(selector);
            nodes.forEach((node) => {
                if (removed.has(node)) return;
                removed.add(node);
                node.remove();
            });
        }
    }

    attachStorageListener() {
        // Notebook toggle is scoped to the bound tab via setNotebookEnabled messages.
        // Do not mirror a global ynNotebookEnabled key (it reflected across all windows).
        this.storageListenerAttached = false;
    }

    ensureActivationLauncher() {
        if (this.activationLauncher && document.body.contains(this.activationLauncher)) {
            return;
        }

        const existing = document.getElementById('yt-notes-activate-pill');
        if (existing) existing.remove();

        const button = document.createElement('button');
        button.id = 'yt-notes-activate-pill';
        button.className = 'yt-notes-activate-pill';
        button.setAttribute('type', 'button');
        button.setAttribute('aria-label', 'Open YouTube Notes side panel');
        button.title = 'Open Notes Panel';
        const iconUrl = chrome.runtime.getURL('assets/icons/icon48.png');
        button.innerHTML = `<img class="yt-notes-activate-icon-img" src="${iconUrl}" alt="YouTube Notes"><span class="yt-notes-activate-text">Open Notes</span>`;

        button.addEventListener('click', () => {
            if (!chrome.runtime?.id) return;
            chrome.runtime.sendMessage({ action: 'openSidePanel' }, (response) => {
                if (!chrome.runtime.lastError && response?.success) {
                    this.isPanelOpen = true;
                    this.setActivationLauncherVisible(true);
                }
            });
        });

        document.body.appendChild(button);
        this.activationLauncher = button;
    }

    setActivationLauncherVisible(isVisible) {
        this.removeLegacyActivationPrompt();
        this.ensureActivationLauncher();
        if (!this.activationLauncher) return;
        const show = !!isVisible && this.isWatchPage() && !this.isPanelOpen;
        this.activationLauncher.classList.toggle('visible', show);
    }

    // Replaced with message-based sync for performance
    startPanelStatePolling() {}

    refreshPanelOpenState() {
        if (!chrome.runtime?.id) return;
        chrome.runtime.sendMessage({ action: 'isPanelOpen' }, (response) => {
            if (!chrome.runtime?.id) return;
            const open = chrome.runtime.lastError ? false : (response?.open === true);
            if (open !== this.isPanelOpen) {
                this.isPanelOpen = open;
                this.setActivationLauncherVisible(true);
            }
        });
    }

    refreshActivationLauncherFromStorage() {
        // Launcher visibility depends on watch page + panel open state only.
        // Notebook flag is delivered per-tab via setNotebookEnabled, not global storage.
        this.setActivationLauncherVisible(true);
    }

    extractVideoId() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('v');
    }

    findVideoElement() {
        // 1. High-priority: Main movie player (Watch page)
        const mainPlayer = document.querySelector('#movie_player video.html5-main-video');
        if (mainPlayer && mainPlayer.videoWidth > 0) return mainPlayer;

        // 2. Secondary-priority: Any main video class (could be ad, but usually main content)
        const mainVideos = document.querySelectorAll('video.html5-main-video');
        for (const v of mainVideos) {
            // Favor videos NOT in an ad container or miniplayer
            const isAd = v.closest('.ad-container, .ad-showing, .video-ads, ytd-video-masthead-ad-primary-video-renderer');
            const isMini = v.closest('ytd-miniplayer');
            if (!isAd && !isMini && v.videoWidth > 0) return v;
        }

        // 3. Last resort: Any video with dimensions
        const anyVideos = document.querySelectorAll('video');
        for (const v of anyVideos) {
            if (v.videoWidth > 0) return v;
        }

        return mainVideos[0] || anyVideos[0] || null;
    }

    setupPlayerObserver() {
        if (this._destroyed) return;

        // Prevent accumulation across SPA navigation and re-initialization.
        if (this._playerInterval) {
            clearTimeout(this._playerInterval);
            this._playerInterval = null;
        }

        const runObserver = () => {
            if (this._destroyed) return;

            const v = this.findVideoElement();
            if (v && v.videoWidth > 0) {
                // Periodically ensure the player button is present
                this.injectPlayerButton();

                // If we found a NEW video element (e.g. ad ended, or navigation)
                if (this.video !== v) {
                    console.log("YouTube Notes: New/Better video element detected:", v);
                    this.video = v;
                    this.onVideoFound();
                }

                // If we found a valid video, we can slow down the polling
                if (this._playerIntervalRate !== 2000) {
                    this._playerIntervalRate = 2000;
                }
            }

            // Schedule the next check
            this._playerInterval = setTimeout(runObserver, this._playerIntervalRate || TIMEOUT_CONFIG.PLAYER_POLL_RATE);
        };

        // Start the first check
        this._playerInterval = setTimeout(runObserver, this._playerIntervalRate || TIMEOUT_CONFIG.PLAYER_POLL_RATE);
    }

    onVideoFound() {
        if (!chrome.runtime?.id) return;
        try {
            chrome.runtime.sendMessage({ action: 'contentScriptReady', videoId: this.videoId }, () => {
                if (chrome.runtime.lastError) { /* normal */ }
            });
        } catch (e) { /* Extension context invalidated */ }
        
        // Set up event listeners for playback rate changes and seeks
        this.setupPlaybackEventListeners();
    }

    setupPlaybackEventListeners() {
        if (!this.video) return;
        
        // Clean up any existing listeners
        if (this._playbackRateListener) {
            this.video.removeEventListener('ratechange', this._playbackRateListener);
        }
        if (this._seekListener) {
            this.video.removeEventListener('seeked', this._seekListener);
        }
        
        // Listen for playback rate changes
        this._playbackRateListener = () => {
            if (!chrome.runtime?.id || !this.video) return;
            chrome.runtime.sendMessage({
                type: 'PLAYBACK_RATE_CHANGED',
                playbackRate: this.video.playbackRate
            }, () => {
                if (chrome.runtime.lastError) { /* ignore */ }
            });
        };
        
        // Listen for seek operations
        this._seekListener = () => {
            if (!chrome.runtime?.id || !this.video) return;
            chrome.runtime.sendMessage({
                type: 'VIDEO_SEEKED',
                currentTime: this.video.currentTime,
                currentTimeMs: this.video.currentTime * 1000
            }, () => {
                if (chrome.runtime.lastError) { /* ignore */ }
            });
        };
        
        this.video.addEventListener('ratechange', this._playbackRateListener);
        this.video.addEventListener('seeked', this._seekListener);
    }

    seekToMs(ms) {
        if (this.video) {
            this.video.currentTime = ms / 1000;
        }
    }

    getState() {
        if (!this.video) return {};
        return {
            currentTime: this.video.currentTime || 0,
            currentTimeMs: (this.video.currentTime || 0) * 1000,
            duration: this.video.duration || 0,
            durationMs: (this.video.duration || 0) * 1000,
            isPaused: this.video.paused,
            playbackRate: this.video.playbackRate
        };
    }

    captureFrameAsync(includeCaptions = true) {
        // ALWAYS re-verify the best video element before capture to avoid ad-locks
        const currentV = this.findVideoElement();
        if (currentV) this.video = currentV;

        if (!this.video || this.video.videoWidth === 0) return Promise.resolve(null);

        // YouTube CC/subtitle selector — hide before canvas draw if requested
        const CC_SELECTORS = [
            '.ytp-caption-window-container',
            '.ytp-subtitles-container',
            '.caption-window',
        ];

        const hiddenEls = [];
        if (!includeCaptions) {
            CC_SELECTORS.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    if (el.style.visibility !== 'hidden') {
                        el.style.visibility = 'hidden';
                        hiddenEls.push(el);
                    }
                });
            });
        }

        return new Promise((resolve) => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = this.video.videoWidth;
                canvas.height = this.video.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);

                // Restore captions immediately after draw
                hiddenEls.forEach(el => el.style.visibility = '');

                // Use high-quality JPEG (0.9) and async toBlob to avoid Main Thread blocking
                canvas.toBlob((blob) => {
                    if (!blob) {
                        resolve(null);
                        return;
                    }
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const dataUrl = reader.result;
                        if (!dataUrl || dataUrl === "data:,") resolve(null);
                        else resolve(dataUrl);

                        // Clean up canvas immediately
                        canvas.width = 0;
                        canvas.height = 0;
                    };
                    reader.onerror = () => {
                        console.error("FileReader failed");
                        resolve(null);
                    };
                    reader.readAsDataURL(blob);
                }, 'image/jpeg', 0.90);
            } catch (e) {
                // Restore captions on error too
                hiddenEls.forEach(el => el.style.visibility = '');
                console.error("Canvas capture failed:", e);
                resolve(null);
            }
        });
    }

    setupPlayerUIInjection() {
        // Obsolete: Combined into setupPlayerObserver
    }

    injectCSS() {
        if (document.getElementById('yt-notes-player-styles')) return;
        const style = document.createElement('style');
        style.id = 'yt-notes-player-styles';
        style.textContent = `
            .yt-notes-player-button, .yt-notes-player-watch-later-button {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 36px !important;
                height: 36px !important;
                padding: 0 !important;
                opacity: 0.9 !important;
                transition: transform 0.1s, opacity 0.2s !important;
                cursor: pointer !important;
                margin: 0 !important;
            }
            .yt-notes-player-button:hover, .yt-notes-player-watch-later-button:hover {
                opacity: 1 !important;
            }
            .yt-notes-player-button svg, .yt-notes-player-watch-later-button svg {
                width: 22px !important;
                height: 22px !important;
                pointer-events: none !important;
            }
            .yt-notes-player-watch-later-button svg {
                width: 30px !important;
                height: 30px !important;
            }
        `;
        document.head.appendChild(style);
    }

    injectPlayerButton() {
        if (!this.isWatchPage()) return;

        // Use a more specific class for detection to handle YouTube re-renders better
        if (document.querySelector('.yt-notes-player-button')) return;

        const rightControls = document.querySelector('.ytp-right-controls');
        if (!rightControls) return;

        // 1. Screenshot Button
        const shotBtn = document.createElement('button');
        shotBtn.id = 'yt-notes-player-screenshot-btn';
        shotBtn.className = 'ytp-button yt-notes-player-button';
        shotBtn.title = 'Take Note Screenshot (S)';
        shotBtn.setAttribute('aria-label', 'Take Note Screenshot');
        shotBtn.innerHTML = `
            <svg width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12m-3.2 0a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0"></path>
                <path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5s5 2.24 5 5s-2.24 5-5 5z"></path>
            </svg>
        `;
        shotBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.triggerCapture();
        });

        // 2. Watch Later Button (+)
        const watchLaterBtn = document.createElement('button');
        watchLaterBtn.id = 'yt-notes-player-watch-later-btn';
        watchLaterBtn.className = 'ytp-button yt-notes-player-watch-later-button';
        watchLaterBtn.title = 'Add to Watch Later (+)';
        watchLaterBtn.setAttribute('aria-label', 'Add to Watch Later');
        watchLaterBtn.innerHTML = `
            <svg width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path>
            </svg>
        `;
        watchLaterBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.triggerWatchLater();
        });

        // Inject them both (Watch Later first, so it ends up to the right of Screenshot)
        rightControls.prepend(watchLaterBtn);
        rightControls.prepend(shotBtn);
    }

    triggerWatchLater() {
        if (!this.isRuntimeAvailable()) {
            return;
        }
        console.log("ContentScript: triggerWatchLater called");
        try {
            const metadata = this.getVideoMetadata();
            chrome.runtime.sendMessage({
                action: 'shortcutPressed',
                key: '+',
                metadata: metadata
            });
            console.log("ContentScript: Message sent for Watch Later (+) with metadata");
        } catch (e) {
            console.error("ContentScript: Failed to send watch later message:", e);
        }
    }


    triggerCapture() {
        if (!chrome.runtime?.id) return;
        try {
            chrome.runtime.sendMessage({ action: 'shortcutPressed', key: 's' });

            // Visual feedback on the button itself if possible
            const btn = document.querySelector('.yt-notes-player-button');
            if (btn) {
                btn.style.transform = 'scale(0.85)';
                setTimeout(() => btn.style.transform = '', TIMEOUT_CONFIG.ANIMATION_FEEDBACK);
            }
        } catch (err) { /* context invalidated */ }
    }

    getVideoMetadata() {
        const currentId = this.extractVideoId();
        // Only report a video when we are actually on a watch URL.
        if (!this.isWatchPage() || !currentId) {
            return {
                videoId: null,
                title: '',
                channel: '',
                url: window.location.href
            };
        }
        // Modern YouTube title selectors
        const titleEl = document.querySelector('ytd-watch-metadata h1, ytd-video-primary-info-renderer h1, #title h1, h1.ytd-video-primary-info-renderer, h1.title');
        const channelEl = document.querySelector('#channel-name a, ytd-channel-name a, #text-container.ytd-channel-name a');
        let title = titleEl?.textContent?.trim();
        if (!title || title === "" || title === "YouTube Video") {
            // Never use notification-style document.title like "(11) YouTube".
            const docTitle = document.title.replace(' - YouTube', '').trim();
            if (docTitle && !/^\(\d+\)\s*YouTube$/i.test(docTitle) && docTitle !== 'YouTube') {
                title = docTitle;
            }
        }
        return {
            videoId: currentId,
            title: title || 'YouTube Video',
            channel: channelEl?.textContent?.trim() || 'Unknown Channel',
            url: window.location.href
        };
    }

    setupMessageListener() {
        if (!chrome?.runtime?.onMessage) return;
        if (this._messageListener) {
            try {
                chrome.runtime.onMessage.removeListener(this._messageListener);
            } catch (e) { /* Context invalidated */ }
        }

        this._messageListener = (message, sender, sendResponse) => {
            if (message.action === 'getState') {
                sendResponse(this.getState());
            } else if (message.action === 'seekTo') {
                this.seekToMs(message.timeMs);
                sendResponse({ success: true });
            } else if (message.action === 'captureScreenshot') {
                this.captureFrameAsync(message.includeCaptions !== false).then((imageData) => {
                    if (!imageData) {
                        sendResponse({ success: false, error: "Canvas capture failed or blocked." });
                    } else {
                        sendResponse({ success: true, imageData: imageData, ...this.getState() });
                    }
                });
                return true;
            } else if (message.action === 'hideCaptions') {
                // Temporarily hide CC for captureVisibleTab fallback
                this._ccHidden = [];
                ['.ytp-caption-window-container', '.ytp-subtitles-container', '.caption-window'].forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.visibility = 'hidden';
                        this._ccHidden.push(el);
                    });
                });
                sendResponse({ success: true });
            } else if (message.action === 'showCaptions') {
                // Restore hidden CCs
                (this._ccHidden || []).forEach(el => el.style.visibility = '');
                this._ccHidden = [];
                sendResponse({ success: true });
            } else if (message.action === 'startAreaSelection') {
                this.startAreaSelection(sendResponse);
                return true; // Keep channel open
            } else if (message.action === 'getMetadata') {
                sendResponse(this.getVideoMetadata());
            } else if (message.action === 'getTranscript') {
                this.getTranscript().then(res => sendResponse(res));
                return true; // async
            } else if (message.action === 'setNotebookEnabled') {
                this.notebookEnabled = !!message.enabled;
                this.setActivationLauncherVisible(true);
                sendResponse({ success: true });
            } else if (message.action === 'getScreenInfo') {
                sendResponse({
                    availWidth: window.screen.availWidth,
                    availHeight: window.screen.availHeight,
                    availLeft: window.screen.availLeft || 0,
                    availTop: window.screen.availTop || 0
                });
            } else if (message.action === 'TAB_PANEL_OPENED') {
                this.isPanelOpen = true;
                this.setActivationLauncherVisible(true);
                sendResponse({ success: true });
            } else if (message.action === 'TAB_PANEL_CLOSED') {
                this.isPanelOpen = false;
                this.setActivationLauncherVisible(true);
                sendResponse({ success: true });
            } else if (message.action === 'OPEN_FLOATING_REPORT') {
                this.showFloatingReport(message.url);
                sendResponse({ success: true });
            } else if (message.action === 'CLOSE_FLOATING_REPORT') {
                this.closeFloatingReport();
                sendResponse({ success: true });
            }
            return true;
        };

        chrome.runtime.onMessage.addListener(this._messageListener);
    }

    showFloatingReport(url) {
        this.closeFloatingReport(); // Ensure old ones are removed

        const overlay = document.createElement('div');
        overlay.id = 'yt-notes-report-overlay';
        overlay.className = 'yt-notes-report-overlay';

        const container = document.createElement('div');
        container.className = 'yt-notes-report-container';

        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'yt-notes-report-iframe';
        iframe.setAttribute('frameborder', '0');

        container.appendChild(iframe);
        overlay.appendChild(container);

        // Close on overlay click (optional, but keep it for UX)
        overlay.onclick = (e) => {
            if (e.target === overlay) this.closeFloatingReport();
        };

        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden'; // Prevent page scroll
    }

    closeFloatingReport() {
        const overlay = document.getElementById('yt-notes-report-overlay');
        if (overlay) {
            overlay.remove();
        }
        document.body.style.overflow = '';
    }

    startAreaSelection(sendResponse) {
        if (!this.video) {
            sendResponse({ success: false, error: "Video element not found." });
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'yt-notes-selection-overlay';

        const hint = document.createElement('div');
        hint.className = 'yt-notes-selection-hint';
        hint.textContent = 'Drag over the video to capture a selection (ESC to cancel)';
        overlay.appendChild(hint);

        const selectionBox = document.createElement('div');
        selectionBox.className = 'yt-notes-selection-box';
        overlay.appendChild(selectionBox);

        document.body.appendChild(overlay);

        let startX, startY, isDragging = false;
        let aborted = false;

        const onMouseDown = (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            selectionBox.style.left = `${startX}px`;
            selectionBox.style.top = `${startY}px`;
            selectionBox.style.width = '0';
            selectionBox.style.height = '0';
            selectionBox.style.display = 'block';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const currentX = e.clientX;
            const currentY = e.clientY;

            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);

            selectionBox.style.left = `${left}px`;
            selectionBox.style.top = `${top}px`;
            selectionBox.style.width = `${width}px`;
            selectionBox.style.height = `${height}px`;
        };

        const onMouseUp = (e) => {
            if (!isDragging) return;
            isDragging = false;

            if (aborted) return;

            const rect = selectionBox.getBoundingClientRect();
            if (overlay.parentNode === document.body) overlay.remove();
            document.removeEventListener('keydown', onEsc);
            window.removeEventListener('mousemove', onMouseMove);

            if (rect.width < 5 || rect.height < 5) {
                sendResponse({ success: false, error: "Selection too small." });
                return;
            }

            // Capture and Crop
            this.captureAndCrop(rect, sendResponse);
        };

        const onEsc = (e) => {
            if (e.key === 'Escape') {
                aborted = true;
                if (overlay.parentNode === document.body) overlay.remove();
                document.removeEventListener('keydown', onEsc);
                window.removeEventListener('mousemove', onMouseMove);
                sendResponse({ success: false, error: "Cancelled" });
            }
        };

        overlay.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp, { once: true });
        document.addEventListener('keydown', onEsc);
    }

    captureAndCrop(rect, sendResponse) {
        if (!this.video) return;

        try {
            const videoRect = this.video.getBoundingClientRect();

            // Map screen coordinates (rect) to video source coordinates (videoWidth/Height)
            const scaleX = this.video.videoWidth / videoRect.width;
            const scaleY = this.video.videoHeight / videoRect.height;

            const sourceX = (rect.left - videoRect.left) * scaleX;
            const sourceY = (rect.top - videoRect.top) * scaleY;
            const sourceW = rect.width * scaleX;
            const sourceH = rect.height * scaleY;

            const canvas = document.createElement('canvas');
            canvas.width = sourceW;
            canvas.height = sourceH;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(this.video, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);

            canvas.toBlob((blob) => {
                if (!blob) {
                    sendResponse({ success: false, error: "Crop failed." });
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const dataUrl = reader.result;
                    if (dataUrl === "data:,") {
                        sendResponse({ success: false, error: "Crop failed." });
                    } else {
                        sendResponse({ success: true, imageData: dataUrl, ...this.getState() });
                    }
                };
                reader.onerror = () => sendResponse({ success: false, error: "Crop read failed." });
                reader.readAsDataURL(blob);
            }, 'image/png', 0.95);
        } catch (e) {
            console.error("Area capture failed:", e);
            sendResponse({ success: false, error: e.message });
        }
    }

    pickBestCaptionTrack(captionTracks) {
        if (!captionTracks || captionTracks.length === 0) return null;
        const isEnglish = (t) => /^en($|-)/i.test(t?.languageCode || '');
        const manualEnglish = captionTracks.find(t => isEnglish(t) && t.kind !== 'asr');
        const englishAny = captionTracks.find(t => isEnglish(t));
        const manualAny = captionTracks.find(t => t.kind !== 'asr');
        return manualEnglish || englishAny || manualAny || captionTracks[0];
    }

    buildTranscriptUrl(baseUrl, fmt) {
        const url = new URL(baseUrl, window.location.origin);
        url.searchParams.set('fmt', fmt);
        return url.toString();
    }

    normalizeTranscriptText(text) {
        return (text || '')
            .replace(/\u00A0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    splitTranscriptTextIntoChunks(text, maxChars = 120) {
        const normalized = this.normalizeTranscriptText(text);
        if (!normalized) return [];
        if (normalized.length <= maxChars) return [normalized];

        const sentenceLike = normalized.match(/[^.!?;:]+[.!?;:]?|[^.!?;:]+$/g) || [normalized];
        const chunks = [];
        let buffer = '';

        const pushBuffer = () => {
            const clean = this.normalizeTranscriptText(buffer);
            if (clean) chunks.push(clean);
            buffer = '';
        };

        for (const partRaw of sentenceLike) {
            const part = this.normalizeTranscriptText(partRaw);
            if (!part) continue;

            const candidate = buffer ? `${buffer} ${part}` : part;
            if (candidate.length <= maxChars) {
                buffer = candidate;
                continue;
            }

            pushBuffer();

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
                const clean = this.normalizeTranscriptText(line);
                if (clean) chunks.push(clean);
                line = word;
            }
            const clean = this.normalizeTranscriptText(line);
            if (clean) chunks.push(clean);
        }

        pushBuffer();
        return chunks;
    }

    finalizeTranscriptSegments(rawSegments) {
        const enriched = [];

        for (const seg of rawSegments || []) {
            const timestampMs = Number(seg?.timestampMs);
            if (!Number.isFinite(timestampMs)) continue;

            const text = this.normalizeTranscriptText(seg?.text || '');
            if (!text) continue;

            const chunks = this.splitTranscriptTextIntoChunks(text, 120);
            for (const chunk of chunks) {
                enriched.push({
                    timestampMs,
                    time: formatTimeHelper(timestampMs),
                    text: chunk
                });
            }
        }

        enriched.sort((a, b) => a.timestampMs - b.timestampMs);

        const deduped = [];
        for (const seg of enriched) {
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

    decodeHtmlEntities(text) {
        const el = document.createElement('textarea');
        el.innerHTML = text;
        return el.value;
    }

    parseYoutubeiTranscript(data) {
        if (!data) return [];
        try {
            // InnerTube transcript response structure
            const action = (data.actions || []).find(a => a?.updateTranscriptAction);
            if (!action) return [];

            const renderer = action.updateTranscriptAction?.transcript?.transcriptRenderer;
            if (!renderer) return [];

            const bodyRenderer = renderer.body?.transcriptBodyRenderer;
            const cueGroups = bodyRenderer?.cueGroups;
            if (!Array.isArray(cueGroups)) return [];

            const segments = [];
            for (const group of cueGroups) {
                const cueGroup = group?.transcriptCueGroupRenderer;
                if (!cueGroup) continue;

                const cue = cueGroup.cues?.[0]?.transcriptCueRenderer;
                if (!cue) continue;

                const startMs = Number(cue.startMessageMs);
                if (!Number.isFinite(startMs)) continue;

                let text = "";
                if (cue.cue?.simpleText) {
                    text = cue.cue.simpleText;
                } else if (Array.isArray(cue.cue?.runs)) {
                    text = cue.cue.runs.map(r => r.text || "").join("");
                }

                if (text) {
                    segments.push({
                        time: formatTimeHelper(startMs),
                        text: this.normalizeTranscriptText(text),
                        timestampMs: startMs
                    });
                }
            }
            return segments;
        } catch (e) {
            console.error("[ContentScript] Error parsing Youtubei transcript:", e);
            return [];
        }
    }

    parseJson3Transcript(rawText) {
        let data = null;
        try {
            data = JSON.parse(rawText);
        } catch (_) {
            return [];
        }
        if (!data || !Array.isArray(data.events)) return [];

        const segments = [];
        data.events.forEach((event) => {
            if (!Array.isArray(event?.segs) || event.segs.length === 0) return;
            const raw = event.segs.map(s => s?.utf8 || '').join('');
            const text = this.normalizeTranscriptText(raw);
            if (!text) return;
            const timestampMs = Number(event.tStartMs);
            if (!Number.isFinite(timestampMs)) return;
            segments.push({
                time: formatTimeHelper(timestampMs),
                text,
                timestampMs
            });
        });
        return segments;
    }

    parseXmlTranscript(rawText) {
        const parser = new DOMParser();
        const xml = parser.parseFromString(rawText, 'text/xml');
        if (xml.querySelector('parsererror')) return [];

        const segments = [];

        // XML captions can appear as <text start="..."> or <p t="...">.
        const textNodes = Array.from(xml.querySelectorAll('text'));
        textNodes.forEach((node) => {
            const startSec = Number(node.getAttribute('start'));
            const timestampMs = Number.isFinite(startSec) ? Math.round(startSec * 1000) : NaN;
            if (!Number.isFinite(timestampMs)) return;
            const text = this.normalizeTranscriptText(node.textContent || '');
            if (!text) return;
            segments.push({
                time: formatTimeHelper(timestampMs),
                text,
                timestampMs
            });
        });

        if (segments.length > 0) return segments;

        const pNodes = Array.from(xml.querySelectorAll('p'));
        pNodes.forEach((node) => {
            const startMs = Number(node.getAttribute('t'));
            const timestampMs = Number.isFinite(startMs) ? startMs : NaN;
            if (!Number.isFinite(timestampMs)) return;
            const raw = this.decodeHtmlEntities(node.textContent || '');
            const text = this.normalizeTranscriptText(raw);
            if (!text) return;
            segments.push({
                time: formatTimeHelper(timestampMs),
                text,
                timestampMs
            });
        });

        return segments;
    }

    parseVttTimestampToMs(timeToken) {
        if (!timeToken) return NaN;
        const cleaned = timeToken.trim().replace(',', '.');
        const parts = cleaned.split(':');
        if (parts.length < 2 || parts.length > 3) return NaN;

        let hours = 0;
        let minutes = 0;
        let seconds = 0;
        let millis = 0;

        if (parts.length === 3) {
            hours = Number(parts[0]);
            minutes = Number(parts[1]);
            const secParts = parts[2].split('.');
            seconds = Number(secParts[0]);
            millis = Number((secParts[1] || '0').padEnd(3, '0').slice(0, 3));
        } else {
            minutes = Number(parts[0]);
            const secParts = parts[1].split('.');
            seconds = Number(secParts[0]);
            millis = Number((secParts[1] || '0').padEnd(3, '0').slice(0, 3));
        }

        if (![hours, minutes, seconds, millis].every(Number.isFinite)) return NaN;
        return (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis;
    }

    parseVttTranscript(rawText) {
        const lines = rawText.split(/\r?\n/);
        const segments = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.includes('-->')) continue;

            const startToken = line.split('-->')[0].trim();
            const timestampMs = this.parseVttTimestampToMs(startToken);
            if (!Number.isFinite(timestampMs)) continue;

            const cueLines = [];
            for (let j = i + 1; j < lines.length; j++) {
                const cueLine = lines[j];
                if (!cueLine.trim()) {
                    i = j;
                    break;
                }
                cueLines.push(cueLine);
                if (j === lines.length - 1) i = j;
            }

            const rawCue = cueLines.join(' ');
            const cueNoTags = rawCue.replace(/<[^>]+>/g, ' ');
            const text = this.normalizeTranscriptText(this.decodeHtmlEntities(cueNoTags));
            if (!text) continue;

            segments.push({
                time: formatTimeHelper(timestampMs),
                text,
                timestampMs
            });
        }

        return segments;
    }

    parseTranscriptPayload(rawText, hintedFmt = '') {
        const trimmed = (rawText || '').trim();
        if (!trimmed) return [];

        const hint = (hintedFmt || '').toLowerCase();
        console.log(`[DEBUG] parseTranscriptPayload called with hint: ${hint}`);
        if (hint === 'json3') {
            const res = this.finalizeTranscriptSegments(this.parseJson3Transcript(trimmed));
            console.log(`[DEBUG] parsed json3 -> ${res.length} segments`);
            return res;
        }
        // Specific hint for the new InnerTube transcript endpoint
        if (hint === 'youtubei') {
             try {
                const data = JSON.parse(trimmed);
                const res = this.finalizeTranscriptSegments(this.parseYoutubeiTranscript(data));
                console.log(`[DEBUG] parsed youtubei -> ${res.length} segments`);
                return res;
            } catch (_) { return []; }
        }

        if (hint === 'srv3' || hint === 'srv2' || hint === 'srv1' || hint === 'ttml' || hint === 'xml') {
            const res = this.finalizeTranscriptSegments(this.parseXmlTranscript(trimmed));
            console.log(`[DEBUG] parsed xml (${hint}) -> ${res.length} segments`);
            return res;
        }
        if (hint === 'vtt') {
            const res = this.finalizeTranscriptSegments(this.parseVttTranscript(trimmed));
            console.log(`[DEBUG] parsed vtt -> ${res.length} segments`);
            return res;
        }

        if (trimmed.startsWith('{')) {
            try {
                const data = JSON.parse(trimmed);
                // Try Youtubei first for JSON as it's more common for newer POST requests
                let segments = this.parseYoutubeiTranscript(data);
                if (segments.length === 0) {
                    segments = this.parseJson3Transcript(trimmed);
                }
                if (segments.length > 0) return this.finalizeTranscriptSegments(segments);
            } catch (e) {
                console.debug('[ContentScript] Failed to parse JSON transcript:', e);
            }
        }
        if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
            const vttSegments = this.parseVttTranscript(trimmed);
            if (vttSegments.length) return this.finalizeTranscriptSegments(vttSegments);
        }
        if (trimmed.startsWith('<')) {
            const xmlSegments = this.parseXmlTranscript(trimmed);
            if (xmlSegments.length) return this.finalizeTranscriptSegments(xmlSegments);
        }

        // Last-resort parser attempts.
        try {
            const data = JSON.parse(trimmed);
            const youtubeiFallback = this.parseYoutubeiTranscript(data);
            if (youtubeiFallback.length) return this.finalizeTranscriptSegments(youtubeiFallback);
        } catch (e) {
            console.debug('[ContentScript] Failed to parse JSON fallback:', e);
        }

        const jsonFallback = this.parseJson3Transcript(trimmed);
        if (jsonFallback.length) return this.finalizeTranscriptSegments(jsonFallback);
        const xmlFallback = this.parseXmlTranscript(trimmed);
        if (xmlFallback.length) return this.finalizeTranscriptSegments(xmlFallback);
        const vttFallback = this.parseVttTranscript(trimmed);
        if (vttFallback.length) return this.finalizeTranscriptSegments(vttFallback);

        console.warn(`[DEBUG] Failed to parse payload with length ${trimmed.length} and hint ${hint}`);
        return [];
    }

    prioritizeTimedtextUrls(urls, preferredLanguageCode = '') {
        const scored = [];
        const dedupe = new Set();
        const preferredBase = (preferredLanguageCode || '').split('-')[0].toLowerCase();

        for (const item of urls || []) {
            if (!item) continue;
            const rawUrl = typeof item === 'string' ? item : item.url;
            if (!rawUrl || dedupe.has(rawUrl)) continue;
            dedupe.add(rawUrl);

            let score = 0;
            // HUGE boost if we already intercepted the literal response text!
            if (typeof item === 'object' && item.responseText) {
                score += 100;
            }

            try {
                const url = new URL(rawUrl, window.location.origin);
                const lang = (url.searchParams.get('lang') || '').toLowerCase();
                const fmt = (url.searchParams.get('fmt') || '').toLowerCase();
                const kind = (url.searchParams.get('kind') || '').toLowerCase();

                if (preferredLanguageCode && lang === preferredLanguageCode.toLowerCase()) score += 5;
                if (preferredBase && lang.startsWith(preferredBase)) score += 3;
                if (kind !== 'asr') score += 1;
                if (fmt === 'json3') score += 2;
                if (fmt === 'srv3' || fmt === 'vtt') score += 1;
            } catch (e) {
                console.debug('[ContentScript] Failed to parse URL for scoring:', rawUrl, e);
            }

            scored.push({ item, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.map(s => s.item);
    }

    async fetchTranscriptFromDirectUrls(directUrls) {
        const failures = [];
        const requestQueue = [];
        const dedupe = new Set();
        const candidatePayloads = [];

        // 1. Initial Pass: Normalize payloads and catch early pre-cached text
        for (const payload of (directUrls || [])) {
            if (!payload) continue;
            let p = {
                url: typeof payload === 'string' ? payload : payload.url,
                method: payload.method || 'GET',
                body: payload.body || null,
                preCachedText: payload.responseText || null,
                fmtHint: ''
            };
            if (!p.url) continue;
            try {
                const urlObj = new URL(p.url, window.location.origin);
                p.url = urlObj.toString();
                const isIterative = urlObj.pathname.includes('/youtubei/v1/get_transcript');
                p.fmtHint = isIterative ? 'youtubei' : (urlObj.searchParams.get('fmt') || '');
                p.isIterative = isIterative;
                candidatePayloads.push(p);
            } catch (_) { continue; }
        }

        if (candidatePayloads.length === 0) return { error: "No valid URLs" };

        // 2. Shared Polling Phase: Wait for bridge data without nested closures
        const pollWait = (ms) => new Promise(r => setTimeout(r, ms));
        
        for (let attempt = 1; attempt <= 4; attempt++) {
            const bridgeData = await this.getBridgeData();
            const timedtextUrls = bridgeData?.timedtextUrls || [];
            
            let foundInAttempt = false;
            for (const p of candidatePayloads) {
                if (p.preCachedText) continue;
                const matching = timedtextUrls.find(u => u.url === p.url);
                if (matching?.responseText) {
                    p.preCachedText = matching.responseText;
                    foundInAttempt = true;
                }
            }

            if (foundInAttempt) {
                for (const p of candidatePayloads) {
                    if (p.preCachedText) {
                        const parsed = this.parseTranscriptPayload(p.preCachedText, p.fmtHint);
                        if (parsed && parsed.length > 0) return { segments: parsed, sourceFormat: p.fmtHint || 'cached' };
                    }
                }
            }

            if (attempt < 4) await pollWait(TIMEOUT_CONFIG.RETRY_DELAY_BASE);
        }

        // 3. Network Fetch Phase
        for (const p of candidatePayloads) {
            // Final check of what we have before direct fetch
            if (p.preCachedText) {
                const parsed = this.parseTranscriptPayload(p.preCachedText, p.fmtHint);
                if (parsed && parsed.length > 0) return { segments: parsed, sourceFormat: p.fmtHint || 'cached' };
            }

            if (!dedupe.has(p.url)) {
                dedupe.add(p.url);
                requestQueue.push({ url: p.url, fmtHint: p.fmtHint, method: p.method, body: p.body });
            }

            if (!p.isIterative) {
                for (const fmt of ['json3', 'srv3', 'vtt']) {
                    try {
                        const variant = new URL(p.url);
                        variant.searchParams.set('fmt', fmt);
                        const vStr = variant.toString();
                        if (!dedupe.has(vStr)) {
                            dedupe.add(vStr);
                            requestQueue.push({ url: vStr, fmtHint: fmt, method: p.method, body: p.body });
                        }
                    } catch (e) {
                        console.debug('[ContentScript] Failed to create URL variant:', p.url, e);
                    }
                }
            }
        }

        for (const item of requestQueue) {
            try {
                const fetchOptions = {
                    method: item.method || 'GET',
                    credentials: 'include',
                    headers: { 
                        'Accept': '*/*',
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    }
                };

                if (item.method === 'POST') {
                    if (item.body) {
                        if (typeof item.body === 'string') {
                            fetchOptions.body = item.body;
                            fetchOptions.headers['Content-Type'] = 'application/json';
                        }
                    } else if (item.url.includes('/youtubei/v1/')) {
                        continue;
                    }
                }

                const resp = await fetch(item.url, fetchOptions);
                if (!resp.ok) {
                    failures.push(`${item.fmtHint}: ${resp.status}`);
                    continue;
                }
                const rawText = await resp.text();
                if (!rawText || !rawText.trim()) {
                    failures.push(`${item.fmtHint}: empty`);
                    continue;
                }

                const segments = this.parseTranscriptPayload(rawText, item.fmtHint);
                if (segments && segments.length > 0) return { segments, sourceFormat: item.fmtHint || 'direct' };
                
                const reason = (!segments) ? "parsing error" : "no segments found";
                failures.push(`${item.fmtHint}: ${reason}`);
            } catch (err) {
                failures.push(`${item.fmtHint}: ${err.name} - ${err.message}`);
            }
        }

        return {
            segments: [],
            error: failures.length ? failures.join(' | ') : 'No direct timedtext URL could be parsed.'
        };
    }

    async fetchTranscriptForTrack(baseUrl) {
        const formats = ['json3', 'srv3', 'vtt'];
        const failures = [];

        for (const fmt of formats) {
            const url = this.buildTranscriptUrl(baseUrl, fmt);
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    headers: { 'Accept': '*/*' }
                });
                if (!response.ok) {
                    failures.push(`${fmt}: HTTP ${response.status}`);
                    continue;
                }

                const rawText = await response.text();
                if (!rawText || !rawText.trim()) {
                    failures.push(`${fmt}: empty response`);
                    continue;
                }

                const segments = this.parseTranscriptPayload(rawText, fmt);

                if (segments && segments.length > 0) {
                    return { segments, sourceFormat: fmt };
                }

                const reason = (!segments) ? "parsing error" : "no text found";
                failures.push(`${fmt}: ${reason}`);
            } catch (err) {
                failures.push(`${fmt}: ${err.name} - ${err.message}`);
            }
        }

        return {
            segments: [],
            error: failures.length
                ? `Captions found but could not be read (${failures.join(' | ')}).`
                : 'Transcript content is unavailable.'
        };
    }

    // Extract transcript using internal YouTube player data.
    async getTranscript() {
        try {
            // console.log("YouTube Notes: Fetching transcript via page bridge...");

            const bridgeData = await this.getBridgeData();
            const playerResponse = bridgeData?.playerResponse || null;
            const observedTimedtextUrls = Array.isArray(bridgeData?.timedtextUrls)
                ? bridgeData.timedtextUrls
                : [];
            const hasPotUrls = bridgeData?.hasPotUrls === true;

            debugLog(`YouTube Notes: Bridge data received. Intercepted URLs: ${observedTimedtextUrls.length}, hasPot: ${hasPotUrls}`);

            // STRATEGY 1 (PRIORITY): Use intercepted URLs from the page bridge.
            // These contain fresh `pot` tokens and are YouTube's "approved" requests.
            // We always try these first whenever they are available.
            if (observedTimedtextUrls.length > 0) {
                const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                const preferredTrack = captionTracks ? this.pickBestCaptionTrack(captionTracks) : null;
                const preferredLang = preferredTrack?.languageCode || 'en';

                const prioritizedUrls = this.prioritizeTimedtextUrls(observedTimedtextUrls, preferredLang);
                const interceptedResult = await this.fetchTranscriptFromDirectUrls(prioritizedUrls);

                if (interceptedResult.segments && interceptedResult.segments.length > 0) {
                    console.log("YouTube Notes: Transcript loaded from intercepted URLs.");
                    return {
                        success: true,
                        segments: interceptedResult.segments,
                        languageCode: preferredLang,
                        sourceFormat: interceptedResult.sourceFormat || 'intercepted'
                    };
                }
                console.warn("YouTube Notes: Intercepted URLs returned no content:", interceptedResult.error);
            }

            // STRATEGY 2 (FALLBACK): Use baseUrl from ytInitialPlayerResponse captions.
            // These may lack the `pot` token on newer YouTube, so they are a fallback only.
            if (!playerResponse || !playerResponse.captions) {
                return {
                    success: false,
                    error: observedTimedtextUrls.length > 0
                        ? "Transcript requests were intercepted but returned empty. Turn CC ON for a few seconds, then retry."
                        : "Transcript data not found. Try enabling CC on the video first, then click Transcript again."
                };
            }

            const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (!captionTracks || captionTracks.length === 0) {
                return { success: false, error: "No caption tracks available for this video." };
            }

            const track = this.pickBestCaptionTrack(captionTracks);
            if (!track?.baseUrl) {
                return { success: false, error: "Caption track URL missing for this video." };
            }

            const fallbackResult = await this.fetchTranscriptForTrack(track.baseUrl);

            if (!fallbackResult.segments || fallbackResult.segments.length === 0) {
                const potHint = "YouTube now requires a fresh security token for transcripts. Turn CC ON for a few seconds, then retry.";
                const baseError = fallbackResult.error || "Transcript is empty.";
                return { success: false, error: `${baseError} ${potHint}` };
            }

            return {
                success: true,
                segments: fallbackResult.segments,
                languageCode: track.languageCode || '',
                sourceFormat: fallbackResult.sourceFormat || ''
            };

        } catch (err) {
            console.error("Transcript error:", err);
            return { success: false, error: "Error: " + err.message };
        }
    }

    setupKeyboardShortcuts() {
        if (this._keyboardListener) {
            window.removeEventListener('keydown', this._keyboardListener, true);
        }

        this._keyboardListener = (e) => {
            if (e.repeat) return;
            // Ignore if user is typing in an input/textarea/contenteditable
            const tag = document.activeElement?.tagName?.toLowerCase();
            const isEditable = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable;
            if (isEditable) return;

            const key = e.key.toLowerCase();
            if (key === 's' || key === 'z' || key === 't' || key === 'a' || key === 'e') {
                // Prevent default specifically for these keys to avoid YouTube conflict
                if (key === 's' || key === 'z' || key === 't' || key === 'a' || key === 'e') e.preventDefault();

                if (!this.isRuntimeAvailable()) return;
                console.log("YouTube Notes: Shortcut triggered globally:", key);
                try {
                    chrome.runtime.sendMessage({ action: 'shortcutPressed', key: key });
                } catch (e) { /* Extension context invalidated */ }
            }
        };

        window.addEventListener('keydown', this._keyboardListener, true); // Use capture phase
    }

    // ==========================================
    // Mini View Overlay Logic
    // ==========================================
    setupMiniViewListener() {
        if (!chrome?.storage?.onChanged) return;

        const myViewKey = Number.isInteger(this.myTabId) ? `activeCountdownMiniView:${this.myTabId}` : null;
        const myPosKey = Number.isInteger(this.myTabId) ? `activeCountdownMiniViewPos:${this.myTabId}` : null;
        const readKeys = ['activeCountdownMiniView', 'activeCountdownMiniViewPos'];
        if (myViewKey) readKeys.push(myViewKey);
        if (myPosKey) readKeys.push(myPosKey);

        chrome.storage.local.get(readKeys, (result) => {
            const own = myViewKey ? result[myViewKey] : null;
            const legacy = result.activeCountdownMiniView;
            const cd = (own && this.shouldRenderMiniView(own))
                ? own
                : ((legacy && this.shouldRenderMiniView(legacy)) ? legacy : null);
            if (cd) {
                const pos = (myPosKey && result[myPosKey]) || result.activeCountdownMiniViewPos;
                this.renderMiniView(cd, pos);
            }
        });

        if (this._miniViewStorageChangeListener) {
            try {
                chrome.storage.onChanged.removeListener(this._miniViewStorageChangeListener);
            } catch (e) { /* Context invalidated */ }
        }

        this._miniViewStorageChangeListener = (changes, areaName) => {
            if (areaName !== 'local') return;

            // Prefer this tab's scoped key; ignore other tabs' keys entirely.
            if (myViewKey && changes[myViewKey]) {
                const cd = changes[myViewKey].newValue;
                if (cd && this.shouldRenderMiniView(cd)) {
                    const posRead = myPosKey ? [myPosKey] : [];
                    if (posRead.length) {
                        chrome.storage.local.get(posRead, (posRes) => {
                            this.renderMiniView(cd, posRes[myPosKey]);
                        });
                    } else {
                        this.renderMiniView(cd, null);
                    }
                } else if (!cd) {
                    this.removeMiniView();
                }
                return;
            }

            // Legacy single-key path: never tear down because ANOTHER tab wrote.
            if (changes.activeCountdownMiniView) {
                const cd = changes.activeCountdownMiniView.newValue;
                if (cd && this.shouldRenderMiniView(cd)) {
                    chrome.storage.local.get(['activeCountdownMiniViewPos'], (posRes) => {
                        this.renderMiniView(cd, posRes.activeCountdownMiniViewPos);
                    });
                } else if (!cd || (Number.isInteger(cd?.tabId) && cd.tabId === this.myTabId)) {
                    // Cleared, or was ours and is now invalid — not a foreign-tab write.
                    this.removeMiniView();
                }
            }
        };

        chrome.storage.onChanged.addListener(this._miniViewStorageChangeListener);
    }

    removeMiniView() {
        const existing = document.getElementById('yt-notes-mini-view');
        if (existing) existing.remove();
        if (typeof this._miniViewDragCleanup === 'function') {
            this._miniViewDragCleanup();
            this._miniViewDragCleanup = null;
        }
    }

    renderMiniView(cd, pos) {
        this.removeMiniView();

        const container = document.createElement('div');
        container.id = 'yt-notes-mini-view';
        container.className = 'cd-mini-view-container';
        if (cd.isTransparent) container.classList.add('transparent');

        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
            container.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = new Date(cd.startDate);
        start.setMinutes(start.getMinutes() + start.getTimezoneOffset());
        const end = new Date(cd.endDate);
        end.setMinutes(end.getMinutes() + end.getTimezoneOffset());

        const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
        const passedDays = Math.round((today - start) / (1000 * 60 * 60 * 24));
        const remainingDays = Math.round((end - today) / (1000 * 60 * 60 * 24)) + 1;

        let progress = Math.min(100, Math.max(0, Math.round((passedDays / totalDays) * 100)));
        if (isNaN(progress)) progress = 0;

        let alertClass = 'info';
        let alertText = `${remainingDays}d left`;
        let barColor = 'var(--yt-spec-call-to-action, #065fd4)';

        if (remainingDays <= 0) {
            alertClass = 'critical';
            alertText = '\u26A0 Passed';
            barColor = '#e74c3c';
            progress = 100;
        } else if (progress >= 100) {
            alertClass = 'success';
            alertText = '\u2705 Done';
            barColor = '#2ecc71';
        } else if (remainingDays <= 3) {
            alertClass = 'warning';
            alertText = `\u26A0 ${remainingDays}d`;
            barColor = '#e67e22';
        }

        // Compact Grid logic for Mini View
        let gridHtml = '<div class="cd-mini-grid">';
        const displayDays = Math.min(totalDays, 25); // Limit to 25 dots for mini view
        for (let i = 0; i < displayDays; i++) {
            const dayDate = new Date(start);
            dayDate.setDate(dayDate.getDate() + i);
            const isDone = dayDate <= today;
            const isToday = i === passedDays;

            let dotClass = "cd-mini-dot";
            let dotContent = i + 1;
            if (isDone) {
                dotClass += " done";
                dotContent = "\u2713";
            } else if (isToday) {
                dotClass += " today";
            }
            gridHtml += `<div class="${dotClass}">${dotContent}</div>`;
        }
        if (totalDays > 25) {
            gridHtml += `<div class="cd-mini-dot-more">+${totalDays - 25}</div>`;
        }
        gridHtml += '</div>';

        container.innerHTML = `
            <div class="cd-mini-header" id="yt-notes-cd-header">
                <span class="cd-mini-title" title="${(cd.title || '').replace(/"/g, '&quot;')}">${cd.title || 'Goal'}</span>
                <button class="cd-mini-close" title="Close Overlay">\u00D7</button>
            </div>
            <div class="cd-mini-content">
                <div class="cd-mini-meta">
                    <span>${alertText}</span>
                    <div class="cd-mini-progress-section">
                        <span>${progress}%</span>
                    </div>
                </div>
                <div class="cd-progress-track">
                    <div class="cd-progress-fill" style="width: ${progress}%; background-color: ${barColor}"></div>
                </div>
                ${gridHtml}
            </div>
        `;

        container.querySelector('.cd-mini-close').onclick = () => {
            const keys = ['activeCountdownMiniView', 'activeCountdownMiniViewPos'];
            if (Number.isInteger(this.myTabId)) {
                keys.push(
                    `activeCountdownMiniView:${this.myTabId}`,
                    `activeCountdownMiniViewPos:${this.myTabId}`
                );
            }
            chrome.storage.local.remove(keys);
        };

        const header = container.querySelector('#yt-notes-cd-header');
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let xOffset = pos?.x || 0;
        let yOffset = pos?.y || 0;

        const dragStart = (e) => {
            if (e.target.closest('.cd-mini-close')) return;
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            isDragging = true;
        };

        const dragEnd = () => {
            if (!isDragging) return;
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
            if (Number.isInteger(this.myTabId)) {
                chrome.storage.local.set({
                    [`activeCountdownMiniViewPos:${this.myTabId}`]: { x: currentX, y: currentY },
                    activeCountdownMiniViewPos: { x: currentX, y: currentY }
                });
            } else {
                chrome.storage.local.set({ activeCountdownMiniViewPos: { x: currentX, y: currentY } });
            }
        };

        const drag = (e) => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                xOffset = currentX;
                yOffset = currentY;
                container.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
            }
        };

        header.addEventListener('mousedown', dragStart);
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('mousemove', drag);

        this._miniViewDragCleanup = () => {
            header.removeEventListener('mousedown', dragStart);
            document.removeEventListener('mouseup', dragEnd);
            document.removeEventListener('mousemove', drag);
        };

        document.body.appendChild(container);
    }
}

// Helper for transcript timing - uses shared TimeUtils.formatTime() for consistency
// Note: TimeUtils is loaded from utils/time.js via manifest.json content_scripts
const formatTimeHelper = (typeof TimeUtils !== 'undefined' && TimeUtils.formatTime) 
    ? TimeUtils.formatTime 
    : function(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

(function bootstrapYouTubeController() {
    const key = '__ytNotesController__';
    const existing = window[key];
    if (existing && typeof existing.destroy === 'function') {
        try {
            existing.destroy();
        } catch (e) {
            console.debug('[ContentScript] Failed to destroy existing controller:', e);
        }
    }
    window[key] = new YouTubeNotesContent();
})();

})();
