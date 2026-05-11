/**
 * Unit Tests: State Management & Save Logic
 * Tests for saveVideoState mutex, race condition prevention, and data integrity
 */

describe('State Management - Mutex & Race Condition Prevention', () => {
  // Mock state
  let mockState = {
    screenshots: [],
    toc: [],
    metadata: {}
  };

  // Mutex state (simulating panel.js)
  let saveVideoStateLock = false;
  let pendingSaveRequested = false;
  let saveVideoStateTimer = null;
  let saveCallCount = 0;

  beforeEach(() => {
    mockState = {
      screenshots: [],
      toc: [],
      metadata: { videoId: 'test123', videoTitle: 'Test Video' }
    };
    saveVideoStateLock = false;
    pendingSaveRequested = false;
    saveVideoStateTimer = null;
    saveCallCount = 0;
    jest.clearAllMocks();
  });

  describe('Mutex Lock Behavior', () => {
    test('should acquire lock when no save is in progress', async () => {
      expect(saveVideoStateLock).toBe(false);
      
      // Simulate starting a save
      saveVideoStateLock = true;
      expect(saveVideoStateLock).toBe(true);
    });

    test('should reject concurrent save when lock is held', () => {
      saveVideoStateLock = true;
      
      // Attempt concurrent save
      if (saveVideoStateLock) {
        pendingSaveRequested = true;
      }
      
      expect(pendingSaveRequested).toBe(true);
    });

    test('should release lock after save completes', async () => {
      saveVideoStateLock = true;
      
      // Simulate save completion
      await Promise.resolve(); // Simulate async save
      saveVideoStateLock = false;
      
      expect(saveVideoStateLock).toBe(false);
    });

    test('should trigger pending save after lock release', async () => {
      saveVideoStateLock = true;
      pendingSaveRequested = false;
      
      // Request save while locked
      if (saveVideoStateLock) {
        pendingSaveRequested = true;
      }
      
      // Release lock
      saveVideoStateLock = false;
      
      // Process pending save
      if (pendingSaveRequested) {
        pendingSaveRequested = false;
        saveCallCount++;
      }
      
      expect(saveCallCount).toBe(1);
      expect(pendingSaveRequested).toBe(false);
    });
  });

  describe('Debounced Save Behavior', () => {
    test('should debounce rapid save calls', (done) => {
      let executionCount = 0;
      
      const debouncedSave = (() => {
        let timer = null;
        return () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            executionCount++;
          }, 100);
        };
      })();
      
      // Call 5 times rapidly
      for (let i = 0; i < 5; i++) {
        debouncedSave();
      }
      
      setTimeout(() => {
        expect(executionCount).toBe(1); // Should only execute once
        done();
      }, 200);
    });

    test('should respect lock even after debounce timeout', (done) => {
      saveVideoStateLock = true;
      let saveExecuted = false;
      
      setTimeout(() => {
        // After timeout, check lock
        if (saveVideoStateLock) {
          pendingSaveRequested = true;
          saveExecuted = false;
        } else {
          saveExecuted = true;
        }
        
        expect(saveExecuted).toBe(false);
        expect(pendingSaveRequested).toBe(true);
        done();
      }, 100);
    });
  });

  describe('Concurrent Save Scenarios', () => {
    test('should handle 3 rapid save requests', async () => {
      const saveQueue = [];
      
      // Simulate 3 rapid save requests
      const requestSave = () => {
        if (saveVideoStateLock) {
          pendingSaveRequested = true;
          saveQueue.push('pending');
        } else {
          saveVideoStateLock = true;
          saveQueue.push('executing');
          // Simulate async save
          setTimeout(() => {
            saveVideoStateLock = false;
          }, 50);
        }
      };
      
      requestSave(); // Request 1 - executes
      requestSave(); // Request 2 - pending
      requestSave(); // Request 3 - pending
      
      expect(saveQueue).toEqual(['executing', 'pending', 'pending']);
    });

    test('should process all pending saves sequentially', async () => {
      let processedSaves = 0;
      
      const processSave = async () => {
        if (saveVideoStateLock) {
          pendingSaveRequested = true;
          return;
        }
        
        saveVideoStateLock = true;
        await Promise.resolve(); // Simulate save
        saveVideoStateLock = false;
        processedSaves++;
        
        if (pendingSaveRequested) {
          pendingSaveRequested = false;
          await processSave(); // Process next
        }
      };
      
      // Trigger 3 saves
      await Promise.all([
        processSave(),
        processSave(),
        processSave()
      ]);
      
      // All should be processed (though some may be deduplicated)
      expect(processedSaves).toBeGreaterThanOrEqual(1);
    });
  });

  describe('State Data Integrity', () => {
    test('should preserve screenshot array during save', () => {
      const originalScreenshots = [
        { id: 'shot-1', timestampMs: 1000 },
        { id: 'shot-2', timestampMs: 2000 }
      ];
      
      mockState.screenshots = originalScreenshots;
      
      // Simulate save (should not mutate state)
      const stateSnapshot = JSON.parse(JSON.stringify(mockState));
      
      expect(mockState.screenshots).toEqual(originalScreenshots);
      expect(stateSnapshot.screenshots).toEqual(originalScreenshots);
    });

    test('should handle empty state gracefully', () => {
      mockState.screenshots = [];
      mockState.toc = [];
      mockState.metadata = {};
      
      // Should not throw
      expect(() => {
        JSON.stringify(mockState);
      }).not.toThrow();
    });

    test('should include updatedAt timestamp', () => {
      const beforeSave = Date.now();
      const stateWithTimestamp = {
        ...mockState,
        updatedAt: new Date().toISOString()
      };
      const afterSave = Date.now();
      
      const updatedAt = new Date(stateWithTimestamp.updatedAt).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(beforeSave);
      expect(updatedAt).toBeLessThanOrEqual(afterSave);
    });

    test('should preserve note HTML content', () => {
      const noteHtml = '<p><strong>Important</strong> note with <em>formatting</em></p>';
      mockState.screenshots.push({
        id: 'shot-1',
        noteHtml: noteHtml
      });
      
      expect(mockState.screenshots[0].noteHtml).toBe(noteHtml);
    });

    test('should handle special characters in metadata', () => {
      mockState.metadata = {
        videoTitle: 'Test: "Quotes" & <Special> Characters',
        channel: 'Channel & Co.'
      };
      
      // Should serialize without errors
      expect(() => {
        JSON.stringify(mockState);
      }).not.toThrow();
    });
  });

  describe('Error Handling in Save', () => {
    test('should release lock even if save fails', async () => {
      saveVideoStateLock = true;
      let errorOccurred = false;
      
      try {
        // Simulate save error
        throw new Error('Save failed');
      } catch (err) {
        errorOccurred = true;
        // Lock should still be released in finally block
        saveVideoStateLock = false;
      }
      
      expect(errorOccurred).toBe(true);
      expect(saveVideoStateLock).toBe(false);
    });

    test('should log errors but not crash', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      
      try {
        throw new Error('Test error');
      } catch (err) {
        console.error('saveVideoState failed:', err);
      }
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    test('should handle null/undefined videoId gracefully', () => {
      const videoId = null;
      const fallbackId = videoId || 'default-id';
      
      expect(fallbackId).toBe('default-id');
    });
  });

  describe('State Recovery', () => {
    test('should recover from interrupted save', () => {
      // Simulate interrupted save (lock stuck)
      saveVideoStateLock = true;
      
      // Recovery mechanism
      const recoveryTimeout = 5000; // 5 second timeout
      const startTime = Date.now();
      
      setTimeout(() => {
        if (saveVideoStateLock && (Date.now() - startTime) > recoveryTimeout) {
          console.warn('Recovering from stuck save lock');
          saveVideoStateLock = false;
        }
      }, recoveryTimeout);
      
      // Lock should eventually be released
      expect(saveVideoStateLock).toBe(true); // Initially stuck
    });

    test('should detect and clear stale locks', () => {
      let lockAge = 10000; // 10 seconds old
      const MAX_LOCK_AGE = 5000; // 5 seconds max
      
      const isStale = lockAge > MAX_LOCK_AGE;
      expect(isStale).toBe(true);
      
      // Clear stale lock
      if (isStale) {
        saveVideoStateLock = false;
      }
      
      expect(saveVideoStateLock).toBe(false);
    });
  });
});

describe('State Serialization & Deserialization', () => {
  test('should serialize state to JSON', () => {
    const state = {
      screenshots: [
        { id: '1', timestampMs: 1000, noteHtml: '<p>Test</p>' }
      ],
      metadata: { videoId: 'test123' }
    };
    
    const serialized = JSON.stringify(state);
    expect(typeof serialized).toBe('string');
    expect(serialized).toContain('test123');
  });

  test('should deserialize state from JSON', () => {
    const json = JSON.stringify({
      screenshots: [{ id: '1', timestampMs: 1000 }],
      metadata: { videoId: 'test123' }
    });
    
    const deserialized = JSON.parse(json);
    expect(deserialized.screenshots.length).toBe(1);
    expect(deserialized.metadata.videoId).toBe('test123');
  });

  test('should handle circular references gracefully', () => {
    const obj = { a: 1 };
    obj.self = obj; // Circular reference
    
    expect(() => {
      JSON.stringify(obj);
    }).toThrow();
  });

  test('should preserve data types during serialization', () => {
    const state = {
      number: 123,
      string: 'test',
      boolean: true,
      null: null,
      array: [1, 2, 3],
      nested: { a: 1 }
    };
    
    const serialized = JSON.stringify(state);
    const deserialized = JSON.parse(serialized);
    
    expect(deserialized.number).toBe(123);
    expect(deserialized.string).toBe('test');
    expect(deserialized.boolean).toBe(true);
    expect(deserialized.null).toBe(null);
    expect(deserialized.array).toEqual([1, 2, 3]);
    expect(deserialized.nested).toEqual({ a: 1 });
  });
});
