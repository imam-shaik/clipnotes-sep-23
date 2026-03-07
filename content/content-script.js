// content/content-script.js

class YouTubeController {
    constructor() {
        this.video = null;
        this.videoId = this.extractVideoId();
        this.lastUrl = window.location.href;
        this.activationLauncher = null;
        this.notebookEnabled = false;
        this.isPanelOpen = false;
        this.panelStatePollTimer = null;
        this.storageListenerAttached = false;
        this.setupPlayerObserver();
        this.setupNavigationObserver();
        this.removeLegacyActivationPrompt();
        this.setupActivationLauncher();
        this.setupMessageListener();
        this.setupKeyboardShortcuts();
        console.log("YouTube Notes Extension: Content Script Initialized.");
    }

    // Request player + timedtext bridge data from the MAIN-world script.
    getBridgeData() {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 3000);
            document.addEventListener('__yt_notes_player_response__', function handler(e) {
                clearTimeout(timeout);
                document.removeEventListener('__yt_notes_player_response__', handler);
                try {
                    resolve(e.detail ? JSON.parse(e.detail) : null);
                } catch (err) {
                    resolve(null);
                }
            }, { once: true });
            document.dispatchEvent(new Event('__yt_notes_get_player_response__'));
        });
    }

    // High-frequency check for URL changes (SPA Navigation)
    setupNavigationObserver() {
        this._navInterval = setInterval(() => {
            // GUARD: Stop polling if the extension was reloaded/unloaded
            if (!chrome.runtime?.id) {
                clearInterval(this._navInterval);
                return;
            }
            const urlChanged = this.lastUrl !== window.location.href;
            if (urlChanged) {
                this.lastUrl = window.location.href;
                this.removeLegacyActivationPrompt();
                this.refreshActivationLauncherFromStorage();
                this.refreshPanelOpenState();
            }
            const newId = this.extractVideoId();
            if (newId && newId !== this.videoId) {
                console.log("YouTube Notes: Navigation detected via URL polling:", newId);
                this.videoId = newId;
                this.video = null;
                this.setupPlayerObserver();
                try {
                    chrome.runtime.sendMessage({ action: 'contentScriptReady', videoId: this.videoId }, () => {
                        if (chrome.runtime.lastError) { /* normal */ }
                    });
                } catch (e) { /* Extension context invalidated */ }
            }
        }, 200);
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
        this.startPanelStatePolling();
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
        if (this.storageListenerAttached || !chrome?.storage?.onChanged) return;
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            if (Object.prototype.hasOwnProperty.call(changes, 'ynNotebookEnabled')) {
                this.notebookEnabled = changes.ynNotebookEnabled?.newValue === true;
                this.setActivationLauncherVisible(true);
            }
        });
        this.storageListenerAttached = true;
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
            chrome.runtime.sendMessage({ action: 'openSidePanel' }, () => {
                if (!chrome.runtime.lastError) {
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

    startPanelStatePolling() {
        if (this.panelStatePollTimer) {
            clearInterval(this.panelStatePollTimer);
        }
        this.refreshPanelOpenState();
        this.panelStatePollTimer = setInterval(() => {
            this.refreshPanelOpenState();
        }, 1500);
    }

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
        if (!chrome.runtime?.id) return;
        chrome.storage.local.get(['ynNotebookEnabled'], (result) => {
            if (!chrome.runtime?.id || chrome.runtime.lastError) {
                this.setActivationLauncherVisible(true);
                return;
            }
            this.notebookEnabled = result?.ynNotebookEnabled === true;
            this.setActivationLauncherVisible(true);
        });
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
        // High frequency check until we find a stable video element
        this._playerInterval = setInterval(() => {
            const v = this.findVideoElement();
            if (v && v.videoWidth > 0) {
                // If we found a NEW video element (e.g. ad ended, or navigation)
                if (this.video !== v) {
                    console.log("YouTube Notes: New/Better video element detected:", v);
                    this.video = v;
                    this.onVideoFound();
                }
                // We keep polling at a slower rate to detect swaps (ads -> video)
                if (this._playerIntervalRate !== 2000) {
                    clearInterval(this._playerInterval);
                    this._playerIntervalRate = 2000;
                    this.setupPlayerObserver();
                }
            }
        }, this._playerIntervalRate || 500);
    }

    onVideoFound() {
        if (!chrome.runtime?.id) return;
        try {
            chrome.runtime.sendMessage({ action: 'contentScriptReady', videoId: this.videoId }, () => {
                if (chrome.runtime.lastError) { /* normal */ }
            });
        } catch (e) { /* Extension context invalidated */ }
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

    captureFrame() {
        // ALWAYS re-verify the best video element before capture to avoid ad-locks
        const currentV = this.findVideoElement();
        if (currentV) this.video = currentV;

        if (!this.video || this.video.videoWidth === 0) return null;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = this.video.videoWidth;
            canvas.height = this.video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/png', 0.95);
            if (dataUrl === "data:,") return null;
            return dataUrl;
        } catch (e) {
            console.error("Canvas capture failed:", e);
            return null;
        }
    }

    getVideoMetadata() {
        const currentId = this.extractVideoId();
        // Modern YouTube title selectors
        const titleEl = document.querySelector('ytd-watch-metadata h1, ytd-video-primary-info-renderer h1, #title h1, h1.ytd-video-primary-info-renderer, h1.title');
        const channelEl = document.querySelector('#channel-name a, ytd-channel-name a, #text-container.ytd-channel-name a');
        let title = titleEl?.textContent?.trim();
        if (!title || title === "" || title === "YouTube Video") {
            title = document.title.replace(' - YouTube', '').trim();
        }
        return {
            videoId: currentId || this.videoId,
            title: title || 'YouTube Video',
            channel: channelEl?.textContent?.trim() || 'Unknown Channel',
            url: window.location.href
        };
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'getState') {
                sendResponse(this.getState());
            } else if (message.action === 'seekTo') {
                this.seekToMs(message.timeMs);
                sendResponse({ success: true });
            } else if (message.action === 'captureScreenshot') {
                const imageData = this.captureFrame();
                if (!imageData) {
                    sendResponse({ success: false, error: "Canvas capture failed or blocked." });
                } else {
                    sendResponse({ success: true, imageData: imageData, ...this.getState() });
                }
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
            }
            return true;
        });
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

            const rect = selectionBox.getBoundingClientRect();
            document.body.removeChild(overlay);
            document.removeEventListener('keydown', onEsc);

            if (rect.width < 5 || rect.height < 5) {
                sendResponse({ success: false, error: "Selection too small." });
                return;
            }

            // Capture and Crop
            this.captureAndCrop(rect, sendResponse);
        };

        const onEsc = (e) => {
            if (e.key === 'Escape') {
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', onEsc);
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

            const dataUrl = canvas.toDataURL('image/png', 0.95);
            if (dataUrl === "data:,") {
                sendResponse({ success: false, error: "Crop failed." });
            } else {
                sendResponse({ success: true, imageData: dataUrl, ...this.getState() });
            }
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

    decodeHtmlEntities(text) {
        const el = document.createElement('textarea');
        el.innerHTML = text;
        return el.value;
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
        if (hint === 'json3') return this.parseJson3Transcript(trimmed);
        if (hint === 'srv3' || hint === 'srv2' || hint === 'srv1' || hint === 'ttml' || hint === 'xml') {
            return this.parseXmlTranscript(trimmed);
        }
        if (hint === 'vtt') return this.parseVttTranscript(trimmed);

        if (trimmed.startsWith('{')) {
            const jsonSegments = this.parseJson3Transcript(trimmed);
            if (jsonSegments.length) return jsonSegments;
        }
        if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
            const vttSegments = this.parseVttTranscript(trimmed);
            if (vttSegments.length) return vttSegments;
        }
        if (trimmed.startsWith('<')) {
            const xmlSegments = this.parseXmlTranscript(trimmed);
            if (xmlSegments.length) return xmlSegments;
        }

        // Last-resort parser attempts.
        const jsonFallback = this.parseJson3Transcript(trimmed);
        if (jsonFallback.length) return jsonFallback;
        const xmlFallback = this.parseXmlTranscript(trimmed);
        if (xmlFallback.length) return xmlFallback;
        const vttFallback = this.parseVttTranscript(trimmed);
        if (vttFallback.length) return vttFallback;
        return [];
    }

    prioritizeTimedtextUrls(urls, preferredLanguageCode = '') {
        const scored = [];
        const dedupe = new Set();
        const preferredBase = (preferredLanguageCode || '').split('-')[0].toLowerCase();

        for (const rawUrl of urls || []) {
            if (!rawUrl || dedupe.has(rawUrl)) continue;
            dedupe.add(rawUrl);

            let score = 0;
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
            } catch (_) { }

            scored.push({ rawUrl, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.map(item => item.rawUrl);
    }

    async fetchTranscriptFromDirectUrls(directUrls) {
        const failures = [];
        const requestQueue = [];
        const dedupe = new Set();

        for (const originalUrl of directUrls || []) {
            if (!originalUrl) continue;
            try {
                const original = new URL(originalUrl, window.location.origin);
                const originalFmt = original.searchParams.get('fmt') || '';
                const originalString = original.toString();
                if (!dedupe.has(originalString)) {
                    dedupe.add(originalString);
                    requestQueue.push({ url: originalString, fmtHint: originalFmt || '' });
                }

                for (const fmt of ['json3', 'srv3', 'vtt']) {
                    const variant = new URL(originalString);
                    variant.searchParams.set('fmt', fmt);
                    const variantString = variant.toString();
                    if (!dedupe.has(variantString)) {
                        dedupe.add(variantString);
                        requestQueue.push({ url: variantString, fmtHint: fmt });
                    }
                }
            } catch (_) {
                // Keep going for any malformed URL.
            }
        }

        for (const item of requestQueue) {
            try {
                const response = await fetch(item.url, {
                    credentials: 'include',
                    headers: { 'Accept': '*/*' }
                });
                if (!response.ok) {
                    failures.push(`direct: HTTP ${response.status}`);
                    continue;
                }

                const rawText = await response.text();
                if (!rawText || !rawText.trim()) {
                    failures.push('direct: empty response');
                    continue;
                }

                const segments = this.parseTranscriptPayload(rawText, item.fmtHint);
                if (segments.length > 0) {
                    return { segments, sourceFormat: item.fmtHint || 'direct' };
                }

                failures.push(`direct: parsed but no text (${item.fmtHint || 'unknown fmt'})`);
            } catch (err) {
                failures.push(`direct: ${err.message}`);
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

                if (segments.length > 0) {
                    return { segments, sourceFormat: fmt };
                }

                failures.push(`${fmt}: parsed but no text`);
            } catch (err) {
                failures.push(`${fmt}: ${err.message}`);
            }
        }

        return {
            segments: [],
            error: failures.length
                ? `Could not parse transcript from YouTube captions (${failures.join(' | ')}).`
                : 'Transcript content is unavailable.'
        };
    }

    // Extract transcript using internal YouTube player data.
    async getTranscript() {
        try {
            console.log("YouTube Notes: Fetching transcript via page bridge...");

            const bridgeData = await this.getBridgeData();
            const playerResponse = bridgeData?.playerResponse || null;
            const observedTimedtextUrls = Array.isArray(bridgeData?.timedtextUrls)
                ? bridgeData.timedtextUrls
                : [];
            const hasPotUrls = bridgeData?.hasPotUrls === true;

            console.log(`YouTube Notes: Bridge data received. Intercepted URLs: ${observedTimedtextUrls.length}, hasPot: ${hasPotUrls}`);

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
        window.addEventListener('keydown', (e) => {
            // Ignore if user is typing in an input/textarea/contenteditable
            const tag = document.activeElement?.tagName?.toLowerCase();
            const isEditable = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable;
            if (isEditable) return;

            const key = e.key.toLowerCase();
            if (key === 's' || key === 'z' || key === 't' || key === 'a') {
                // Prevent default specifically for these keys to avoid YouTube conflict
                if (key === 's' || key === 't' || key === 'a') e.preventDefault();

                console.log("YouTube Notes: Shortcut triggered globally:", key);
                if (!chrome.runtime?.id) return;
                try {
                    chrome.runtime.sendMessage({ action: 'shortcutPressed', key: key });
                } catch (e) { /* Extension context invalidated */ }
            }
        }, true); // Use capture phase
    }

}

// Helper for transcript timing
function formatTimeHelper(ms) {
    if (!ms || ms < 0) return "00:00";
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

const currentController = new YouTubeController();
