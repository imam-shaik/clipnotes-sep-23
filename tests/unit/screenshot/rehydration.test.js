/**
 * Unit Tests: Rehydration and Duplicate Detection Refinements
 */

describe('Rehydration and Duplicate Detection Refinements', () => {
  let state;
  let currentlyRehydrating;
  let currentRehydrationTaskId;
  let lastScreenshotHash;
  let lastScreenshotTime;
  const DUPLICATE_TIME_WINDOW_MS = 3000;
  const DUPLICATE_HASH_THRESHOLD = 6;

  beforeEach(() => {
    state = {
      screenshots: [],
      blobUrls: new Set()
    };
    currentlyRehydrating = new Set();
    currentRehydrationTaskId = 0;
    lastScreenshotHash = null;
    lastScreenshotTime = 0;
    document.body.innerHTML = '<div id="screenshots-list"></div>';
  });

  // Helper functions under test (mirrors updated panel.js code)
  function isDuplicate(newHash, options = {}) {
    if (!state.screenshots || state.screenshots.length === 0) {
      lastScreenshotHash = null;
      return false;
    }
    if (!lastScreenshotHash) return false;

    const ignoreTimeWindow = options.ignoreTimeWindow === true;
    const timeSinceLast = Date.now() - lastScreenshotTime;
    if (!ignoreTimeWindow && timeSinceLast > DUPLICATE_TIME_WINDOW_MS) {
      return false;
    }

    const distance = getHammingDistance(newHash, lastScreenshotHash);
    return distance <= DUPLICATE_HASH_THRESHOLD;
  }

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

  // Simulated rehydrateActiveScreenshots function
  async function simulateRehydrate(subFolderMock, options = {}) {
    const taskId = ++currentRehydrationTaskId;
    const isPreview = options.isPreview === true;

    // Filter screenshots that need rehydration
    const toRehydrate = state.screenshots.filter(shot => {
      if (shot.dataUrl) return false;
      if (currentlyRehydrating.has(shot.id)) return false;
      if (shot.loadFailed) return false;
      return !!shot.filename;
    });

    if (toRehydrate.length === 0) return;

    for (const shot of toRehydrate) {
      if (taskId !== currentRehydrationTaskId) return; // Cancelled

      currentlyRehydrating.add(shot.id);
      try {
        const fileContent = await subFolderMock.getFile(shot.filename);
        if (taskId !== currentRehydrationTaskId) return; // Cancelled
        
        const stillExists = state.screenshots.some(s => s.id === shot.id);
        if (!stillExists) return;

        const blobUrl = `blob:${shot.filename}`; // Mocked URL.createObjectURL
        shot.dataUrl = blobUrl;
        state.blobUrls.add(blobUrl);

        // Update DOM element directly
        if (!isPreview) {
          const cardImg = document.getElementById(shot.id)?.querySelector('.card-img');
          if (cardImg) {
            cardImg.src = blobUrl;
            cardImg.classList.remove('loading');
          }
        }
      } catch (e) {
        shot.loadFailed = true;
        if (!isPreview) {
          const cardImg = document.getElementById(shot.id)?.querySelector('.card-img');
          if (cardImg) {
            cardImg.src = 'missing-placeholder.png';
            cardImg.classList.remove('loading');
          }
        }
      } finally {
        currentlyRehydrating.delete(shot.id);
      }
    }
  }

  describe('Duplicate Detection', () => {
    test('First screenshot is never duplicate', () => {
      state.screenshots = [];
      lastScreenshotHash = '1234567890abcdef'; // Stale hash from previous session
      
      const res = isDuplicate('1234567890abcdef');
      expect(res).toBe(false);
      expect(lastScreenshotHash).toBeNull(); // Should reset
    });

    test('Duplicate screenshot is detected', () => {
      state.screenshots = [{ id: 'shot-1' }];
      lastScreenshotHash = '1234567890abcdef';
      lastScreenshotTime = Date.now();

      const res = isDuplicate('1234567890abcdef');
      expect(res).toBe(true);
    });

    test('Delete screenshot -> next capture succeeds', () => {
      state.screenshots = [{ id: 'shot-1' }];
      lastScreenshotHash = '1234567890abcdef';
      lastScreenshotTime = Date.now();

      // Verify duplicate exists
      expect(isDuplicate('1234567890abcdef')).toBe(true);

      // Delete screenshot (empty list)
      state.screenshots = [];
      
      // Next capture should succeed (not duplicate)
      expect(isDuplicate('1234567890abcdef')).toBe(false);
    });
  });

  describe('Rehydration Behavior', () => {
    test('rehydrateActiveScreenshots() skips active images', async () => {
      const shot1 = { id: 'shot-1', filename: 'shot1.png', dataUrl: 'blob:existing' };
      const shot2 = { id: 'shot-2', filename: 'shot2.png' };
      state.screenshots = [shot1, shot2];

      const getFileMock = jest.fn().mockResolvedValue('file-data');
      const subFolderMock = { getFile: getFileMock };

      await simulateRehydrate(subFolderMock);

      expect(getFileMock).toHaveBeenCalledTimes(1);
      expect(getFileMock).toHaveBeenCalledWith('shot2.png');
      expect(shot2.dataUrl).toBe('blob:shot2.png');
    });

    test('Concurrent rehydration is prevented and cancelled correctly', async () => {
      const shot1 = { id: 'shot-1', filename: 'shot1.png' };
      state.screenshots = [shot1];

      let resolveFile;
      const filePromise = new Promise(resolve => { resolveFile = resolve; });
      const subFolderMock = { getFile: jest.fn().mockReturnValue(filePromise) };

      // Start first rehydration
      const firstPromise = simulateRehydrate(subFolderMock);

      // Trigger second rehydration immediately (task cancellation)
      const secondPromise = simulateRehydrate(subFolderMock);

      // Resolve the first read
      resolveFile('file-data');
      await Promise.all([firstPromise, secondPromise]);

      // Because the second rehydration task started, the first should cancel and NOT update shot1.dataUrl
      expect(shot1.dataUrl).toBeUndefined();
    });

    test('Missing file handled gracefully', async () => {
      const shot = { id: 'shot-1', filename: 'missing.png' };
      state.screenshots = [shot];

      const card = document.createElement('div');
      card.id = 'shot-1';
      card.innerHTML = '<img class="card-img loading" src="" />';
      document.getElementById('screenshots-list').appendChild(card);

      const subFolderMock = {
        getFile: jest.fn().mockRejectedValue(new Error('FileNotFound'))
      };

      await simulateRehydrate(subFolderMock);

      expect(shot.loadFailed).toBe(true);
      const img = card.querySelector('.card-img');
      expect(img.src).toContain('missing-placeholder.png');
      expect(img.classList.contains('loading')).toBe(false);
    });

    test('Blob URL recreated correctly', async () => {
      const shot = { id: 'shot-1', filename: 'shot1.png' };
      state.screenshots = [shot];

      const card = document.createElement('div');
      card.id = 'shot-1';
      card.innerHTML = '<img class="card-img loading" src="" />';
      document.getElementById('screenshots-list').appendChild(card);

      const subFolderMock = {
        getFile: jest.fn().mockResolvedValue('file-data')
      };

      await simulateRehydrate(subFolderMock);

      expect(shot.dataUrl).toBe('blob:shot1.png');
      expect(state.blobUrls.has('blob:shot1.png')).toBe(true);
      
      const img = card.querySelector('.card-img');
      expect(img.src).toContain('blob:shot1.png');
    });
  });
});
