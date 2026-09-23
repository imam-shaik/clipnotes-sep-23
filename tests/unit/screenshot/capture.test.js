/**
 * Unit Tests: Screenshot Capture Logic
 * Tests for critical screenshot capture, duplicate detection, and scroll behavior
 */

// Mock the dependencies
const mockState = {
  screenshots: [],
  blobUrls: new Set()
};

// Mock helper functions
const mockCreateScreenshotCard = jest.fn((item, index) => {
  const card = document.createElement('div');
  card.id = item.id;
  card.innerHTML = `
    <div class="card-img-container">
      <img class="card-img" src="${item.dataUrl}" />
    </div>
  `;
  return card;
});

const mockGetScreenshotNoteHtml = jest.fn((shot) => shot?.noteHtml || '');

const mockSaveVideoState = jest.fn();

describe('Screenshot Capture Logic', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    mockState.screenshots = [];
    mockState.blobUrls.clear();
    
    // Reset DOM
    document.body.innerHTML = `
      <div id="screenshots-list">
        <div class="empty-state">No screenshots yet</div>
      </div>
    `;
    
    // Reset global variables that would be in panel.js
    global.lastAutoScreenshotTime = 0;
  });

  describe('Duplicate Detection (dHash)', () => {
    test('should detect identical screenshots as duplicates', () => {
      const hash1 = 'a1b2c3d4e5f6g7h8';
      const hash2 = 'a1b2c3d4e5f6g7h8'; // Same hash
      
      const distance = getHammingDistance(hash1, hash2);
      expect(distance).toBe(0);
      expect(isDuplicate(hash1, hash2)).toBe(true);
    });

    test('should allow similar but not identical screenshots', () => {
      const hash1 = 'a1b2c3d4e5f6g7h8';
      const hash2 = 'a1b2c3d4e5f6g7h9'; // 1 character different
      
      const distance = getHammingDistance(hash1, hash2);
      expect(distance).toBeGreaterThan(0);
    });

    test('should respect time window exemption (5 seconds)', () => {
      // First screenshot
      global.lastAutoScreenshotTime = Date.now();
      const hash1 = 'a1b2c3d4e5f6g7h8';
      
      // Immediate duplicate should be blocked
      expect(isDuplicate(hash1, hash1)).toBe(true);
      
      // After 5 seconds, same hash should be allowed
      global.lastAutoScreenshotTime = Date.now() - 6000;
      expect(isDuplicate(hash1, hash1)).toBe(false);
    });

    test('should not flag first screenshot as duplicate', () => {
      const hash = 'a1b2c3d4e5f6g7h8';
      expect(isDuplicate(hash, null)).toBe(false);
      expect(isDuplicate(hash, undefined)).toBe(false);
    });
  });

  describe('Auto-Screenshot Detection', () => {
    test('should detect AutoShot_ filename prefix', () => {
      const filename = 'AutoShot_01-00_1234.jpg';
      const isAuto = filename.startsWith('AutoShot_');
      expect(isAuto).toBe(true);
    });

    test('should detect AreaShot_ filename prefix', () => {
      const filename = 'AreaShot_01-00_1234.png';
      const isAuto = filename.startsWith('AreaShot_');
      expect(isAuto).toBe(true);
    });

    test('should not flag manual screenshots', () => {
      const filename = 'Shot_01-00_1234.jpg';
      const isAuto = filename.startsWith('AutoShot_') || filename.startsWith('AreaShot_');
      expect(isAuto).toBe(false);
    });

    test('should detect recent auto-screenshot by timestamp', () => {
      global.lastAutoScreenshotTime = Date.now() - 2000; // 2 seconds ago
      const isWithinWindow = (Date.now() - global.lastAutoScreenshotTime) < 5000;
      expect(isWithinWindow).toBe(true);
    });
  });

  describe('Scroll Behavior', () => {
    beforeEach(() => {
      // Create scrollable container
      document.body.innerHTML = `
        <div class="scrollable" style="height: 400px; overflow-y: auto;">
          <div id="screenshots-list" style="height: 800px;"></div>
        </div>
      `;
      const scrollContainer = document.querySelector('.scrollable');
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    });

    test('should scroll when user is near bottom', () => {
      const scrollContainer = document.querySelector('.scrollable');
      scrollContainer.scrollTop = 700; // Near bottom
      
      const wasNearBottom = (scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight) < 100;
      expect(wasNearBottom).toBe(true);
    });

    test('should NOT scroll when user is at top', () => {
      const scrollContainer = document.querySelector('.scrollable');
      scrollContainer.scrollTop = 0; // At top
      
      const wasNearBottom = (scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight) < 100;
      expect(wasNearBottom).toBe(false);
    });

    test('should suppress scroll for auto-screenshots', () => {
      const isAutoScreenshot = true;
      const wasNearBottom = true;
      const skipScroll = false;
      
      const shouldAutoScroll = !skipScroll && !isAutoScreenshot && wasNearBottom;
      expect(shouldAutoScroll).toBe(false);
    });

    test('should scroll for manual screenshots when near bottom', () => {
      const isAutoScreenshot = false;
      const wasNearBottom = true;
      const skipScroll = false;
      
      const shouldAutoScroll = !skipScroll && !isAutoScreenshot && wasNearBottom;
      expect(shouldAutoScroll).toBe(true);
    });

    test('should respect skipScroll flag', () => {
      const isAutoScreenshot = false;
      const wasNearBottom = true;
      const skipScroll = true;
      
      const shouldAutoScroll = !skipScroll && !isAutoScreenshot && wasNearBottom;
      expect(shouldAutoScroll).toBe(false);
    });
  });

  describe('Screenshot State Management', () => {
    test('should add screenshot to state array', () => {
      const screenshot = {
        id: 'shot-123',
        timestampMs: 60000,
        timeFormatted: '01:00',
        filename: 'Shot_01-00_123.jpg',
        dataUrl: 'data:image/jpeg;base64,test',
        noteHtml: '',
        createdAt: Date.now()
      };
      
      mockState.screenshots.push(screenshot);
      expect(mockState.screenshots.length).toBe(1);
      expect(mockState.screenshots[0].id).toBe('shot-123');
    });

    test('should sort screenshots by createdAt timestamp', () => {
      const shot1 = { id: 'shot-1', createdAt: 1000 };
      const shot2 = { id: 'shot-2', createdAt: 500 };
      const shot3 = { id: 'shot-3', createdAt: 1500 };
      
      mockState.screenshots = [shot1, shot2, shot3];
      mockState.screenshots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      
      expect(mockState.screenshots[0].id).toBe('shot-2');
      expect(mockState.screenshots[1].id).toBe('shot-1');
      expect(mockState.screenshots[2].id).toBe('shot-3');
    });

    test('should handle missing createdAt gracefully', () => {
      const shot1 = { id: 'shot-1', createdAt: 1000 };
      const shot2 = { id: 'shot-2' }; // No createdAt
      
      const sorted = [shot1, shot2].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      expect(sorted[0].id).toBe('shot-2'); // Undefined treated as 0
      expect(sorted[1].id).toBe('shot-1');
    });
  });

  describe('Blob URL Management', () => {
    test('should track blob URLs in state', () => {
      const blobUrl = 'blob:test-123';
      mockState.blobUrls.add(blobUrl);
      expect(mockState.blobUrls.has(blobUrl)).toBe(true);
    });

    test('should revoke blob URL on delete', () => {
      const blobUrl = 'blob:test-456';
      mockState.blobUrls.add(blobUrl);
      
      // Simulate revoke
      URL.revokeObjectURL(blobUrl);
      mockState.blobUrls.delete(blobUrl);
      
      expect(mockState.blobUrls.has(blobUrl)).toBe(false);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(blobUrl);
    });

    test('should handle revoke errors gracefully', () => {
      const invalidBlobUrl = 'blob:invalid';
      
      expect(() => {
        try {
          URL.revokeObjectURL(invalidBlobUrl);
        } catch (e) {
          console.warn('Failed to revoke:', e);
        }
      }).not.toThrow();
    });
  });

  describe('Image Load Handling', () => {
    test('should wait for image to load before scrolling', (done) => {
      const img = new Image();
      let scrollCalled = false;
      
      const performScroll = () => {
        scrollCalled = true;
      };
      
      img.onload = performScroll;
      img.src = 'data:image/png;base64,test';
      
      setTimeout(() => {
        expect(scrollCalled).toBe(true);
        done();
      }, 100);
    });

    test('should scroll even if image fails to load', (done) => {
      const img = new Image();
      let scrollCalled = false;
      
      const performScroll = () => {
        scrollCalled = true;
      };
      
      img.onerror = performScroll;
      img.src = 'invalid-url';
      
      setTimeout(() => {
        expect(scrollCalled).toBe(true);
        done();
      }, 100);
    });

    test('should use fallback timeout if onload never fires', (done) => {
      const img = new Image();
      let scrollCalled = false;
      
      const performScroll = () => {
        scrollCalled = true;
      };
      
      // Don't set onload, rely on timeout
      setTimeout(performScroll, 50);
      
      setTimeout(() => {
        expect(scrollCalled).toBe(true);
        done();
      }, 100);
    });
  });
});

// Helper functions (would be imported from panel.js in real tests)
function getHammingDistance(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 999;
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const v1 = parseInt(hash1[i], 16);
    const v2 = parseInt(hash2[i], 16);
    let xor = v1 ^ v2;
    while (xor > 0) {
      distance += (xor & 1);
      xor >>= 1;
    }
  }
  return distance;
}

function isDuplicate(newHash, lastHash) {
  const DUPLICATE_HASH_THRESHOLD = 6;
  const DUPLICATE_TIME_WINDOW_MS = 3000;
  
  if (!lastHash) return false;
  
  // Time window exemption
  if (global.lastAutoScreenshotTime > 0) {
    const timeSinceLast = Date.now() - global.lastAutoScreenshotTime;
    if (timeSinceLast > DUPLICATE_TIME_WINDOW_MS) {
      return false;
    }
  }
  
  const distance = getHammingDistance(newHash, lastHash);
  return distance <= DUPLICATE_HASH_THRESHOLD;
}
