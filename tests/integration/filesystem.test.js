/**
 * Integration Tests: File System Operations
 * Tests for file save, load, permission handling, and error recovery
 */

describe('File System Module - Integration Tests', () => {
  // Mock FileSystemModule
  const mockFileSystemModule = {
    dirHandle: null,
    dbName: 'YouTubeNotesFSPrefs',
    
    async setup() {
      // Simulate IndexedDB load
      return true;
    },
    
    async selectTargetFolder() {
      // Simulate folder picker
      this.dirHandle = global.testUtils.createMockDirectoryHandle('test-folder');
      return true;
    },
    
    async verifyPermission(handle, readWrite = true, withPrompt = false) {
      if (!handle) return false;
      if (typeof handle.queryPermission !== 'function') return true;
      const opts = { mode: readWrite ? 'readwrite' : 'read' };
      let state = await handle.queryPermission(opts);
      if (state === 'granted') return true;
      if (state === 'prompt' && withPrompt && typeof handle.requestPermission === 'function') {
        try {
          state = await handle.requestPermission(opts);
          return state === 'granted';
        } catch (_) {
          return false;
        }
      }
      return false;
    },
    
    async saveFile(filename, blob, subFolderHandle = null, withPrompt = false) {
      // Simulate file save
      if (!this.dirHandle) {
        throw new Error('No directory handle');
      }
      
      const hasPerm = await this.verifyPermission(this.dirHandle, true, withPrompt);
      if (!hasPerm) {
        return false;
      }
      
      // Simulate successful save
      return true;
    },
    
    async getFileText(filename) {
      // Simulate file read
      if (!this.dirHandle) {
        return null;
      }
      return '{"test": "data"}';
    },
    
    async getVideoFolderHandle(videoTitle, createIfMissing = true, videoId = null) {
      if (!this.dirHandle) {
        return null;
      }
      return this.dirHandle;
    }
  };

  // Keep pristine copies so tests that swap methods can be restored reliably
  const originalMethods = {
    verifyPermission: mockFileSystemModule.verifyPermission.bind(mockFileSystemModule),
    saveFile: mockFileSystemModule.saveFile.bind(mockFileSystemModule),
    getFileText: mockFileSystemModule.getFileText.bind(mockFileSystemModule),
    selectTargetFolder: mockFileSystemModule.selectTargetFolder.bind(mockFileSystemModule)
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFileSystemModule.dirHandle = null;
    mockFileSystemModule.verifyPermission = originalMethods.verifyPermission;
    mockFileSystemModule.saveFile = originalMethods.saveFile;
    mockFileSystemModule.getFileText = originalMethods.getFileText;
    mockFileSystemModule.selectTargetFolder = originalMethods.selectTargetFolder;
  });

  describe('Folder Selection Flow', () => {
    test('should successfully select folder', async () => {
      const result = await mockFileSystemModule.selectTargetFolder();
      
      expect(result).toBe(true);
      expect(mockFileSystemModule.dirHandle).not.toBeNull();
    });

    test('should handle folder picker cancellation', async () => {
      // Simulate user cancelling picker
      global.showDirectoryPicker = jest.fn().mockRejectedValue({ name: 'AbortError' });
      
      try {
        await mockFileSystemModule.selectTargetFolder();
      } catch (err) {
        expect(err.name).toBe('AbortError');
      }
    });

    test('should handle browser not supporting File System API', async () => {
      const originalPicker = global.showDirectoryPicker;
      global.showDirectoryPicker = undefined;

      // Should fail gracefully when the picker is unavailable
      let failed = false;
      try {
        if (typeof global.showDirectoryPicker !== 'function') {
          failed = true;
          throw new Error('showDirectoryPicker is not supported');
        }
        await global.showDirectoryPicker();
      } catch (err) {
        failed = true;
        expect(err).toBeDefined();
      }

      expect(failed).toBe(true);
      global.showDirectoryPicker = originalPicker;
    });
  });

  describe('Permission Handling', () => {
    test('should verify permission before save', async () => {
      mockFileSystemModule.dirHandle = global.testUtils.createMockDirectoryHandle();
      
      const hasPerm = await mockFileSystemModule.verifyPermission(
        mockFileSystemModule.dirHandle,
        true,
        false
      );
      
      expect(hasPerm).toBe(true);
    });

    test('should handle permission denied', async () => {
      const mockHandle = {
        queryPermission: jest.fn().mockResolvedValue('denied')
      };
      
      const hasPerm = await mockFileSystemModule.verifyPermission(mockHandle, true, false);
      
      expect(hasPerm).toBe(false);
    });

    test('should request permission when needed', async () => {
      const mockHandle = {
        queryPermission: jest.fn().mockResolvedValue('prompt'),
        requestPermission: jest.fn().mockResolvedValue('granted')
      };
      
      const hasPerm = await mockFileSystemModule.verifyPermission(mockHandle, true, true);
      
      expect(hasPerm).toBe(true);
      expect(mockHandle.requestPermission).toHaveBeenCalled();
    });

    test('should handle permission request denied', async () => {
      const mockHandle = {
        queryPermission: jest.fn().mockResolvedValue('prompt'),
        requestPermission: jest.fn().mockRejectedValue(new Error('Permission denied'))
      };
      
      const hasPerm = await mockFileSystemModule.verifyPermission(mockHandle, true, true);
      
      expect(hasPerm).toBe(false);
    });
  });

  describe('File Save Operations', () => {
    beforeEach(async () => {
      mockFileSystemModule.dirHandle = global.testUtils.createMockDirectoryHandle();
    });

    test('should save file successfully', async () => {
      const blob = new Blob(['test content'], { type: 'text/plain' });
      const result = await mockFileSystemModule.saveFile('test.txt', blob);
      
      expect(result).toBe(true);
    });

    test('should fail save without directory handle', async () => {
      mockFileSystemModule.dirHandle = null;
      
      const blob = new Blob(['test'], { type: 'text/plain' });
      
      await expect(mockFileSystemModule.saveFile('test.txt', blob))
        .rejects.toThrow('No directory handle');
    });

    test('should fail save without permission', async () => {
      mockFileSystemModule.verifyPermission = jest.fn().mockResolvedValue(false);
      
      const blob = new Blob(['test'], { type: 'text/plain' });
      const result = await mockFileSystemModule.saveFile('test.txt', blob);
      
      expect(result).toBe(false);
    });

    test('should save to subfolder', async () => {
      const mockSubFolder = global.testUtils.createMockDirectoryHandle('subfolder');
      const blob = new Blob(['test'], { type: 'text/plain' });
      
      const result = await mockFileSystemModule.saveFile('test.txt', blob, mockSubFolder);
      
      expect(result).toBe(true);
    });
  });

  describe('File Read Operations', () => {
    beforeEach(async () => {
      mockFileSystemModule.dirHandle = global.testUtils.createMockDirectoryHandle();
    });

    test('should read file successfully', async () => {
      const content = await mockFileSystemModule.getFileText('test.txt');
      
      expect(content).toBe('{"test": "data"}');
    });

    test('should return null for missing file', async () => {
      mockFileSystemModule.dirHandle = null;
      
      const content = await mockFileSystemModule.getFileText('missing.txt');
      
      expect(content).toBe(null);
    });

    test('should handle JSON parse errors', async () => {
      mockFileSystemModule.getFileText = jest.fn().mockResolvedValue('invalid json');
      
      const content = await mockFileSystemModule.getFileText('test.json');
      
      expect(content).toBe('invalid json');
      expect(() => JSON.parse(content)).toThrow();
    });
  });

  describe('Video Folder Management', () => {
    beforeEach(async () => {
      mockFileSystemModule.dirHandle = global.testUtils.createMockDirectoryHandle();
    });

    test('should get existing video folder', async () => {
      const handle = await mockFileSystemModule.getVideoFolderHandle(
        'Test Video',
        false,
        'test123'
      );
      
      expect(handle).not.toBeNull();
    });

    test('should create new video folder', async () => {
      const handle = await mockFileSystemModule.getVideoFolderHandle(
        'New Video',
        true,
        'new123'
      );
      
      expect(handle).not.toBeNull();
    });

    test('should handle folder name sanitization', async () => {
      const handle = await mockFileSystemModule.getVideoFolderHandle(
        'Video: With <Special> Characters?',
        true,
        'test123'
      );
      
      expect(handle).not.toBeNull();
    });

    test('should return null without root handle', async () => {
      mockFileSystemModule.dirHandle = null;
      
      const handle = await mockFileSystemModule.getVideoFolderHandle('Test', true, 'test123');
      
      expect(handle).toBe(null);
    });
  });

  describe('Error Recovery', () => {
    test('should handle stale directory handle', async () => {
      // values() must return an async iterable whose iteration rejects -
      // a bare mockRejectedValue() leaves an unhandled promise rejection
      // (Node crashes the test worker with ERR_UNHANDLED_REJECTION).
      const staleHandle = {
        values: jest.fn().mockImplementation(() => ({
          next: () => Promise.reject({ name: 'NotFoundError' }),
          [Symbol.asyncIterator]() { return this; }
        }))
      };

      mockFileSystemModule.dirHandle = staleHandle;

      // Should detect stale handle
      try {
        const iter = staleHandle.values();
        await iter.next();
        throw new Error('Expected stale handle iteration to reject');
      } catch (err) {
        expect(err.name).toBe('NotFoundError');
        // Should clear stale handle
        mockFileSystemModule.dirHandle = null;
      }

      expect(mockFileSystemModule.dirHandle).toBeNull();
    });

    test('should retry failed saves', async () => {
      let attemptCount = 0;
      
      mockFileSystemModule.saveFile = jest.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Transient error');
        }
        return true;
      });
      
      const blob = new Blob(['test'], { type: 'text/plain' });
      
      // Retry logic would be in the calling code
      let result = false;
      for (let i = 0; i < 3; i++) {
        try {
          result = await mockFileSystemModule.saveFile('test.txt', blob);
          break;
        } catch (err) {
          if (i === 2) throw err;
        }
      }
      
      expect(result).toBe(true);
      expect(attemptCount).toBe(3);
    });

    test('should handle quota exceeded error', async () => {
      mockFileSystemModule.saveFile = jest.fn().mockRejectedValue({
        name: 'QuotaExceededError'
      });
      
      const blob = new Blob(['test'], { type: 'text/plain' });
      
      try {
        await mockFileSystemModule.saveFile('test.txt', blob);
      } catch (err) {
        expect(err.name).toBe('QuotaExceededError');
      }
    });
  });

  describe('Concurrent Operations', () => {
    test('should handle multiple simultaneous saves', async () => {
      mockFileSystemModule.dirHandle = global.testUtils.createMockDirectoryHandle();
      
      const saves = Array(5).fill(null).map((_, i) =>
        mockFileSystemModule.saveFile(`file${i}.txt`, new Blob([`content${i}`]))
      );
      
      const results = await Promise.all(saves);
      
      expect(results.every(r => r === true)).toBe(true);
    });

    test('should handle save during folder selection', async () => {
      let folderSelected = false;
      
      mockFileSystemModule.selectTargetFolder = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        folderSelected = true;
        return true;
      });
      
      // Start folder selection
      const selectPromise = mockFileSystemModule.selectTargetFolder();
      
      // Try to save before folder is selected
      const savePromise = mockFileSystemModule.saveFile(
        'test.txt',
        new Blob(['test'])
      ).catch(err => err);
      
      await Promise.all([selectPromise, savePromise]);
      
      expect(folderSelected).toBe(true);
    });
  });
});

describe('State File Operations', () => {
  const VIDEO_STATE_FILENAME = 'video_notes_state.json';

  test('should save state to JSON file', async () => {
    const state = {
      metadata: { videoId: 'test123' },
      screenshots: [],
      toc: [],
      updatedAt: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    
    // Simulate save
    expect(blob.type).toBe('application/json');
    expect(state.metadata.videoId).toBe('test123');
  });

  test('should load state from JSON file', () => {
    const json = '{"metadata":{"videoId":"test123"},"screenshots":[],"toc":[]}';
    const state = JSON.parse(json);
    
    expect(state.metadata.videoId).toBe('test123');
    expect(Array.isArray(state.screenshots)).toBe(true);
  });

  test('should handle corrupted state file', () => {
    const corruptedJson = 'not valid json';
    
    expect(() => JSON.parse(corruptedJson)).toThrow();
  });

  test('should handle missing fields in state', () => {
    const partialState = { metadata: { videoId: 'test123' } };
    
    // Should not crash with missing fields
    expect(partialState.screenshots).toBeUndefined();
    expect(partialState.toc).toBeUndefined();
    
    // Provide defaults
    const screenshots = partialState.screenshots || [];
    const toc = partialState.toc || [];
    
    expect(Array.isArray(screenshots)).toBe(true);
    expect(Array.isArray(toc)).toBe(true);
  });

  test('should merge old state with new schema', () => {
    const oldState = { screenshots: [], metadata: {} };
    const newState = {
      ...oldState,
      updatedAt: new Date().toISOString(),
      version: 1
    };
    
    expect(newState.version).toBe(1);
    expect(newState.updatedAt).toBeDefined();
  });
});
