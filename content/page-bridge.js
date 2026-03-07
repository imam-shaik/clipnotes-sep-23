// content/page-bridge.js
// Runs in MAIN world to safely read YouTube page globals.

(function () {
    const MAX_TRACKED_TIMEDTEXT_URLS = 80;
    // url -> { ts: eviction score, hasPot: boolean, seenAt: timestamp }
    const timedtextUrlMap = new Map();

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

    // KEY FIX: Store whether URL has pot token; pot-bearing URLs get a priority boost
    function rememberTimedtextUrl(inputUrl) {
        if (!inputUrl) return;
        try {
            const url = new URL(inputUrl, window.location.origin);
            if (!url.pathname.includes('/api/timedtext')) return;

            const hasPot = url.searchParams.has('pot');
            const normalized = url.toString();
            const seenAt = Date.now();

            // pot-bearing URLs get a boost of 1e12 so they always outlast others
            const ts = hasPot ? seenAt + 1e12 : seenAt;
            timedtextUrlMap.set(normalized, { ts, hasPot, seenAt });

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

        // Sort: pot-bearing URLs first (highest ts), then by recency
        const allEntries = Array.from(timedtextUrlMap.entries())
            .sort((a, b) => b[1].ts - a[1].ts)
            .map(([url]) => url);

        if (!currentVideoId) return allEntries.slice(0, 20);

        const matchingVideoUrls = [];
        const recentNoVideoUrls = [];
        const now = Date.now();
        for (const raw of allEntries) {
            try {
                const url = new URL(raw);
                const vParam = url.searchParams.get('v');
                if (vParam === currentVideoId) {
                    matchingVideoUrls.push(raw);
                    continue;
                }
                // Some app/PWA requests may omit `v`; allow only very recent no-`v` URLs.
                if (!vParam) {
                    const meta = timedtextUrlMap.get(raw);
                    const age = now - Number(meta?.seenAt || 0);
                    if (Number.isFinite(age) && age <= 25000) {
                        recentNoVideoUrls.push(raw);
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
                    if (typeof firstArg === 'string') {
                        rememberTimedtextUrl(firstArg);
                    } else if (firstArg && typeof firstArg.url === 'string') {
                        rememberTimedtextUrl(firstArg.url);
                    }

                    const result = nativeFetch(...args);
                    Promise.resolve(result).then((response) => {
                        // Also capture the final response URL (after redirects)
                        if (response?.url) rememberTimedtextUrl(response.url);
                    }).catch(() => { });
                    return result;
                };
            }
        } catch (_) { }

        try {
            const nativeOpen = XMLHttpRequest.prototype.open;
            const nativeSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__ytNotesRequestUrl = url;
                rememberTimedtextUrl(url);
                return nativeOpen.call(this, method, url, ...rest);
            };

            XMLHttpRequest.prototype.send = function (...args) {
                this.addEventListener('loadend', () => {
                    rememberTimedtextUrl(this.responseURL || this.__ytNotesRequestUrl);
                }, { once: true });
                return nativeSend.apply(this, args);
            };
        } catch (_) { }

        try {
            if (typeof PerformanceObserver === 'function') {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry?.name) rememberTimedtextUrl(entry.name);
                    }
                });
                observer.observe({ type: 'resource', buffered: true });
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
            hasPotUrls: interceptedUrls.some(u => {
                try { return new URL(u).searchParams.has('pot'); } catch (_) { return false; }
            })
        };

        document.dispatchEvent(new CustomEvent('__yt_notes_player_response__', {
            detail: JSON.stringify(payload)
        }));
    });
})();
