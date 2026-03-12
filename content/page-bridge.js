// content/page-bridge.js
// Runs in MAIN world to safely read YouTube page globals.

(function () {
    const pageBridgeGuardKey = '__YT_NOTES_PAGE_BRIDGE_READY__';
    if (window[pageBridgeGuardKey]) return;
    window[pageBridgeGuardKey] = true;

    const MAX_TRACKED_TIMEDTEXT_URLS = 80;
    // url -> { ts: eviction score, hasPot: boolean, seenAt: timestamp }
    const timedtextUrlMap = new Map();
    let lastVideoIdForMap = null;

    function parseMaybeJson(value) {
        if (!value) return null;
        if (typeof value === 'object') return value;
        if (typeof value !== 'string') return null;
        try {
            return JSON.parse(value);
        } catch (_) {
            return null;
        }
    }

    function getCurrentVideoId() {
        try {
            return new URLSearchParams(window.location.search).get('v');
        } catch (_) {
            return null;
        }
    }

    // KEY FIX: Store method, body, and actual response payload if captured.
    function rememberTimedtextUrl(inputUrl, method = 'GET', body = null) {
        if (!inputUrl) return;
        try {
            const url = new URL(inputUrl, window.location.origin);
            const isTimedtext = url.pathname.includes('/api/timedtext');
            const isGetTranscript = url.pathname.includes('/youtubei/v1/get_transcript');
            if (!isTimedtext && !isGetTranscript) return;

            // CLEAR MAP ON NEW VIDEO: If we see a new video ID, reset the map to prevent leaks
            const currentVid = getCurrentVideoId();
            if (currentVid && currentVid !== lastVideoIdForMap) {
                timedtextUrlMap.clear();
                lastVideoIdForMap = currentVid;
            }

            const hasPot = url.searchParams.has('pot') || (body && body.includes('"pot"'));
            const normalized = url.toString();
            const seenAt = Date.now();
            const existing = timedtextUrlMap.get(normalized);

            // pot-bearing URLs get a boost of 1e12
            const ts = hasPot ? seenAt + 1e12 : seenAt;

            timedtextUrlMap.set(normalized, {
                ts: Math.max(ts, existing?.ts || 0),
                hasPot: hasPot || !!existing?.hasPot,
                seenAt: existing?.seenAt || seenAt,
                method: method !== 'GET' ? method : (existing?.method || 'GET'),
                body: body || existing?.body || null,
                responseText: existing?.responseText || null
            });

            // Evict the lowest-priority entry if over limit
            if (timedtextUrlMap.size > MAX_TRACKED_TIMEDTEXT_URLS) {
                let oldestKey = null;
                let oldestTs = Infinity;
                for (const [key, meta] of timedtextUrlMap.entries()) {
                    if (meta.ts < oldestTs) {
                        oldestTs = meta.ts;
                        oldestKey = key;
                    }
                }
                if (oldestKey) timedtextUrlMap.delete(oldestKey);
            }
        } catch (_) { }
    }

    function seedTimedtextUrlsFromPerformance() {
        try {
            const entries = performance.getEntriesByType('resource');
            for (const entry of entries) {
                if (entry?.name) rememberTimedtextUrl(entry.name);
            }
        } catch (_) { }
    }

    function getObservedTimedtextUrlsForCurrentVideo() {
        seedTimedtextUrlsFromPerformance();
        const currentVideoId = getCurrentVideoId();

        // Sort: pot-bearing URLs or cached responses first (highest ts), then by recency
        const allEntries = Array.from(timedtextUrlMap.entries())
            .sort((a, b) => b[1].ts - a[1].ts)
            .map(([url, meta]) => ({
                url,
                method: meta.method || 'GET',
                body: meta.body || null,
                responseText: meta.responseText || null
            }));

        if (!currentVideoId) return allEntries.slice(0, 20);

        const matchingVideoUrls = [];
        const recentNoVideoUrls = [];
        const now = Date.now();
        for (const entry of allEntries) {
            try {
                const url = new URL(entry.url);
                const vParam = url.searchParams.get('v');
                if (vParam === currentVideoId) {
                    matchingVideoUrls.push(entry);
                    continue;
                }
                // Some app/PWA requests may omit `v`; allow only very recent no-`v` URLs.
                if (!vParam) {
                    const meta = timedtextUrlMap.get(entry.url);
                    const age = now - Number(meta?.seenAt || 0);
                    if (Number.isFinite(age) && age <= 25000) {
                        recentNoVideoUrls.push(entry);
                    }
                }
            } catch (_) { }
        }

        // Prefer strict current-video URLs; fallback to very recent no-`v` URLs only.
        if (matchingVideoUrls.length > 0) return matchingVideoUrls.slice(0, 20);
        return recentNoVideoUrls.slice(0, 20);
    }

    function getPlayerResponseCandidates() {
        const candidates = [];

        try {
            const fromYtPlayer = parseMaybeJson(window.ytplayer?.config?.args?.player_response);
            if (fromYtPlayer) candidates.push(fromYtPlayer);
        } catch (_) { }

        try {
            if (typeof window.ytcfg?.get === 'function') {
                const fromCfg = parseMaybeJson(window.ytcfg.get('PLAYER_RESPONSE'));
                if (fromCfg) candidates.push(fromCfg);
            }
        } catch (_) { }

        try {
            const fromCfgData = parseMaybeJson(window.ytcfg?.data_?.PLAYER_RESPONSE);
            if (fromCfgData) candidates.push(fromCfgData);
        } catch (_) { }

        try {
            if (window.ytInitialPlayerResponse) {
                candidates.push(window.ytInitialPlayerResponse);
            }
        } catch (_) { }

        return candidates.filter(Boolean);
    }

    function getResponseVideoId(playerResponse) {
        return playerResponse?.videoDetails?.videoId || null;
    }

    function getBestPlayerResponse() {
        const currentVideoId = getCurrentVideoId();
        const candidates = getPlayerResponseCandidates();
        if (!candidates.length) return null;

        if (currentVideoId) {
            const exactMatch = candidates.find(pr => getResponseVideoId(pr) === currentVideoId);
            if (exactMatch) return exactMatch;
        }

        const withCaptions = candidates.find(pr => {
            const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            return Array.isArray(tracks) && tracks.length > 0;
        });
        if (withCaptions) return withCaptions;

        const withVideoId = candidates.find(pr => !!getResponseVideoId(pr));
        if (withVideoId) return withVideoId;

        return candidates[0];
    }

    function hookFetchAndXhr() {
        try {
            if (typeof window.fetch === 'function') {
                const nativeFetch = window.fetch.bind(window);
                window.fetch = function (...args) {
                    const firstArg = args[0];
                    let urlStr = '';
                    let method = 'GET';
                    let body = null;

                    if (typeof firstArg === 'string') {
                        urlStr = firstArg;
                    } else if (firstArg && typeof firstArg.url === 'string') {
                        urlStr = firstArg.url;
                        method = firstArg.method || 'GET';
                    }

                    if (args[1]) {
                        method = args[1].method || method;
                        if (args[1].body && typeof args[1].body === 'string') {
                            body = args[1].body;
                        }
                    }

                    if (urlStr) rememberTimedtextUrl(urlStr, method, body);

                    const result = nativeFetch(...args);
                    Promise.resolve(result).then((response) => {
                        const resUrl = response?.url || urlStr;
                        // Capture the final response URL (after redirects)
                        if (resUrl) rememberTimedtextUrl(resUrl, method, body);

                        // Capture response text if it's a successful timedtext/transcript request
                        const isTranscriptApi = resUrl && (resUrl.includes('/api/timedtext') || resUrl.includes('/youtubei/v1/get_transcript'));
                        if (isTranscriptApi && response.ok) {
                            try {
                                response.clone().text().then(text => {
                                    if (text && text.trim().length > 0) {
                                        const meta = timedtextUrlMap.get(resUrl);
                                        if (meta) {
                                            meta.responseText = text;
                                            meta.ts = Date.now() + 2e12; // Massive boost for cached response
                                        }
                                    }
                                }).catch(() => { });
                            } catch (cloneErr) {
                                // Clone can fail if response is already used or stream is closed
                            }
                        }
                    }).catch(() => { });
                    return result;
                };
            }
        } catch (_) { }

        try {
            const nativeOpen = XMLHttpRequest.prototype.open;
            const nativeSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__ytNotesMethod = method;
                this.__ytNotesRequestUrl = url;
                return nativeOpen.call(this, method, url, ...rest);
            };

            XMLHttpRequest.prototype.send = function (...args) {
                let body = args[0];
                if (typeof body !== 'string') body = null;
                const method = this.__ytNotesMethod || 'GET';
                const url = this.__ytNotesRequestUrl;

                if (url) rememberTimedtextUrl(url, method, body);

                this.addEventListener('loadend', () => {
                    const finalUrl = this.responseURL || url;
                    if (finalUrl) rememberTimedtextUrl(finalUrl, method, body);

                    const isTranscriptApi = finalUrl && (finalUrl.includes('/api/timedtext') || finalUrl.includes('/youtubei/v1/get_transcript'));
                    if (isTranscriptApi && this.status === 200) {
                        const text = this.responseText;
                        if (text && text.trim().length > 0) {
                            const meta = timedtextUrlMap.get(finalUrl);
                            if (meta) {
                                meta.responseText = text;
                                meta.ts = Date.now() + 2e12; // massive boost
                            }
                        }
                    }
                }, { once: true });
                return nativeSend.apply(this, args);
            };
        } catch (_) { }

        try {
            if (typeof PerformanceObserver === 'function') {
                // Fix #13: Disconnect PerformanceObserver after initial load/discovery
                const observer = new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    for (const entry of entries) {
                        if (entry.name && (entry.name.includes('/api/timedtext') || entry.name.includes('/youtubei/v1/get_transcript'))) {
                            const url = entry.name;
                            if (!timedtextUrlMap.has(url)) {
                                timedtextUrlMap.set(url, { ts: Date.now(), seenAt: Date.now() });
                            }
                        }
                    }
                });
                observer.observe({ type: 'resource', buffered: true });

                // Disconnect after 30 seconds to prevent background overhead
                setTimeout(() => {
                    try { observer.disconnect(); } catch (_) { }
                }, 30000);
            }
        } catch (_) { }
    }

    hookFetchAndXhr();

    document.addEventListener('__yt_notes_get_player_response__', () => {
        const interceptedUrls = getObservedTimedtextUrlsForCurrentVideo();
        const playerResponse = getBestPlayerResponse();

        const payload = {
            playerResponse,
            // Intercepted URLs are preferred as they carry fresh pot tokens
            timedtextUrls: interceptedUrls,
            // Signal whether we have pot-bearing URLs available
            hasPotUrls: interceptedUrls.some((entry) => {
                const rawUrl = typeof entry === 'string' ? entry : entry?.url;
                if (!rawUrl) return false;
                try {
                    return new URL(rawUrl, window.location.origin).searchParams.has('pot');
                } catch (_) {
                    return false;
                }
            })
        };

        document.dispatchEvent(new CustomEvent('__yt_notes_player_response__', {
            detail: JSON.stringify(payload)
        }));
    });
})();
