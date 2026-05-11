# Auto Screenshot Frame Change Detection - Speed Adaptation Analysis

## Current Implementation Overview

### How Frame Change Detection Works

**Location:** `sidepanel/panel.js`

**Key Variables:**
- `autoScreenshotMode = 'frame'` - Frame change detection mode
- `autoScreenshotIntervalMs = 1500` - Fixed sampling interval (1.5 seconds)
- `lastAutoFrameHash` - Stores the perceptual hash (dHash) of the last captured frame
- `FRAME_CHANGE_HASH_THRESHOLD = 12` - Hamming distance threshold for detecting changes

**Flow:**
1. Every 1.5 seconds, the auto-screenshot loop runs (`startAutoScreenshot` function)
2. Captures current video frame and calculates dHash (perceptual hash)
3. Compares new hash with `lastAutoFrameHash` using Hamming distance
4. If distance > 12, captures screenshot and updates reference hash
5. If distance ≤ 12, skips capture (no significant change detected)

### Current Code (Lines 1410-1426)

```javascript
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
    const nextDelay = Math.max(0, autoScreenshotIntervalMs - elapsed);
    scheduleNext(nextDelay);
}, delayMs);
```

**Problem:** The sampling interval is **fixed at 1500ms** regardless of video playback speed.

---

## The Speed Problem

### Scenario Analysis

| Playback Speed | Video Content Speed | Fixed 1.5s Sampling | Result |
|---------------|---------------------|---------------------|---------|
| 1.0x | Normal | 1.5s real-time | ✅ Works as intended |
| 0.5x | Half speed | 1.5s real-time = 0.75s video content | ⚠️ Over-sampling (too frequent) |
| 2.0x | Double speed | 1.5s real-time = 3.0s video content | ❌ Under-sampling (misses changes) |
| 3.0x | Triple speed | 1.5s real-time = 4.5s video content | ❌ Severely under-sampling |

### Why This Matters

When video is played at **2x speed**:
- Content moves 2x faster through time
- A 1.5s real-time interval captures only every 3s of video content
- Rapid scene changes may be missed entirely
- Change detection becomes ineffective

When video is played at **0.5x speed**:
- Content moves slower
- A 1.5s real-time interval captures every 0.75s of video content
- May capture too many similar frames (inefficient)

---

## Solution Approaches

### Approach 1: Dynamic Interval Based on Playback Rate ⭐ RECOMMENDED

**Concept:** Adjust the sampling interval inversely proportional to playback speed.

**Formula:**
```
adjustedIntervalMs = baseIntervalMs / playbackRate
```

**Examples:**
- 1.0x speed: 1500ms / 1.0 = 1500ms (unchanged)
- 2.0x speed: 1500ms / 2.0 = 750ms (sample 2x faster)
- 3.0x speed: 1500ms / 3.0 = 500ms (sample 3x faster)
- 0.5x speed: 1500ms / 0.5 = 3000ms (sample 2x slower)

**Implementation:**
```javascript
// In startAutoScreenshot function
const BASE_FRAME_INTERVAL_MS = 1500;

async function getPlaybackRate() {
    try {
        const tab = await resolveTrackedYouTubeTab();
        if (!tab) return 1.0;
        const stateResponse = await sendMessageWithRetry(tab.id, { action: 'getState' }, 1, 0);
        return stateResponse?.playbackRate || 1.0;
    } catch (e) {
        return 1.0;
    }
}

function startAutoScreenshot(seconds, mode, btn) {
    // ... existing code ...
    
    const scheduleNext = async (delayMs) => {
        if (!autoScreenshotActive) return;
        
        // Get current playback rate for dynamic adjustment
        const playbackRate = await getPlaybackRate();
        const adjustedIntervalMs = BASE_FRAME_INTERVAL_MS / playbackRate;
        
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
            const nextDelay = Math.max(0, adjustedIntervalMs - elapsed);
            scheduleNext(nextDelay);
        }, delayMs);
    };
    
    scheduleNext(BASE_FRAME_INTERVAL_MS);
}
```

**Pros:**
- ✅ Maintains consistent "video content time" between samples
- ✅ Works at any playback speed
- ✅ Simple mathematical relationship
- ✅ No changes needed to hash comparison logic

**Cons:**
- ⚠️ Requires async playback rate fetch on each iteration
- ⚠️ May cause jitter if playback rate changes frequently

---

### Approach 2: Cached Playback Rate with Periodic Refresh

**Concept:** Cache the playback rate and refresh it periodically (e.g., every 5-10 seconds).

**Implementation:**
```javascript
let cachedPlaybackRate = 1.0;
let lastPlaybackRateFetch = 0;
const PLAYBACK_RATE_CACHE_MS = 5000; // Refresh every 5 seconds

async function getCachedPlaybackRate() {
    if (Date.now() - lastPlaybackRateFetch > PLAYBACK_RATE_CACHE_MS) {
        const rate = await getPlaybackRate();
        cachedPlaybackRate = rate;
        lastPlaybackRateFetch = Date.now();
    }
    return cachedPlaybackRate;
}
```

**Pros:**
- ✅ Reduces async overhead
- ✅ Smoother interval timing
- ✅ Good balance of accuracy and performance

**Cons:**
- ⚠️ Slight delay when user changes playback speed
- ⚠️ Additional state to manage

---

### Approach 3: Event-Driven Playback Rate Updates

**Concept:** Listen for playback rate changes and update interval immediately.

**Implementation:**
```javascript
let currentPlaybackRate = 1.0;
let autoScreenshotTimerId = null;

async function updateAutoScreenshotInterval() {
    if (!autoScreenshotActive || autoScreenshotMode !== 'frame') return;
    
    const rate = await getPlaybackRate();
    currentPlaybackRate = rate;
    const adjustedInterval = BASE_FRAME_INTERVAL_MS / rate;
    
    // Reschedule timer with new interval
    if (autoScreenshotTimerId) {
        clearTimeout(autoScreenshotTimerId);
    }
    scheduleNext(adjustedInterval);
}

// Listen for rate changes from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PLAYBACK_RATE_CHANGED' && autoScreenshotActive) {
        currentPlaybackRate = message.playbackRate;
        updateAutoScreenshotInterval();
    }
});
```

**Content Script Enhancement:**
```javascript
// In content-script.js, monitor playback rate changes
let lastPlaybackRate = 1.0;
setInterval(() => {
    if (video && video.playbackRate !== lastPlaybackRate) {
        lastPlaybackRate = video.playbackRate;
        chrome.runtime.sendMessage({
            type: 'PLAYBACK_RATE_CHANGED',
            playbackRate: video.playbackRate
        });
    }
}, 500);
```

**Pros:**
- ✅ Immediate response to speed changes
- ✅ No polling overhead
- ✅ Most efficient approach

**Cons:**
- ⚠️ Requires content script modifications
- ⚠️ More complex architecture
- ⚠️ Potential race conditions during rescheduling

---

### Approach 4: Adaptive Hash Threshold

**Concept:** Instead of changing the interval, adjust the sensitivity of change detection based on speed.

**Implementation:**
```javascript
// At higher speeds, reduce threshold to be more sensitive
const BASE_THRESHOLD = 12;
const adjustedThreshold = BASE_THRESHOLD / Math.sqrt(playbackRate);

// In handleCapture:
if (sampleDistance <= adjustedThreshold) {
    // Skip
}
```

**Pros:**
- ✅ No timing changes needed
- ✅ Simpler implementation

**Cons:**
- ❌ Doesn't actually capture more frames at high speed
- ❌ May become too sensitive (capture noise)
- ❌ Mathematical relationship is unclear

---

## Recommended Implementation Strategy

### Phase 1: Approach 2 (Cached Playback Rate)

**Reason:** Best balance of simplicity, performance, and user experience.

**Steps:**

1. **Add playback rate tracking variables** (panel.js, top scope):
```javascript
let cachedPlaybackRate = 1.0;
let lastPlaybackRateFetch = 0;
const PLAYBACK_RATE_CACHE_MS = 5000; // 5 seconds
const BASE_FRAME_INTERVAL_MS = 1500;
```

2. **Add helper function** (panel.js):
```javascript
async function getCachedPlaybackRate() {
    if (!autoScreenshotActive || autoScreenshotMode !== 'frame') {
        return 1.0;
    }
    
    if (Date.now() - lastPlaybackRateFetch > PLAYBACK_RATE_CACHE_MS) {
        try {
            const tab = await resolveTrackedYouTubeTab();
            if (tab) {
                const stateResponse = await sendMessageWithRetry(tab.id, { action: 'getState' }, 1, 0);
                if (stateResponse?.playbackRate) {
                    cachedPlaybackRate = stateResponse.playbackRate;
                    lastPlaybackRateFetch = Date.now();
                }
            }
        } catch (e) {
            console.debug('[AutoShot] Failed to fetch playback rate:', e);
        }
    }
    return cachedPlaybackRate;
}
```

3. **Modify startAutoScreenshot function** (panel.js, line ~1406):
```javascript
const scheduleNext = async (delayMs) => {
    if (!autoScreenshotActive) return;
    
    // Dynamic interval adjustment for frame mode
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

// Start loop
scheduleNext(autoScreenshotMode === 'frame' ? BASE_FRAME_INTERVAL_MS : autoScreenshotIntervalMs);
```

4. **Reset cache when stopping** (handleAutoScreenshotToggle, line ~1451):
```javascript
if (autoScreenshotInterval) {
    clearTimeout(autoScreenshotInterval);
    autoScreenshotInterval = null;
    autoScreenshotActive = false;
    lastAutoScreenshotTime = 0;
    lastAutoFrameHash = null;
    cachedPlaybackRate = 1.0;  // Reset cache
    lastPlaybackRateFetch = 0;  // Reset timer
    btn.classList.remove('primary');
    // ... rest of existing code
}
```

5. **Optional: Add logging** for debugging:
```javascript
console.log(`[AutoShot] Frame mode: sampling at ${playbackRate}x speed, interval: ${nextIntervalMs.toFixed(0)}ms`);
```

---

### Phase 2: User Feedback Enhancement

**Add playback speed indicator to UI:**

```javascript
// In updateTimeline function or similar
if (autoScreenshotActive && autoScreenshotMode === 'frame') {
    const speedIndicator = document.getElementById('auto-screenshot-speed-indicator');
    if (speedIndicator) {
        speedIndicator.textContent = `Sampling: ${(1500 / cachedPlaybackRate).toFixed(0)}ms (${cachedPlaybackRate}x)`;
    }
}
```

---

## Testing Strategy

### Test Scenarios

1. **Normal Speed (1.0x)**
   - Verify 1500ms interval
   - Confirm change detection works as before

2. **High Speed (2.0x, 2.5x, 3.0x)**
   - Verify interval decreases proportionally
   - Confirm more frequent captures during fast playback
   - Check console logs for interval values

3. **Low Speed (0.5x, 0.75x)**
   - Verify interval increases proportionally
   - Confirm fewer captures during slow playback

4. **Speed Changes During Auto-Screenshot**
   - Start at 1.0x, change to 2.0x mid-session
   - Verify interval adjusts within 5 seconds (cache refresh)

5. **Edge Cases**
   - Video paused (should not capture)
   - Video buffering (should handle gracefully)
   - Tab switched away (should respect visibilityState)

---

## Performance Considerations

### Overhead Analysis

| Operation | Cost | Frequency |
|-----------|------|-----------|
| `sendMessageWithRetry` | ~10-50ms | Every 5s (cache refresh) |
| Hash calculation | ~5-15ms | Every sample |
| Interval adjustment math | <1ms | Every sample |

**Total overhead:** ~1-2% CPU increase (negligible)

### Memory Impact
- 2 additional variables: `cachedPlaybackRate`, `lastPlaybackRateFetch`
- No significant memory increase

---

## Backward Compatibility

- ✅ Timer mode unchanged (uses fixed interval)
- ✅ Manual captures unchanged
- ✅ Existing hash threshold logic unchanged
- ✅ Default behavior (1.0x speed) identical to current

---

## Future Enhancements

1. **User-configurable base interval** (currently hardcoded 1500ms)
2. **Per-video speed profiles** (remember preferred settings)
3. **Smart threshold adjustment** (learn from user's keep/delete patterns)
4. **Motion vector analysis** (predict optimal sampling rate)

---

## Conclusion

**Recommendation:** Implement **Approach 2 (Cached Playback Rate)** for the following reasons:

1. ✅ Minimal code changes (50-70 lines)
2. ✅ No breaking changes to existing functionality
3. ✅ Good performance (cached rate reduces async overhead)
4. ✅ Responsive enough (5s cache refresh)
5. ✅ Solves the core problem: change detection speed matches video speed

**Estimated Implementation Time:** 2-3 hours (including testing)

**Risk Level:** Low (isolated change, easy to rollback)
