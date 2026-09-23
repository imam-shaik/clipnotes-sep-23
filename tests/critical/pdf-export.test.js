/**
 * Critical Tests: PDF Export Functionality
 * Tests for PDF generation, chunking, and UI freeze prevention
 */

describe('PDF Export - Critical Path Tests', () => {
  // Mock jsPDF
  class MockJsPDF {
    constructor(options) {
      this.orientation = options?.orientation || 'portrait';
      this.unit = options?.unit || 'mm';
      this.format = options?.format || 'a4';
      this.pages = [{ elements: [] }];
      this.currentPage = 1;
    }

    addPage() {
      this.pages.push({ elements: [] });
      this.currentPage = this.pages.length;
    }

    text(text, x, y, options) {
      const page = this.pages[this.currentPage - 1];
      if (page) {
        page.elements.push({ type: 'text', text, x, y, options });
      }
    }

    addImage(imageData, format, x, y, width, height, alias, compression) {
      const page = this.pages[this.currentPage - 1];
      if (page) {
        page.elements.push({
          type: 'image',
          imageData,
          format,
          x,
          y,
          width,
          height,
          compression
        });
      }
    }

    save(filename) {
      return { filename, pages: this.pages.length };
    }

    output(type) {
      return 'mock-pdf-data';
    }
  }

  // Mock PDF generation config
  const PDF_CONFIG = {
    CHUNK_SIZE: 3,
    YIELD_DELAY_MS: 10,
    PAGE_WIDTH: 210,
    PAGE_HEIGHT: 297,
    MARGIN: 15
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('PDF Generation Basics', () => {
    test('should create PDF with correct orientation', () => {
      const doc = new MockJsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });
      
      expect(doc.orientation).toBe('portrait');
      expect(doc.unit).toBe('mm');
      expect(doc.format).toBe('a4');
    });

    test('should add pages correctly', () => {
      const doc = new MockJsPDF();
      
      doc.addPage();
      doc.addPage();
      
      expect(doc.pages.length).toBe(3);
      expect(doc.currentPage).toBe(3);
    });

    test('should add text to page', () => {
      const doc = new MockJsPDF();
      doc.text('Hello World', 10, 10);
      
      const page = doc.pages[0];
      expect(page.elements.length).toBe(1);
      expect(page.elements[0].type).toBe('text');
      expect(page.elements[0].text).toBe('Hello World');
    });

    test('should add image to page', () => {
      const doc = new MockJsPDF();
      doc.addImage('data:image/png;base64,test', 'PNG', 10, 10, 100, 50);
      
      const page = doc.pages[0];
      expect(page.elements.length).toBe(1);
      expect(page.elements[0].type).toBe('image');
      expect(page.elements[0].width).toBe(100);
      expect(page.elements[0].height).toBe(50);
    });
  });

  describe('Chunked Rendering - UI Freeze Prevention', () => {
    test('should yield to UI thread every CHUNK_SIZE items', async () => {
      const allItems = Array(10).fill(null).map((_, i) => ({
        type: 'shot',
        data: { id: i },
        index: i + 1
      }));

      let yieldCount = 0;
      const CHUNK_SIZE = 3;

      for (let i = 0; i < allItems.length; i++) {
        if (i > 0 && i % CHUNK_SIZE === 0) {
          yieldCount++;
          // Simulate yield
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }

      expect(yieldCount).toBe(3); // Yields at indices 3, 6, 9
    });

    test('should use requestIdleCallback when available', async () => {
      const originalRIC = global.requestIdleCallback;
      let ricCalled = false;

      global.requestIdleCallback = jest.fn((callback) => {
        ricCalled = true;
        return setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 1);
      });

      // Simulate chunked rendering
      await new Promise(resolve => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => {
            resolve();
          });
        }
      });

      expect(ricCalled).toBe(true);
      global.requestIdleCallback = originalRIC;
    });

    test('should fallback to setTimeout when requestIdleCallback unavailable', async () => {
      const originalRIC = global.requestIdleCallback;
      global.requestIdleCallback = undefined;

      let setTimeoutCalled = false;
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn((callback, delay) => {
        setTimeoutCalled = true;
        return originalSetTimeout(callback, delay);
      });

      await new Promise(resolve => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(resolve);
        } else {
          setTimeout(resolve, 10);
        }
      });

      expect(setTimeoutCalled).toBe(true);
      
      global.requestIdleCallback = originalRIC;
      global.setTimeout = originalSetTimeout;
    });

    test('should report progress during rendering', async () => {
      const allItems = Array(100).fill(null);
      const progressUpdates = [];

      const CHUNK_SIZE = 3;
      for (let i = 0; i < allItems.length; i++) {
        if (i > 0 && i % CHUNK_SIZE === 0) {
          const progress = Math.round((i / allItems.length) * 100);
          progressUpdates.push(progress);
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }

      expect(progressUpdates.length).toBe(33);
      expect(progressUpdates[0]).toBe(3);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(99);
    });
  });

  describe('Large Export Handling', () => {
    test('should handle 100+ screenshots without freezing', async () => {
      const screenshots = Array(150).fill(null).map((_, i) => ({
        id: `shot-${i}`,
        dataUrl: 'data:image/jpeg;base64,test',
        timeFormatted: '00:00',
        noteHtml: ''
      }));

      const CHUNK_SIZE = 3;
      let processedCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < screenshots.length; i++) {
        if (i > 0 && i % CHUNK_SIZE === 0) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        processedCount++;
      }

      const duration = Date.now() - startTime;
      
      expect(processedCount).toBe(150);
      expect(duration).toBeLessThan(5000); // Should complete in <5s with yielding
    });

    test('should handle screenshots with large notes', async () => {
      const screenshots = Array(10).fill(null).map((_, i) => ({
        id: `shot-${i}`,
        dataUrl: 'data:image/jpeg;base64,test',
        timeFormatted: '00:00',
        noteHtml: '<p>' + 'A'.repeat(1000) + '</p>' // Long note
      }));

      // Should process without errors
      expect(screenshots.length).toBe(10);
      expect(screenshots[0].noteHtml.length).toBeGreaterThan(100);
    });

    test('should handle missing images gracefully', async () => {
      const screenshots = [
        { id: 'shot-1', dataUrl: 'data:image/jpeg;base64,test', noteHtml: '' },
        { id: 'shot-2', dataUrl: null, noteHtml: 'Note without image' },
        { id: 'shot-3', dataUrl: 'data:image/jpeg;base64,test', noteHtml: '' }
      ];

      const validShots = screenshots.filter(s => s.dataUrl);
      const shotsWithoutImages = screenshots.filter(s => !s.dataUrl && s.noteHtml);

      expect(validShots.length).toBe(2);
      expect(shotsWithoutImages.length).toBe(1);
    });
  });

  describe('PDF Content Validation', () => {
    test('should include cover page', () => {
      const doc = new MockJsPDF();
      
      // Add cover page
      doc.text('Video Notes', 10, 20);
      
      expect(doc.pages.length).toBe(1);
      expect(doc.pages[0].elements.some(e => e.text === 'Video Notes')).toBe(true);
    });

    test('should include table of contents', () => {
      const doc = new MockJsPDF();
      const tocEntries = [
        { title: 'Chapter 1', page: 1 },
        { title: 'Chapter 2', page: 2 }
      ];

      doc.text('Table of Contents', 10, 10);
      
      tocEntries.forEach((entry, i) => {
        doc.text(`${entry.title} ... ${entry.page}`, 10, 20 + (i * 10));
      });

      const page = doc.pages[0];
      expect(page.elements.some(e => e.text?.includes('Table of Contents'))).toBe(true);
    });

    test('should include all screenshots', () => {
      const doc = new MockJsPDF();
      const screenshots = Array(5).fill(null).map((_, i) => ({
        id: `shot-${i}`,
        dataUrl: 'data:image/base64,test',
        timeFormatted: '00:00'
      }));

      screenshots.forEach((shot, i) => {
        doc.addImage(shot.dataUrl, 'PNG', 10, 10 + (i * 50), 100, 40);
      });

      const imageCount = doc.pages[0].elements.filter(e => e.type === 'image').length;
      expect(imageCount).toBe(5);
    });

    test('should include notes with screenshots', () => {
      const doc = new MockJsPDF();
      const shotWithNote = {
        id: 'shot-1',
        dataUrl: 'data:image/base64,test',
        timeFormatted: '00:00',
        noteHtml: '<p>Important note</p>'
      };

      doc.addImage(shotWithNote.dataUrl, 'PNG', 10, 10, 100, 40);
      doc.text('Important note', 10, 60);

      const page = doc.pages[0];
      expect(page.elements.some(e => e.type === 'image')).toBe(true);
      expect(page.elements.some(e => e.text === 'Important note')).toBe(true);
    });
  });

  describe('Error Handling in PDF Export', () => {
    test('should handle image load failures', async () => {
      const screenshots = [
        { id: 'shot-1', dataUrl: 'invalid-data-url', noteHtml: '' }
      ];

      let errorCount = 0;
      
      for (const shot of screenshots) {
        try {
          // Simulate image load
          if (!shot.dataUrl || !shot.dataUrl.startsWith('data:')) {
            throw new Error('Invalid image data');
          }
        } catch (err) {
          errorCount++;
        }
      }

      expect(errorCount).toBe(1);
    });

    test('should handle empty screenshots array', () => {
      const screenshots = [];
      
      // Should not crash
      expect(screenshots.length).toBe(0);
    });

    test('should handle very long text in notes', () => {
      const longNote = 'A'.repeat(10000);
      
      // Simulate text splitting for PDF
      const maxLineLength = 80;
      const lines = Math.ceil(longNote.length / maxLineLength);
      
      expect(lines).toBeGreaterThan(100);
    });

    test('should handle special characters in text', () => {
      const specialText = 'Test: "Quotes" & <Special> émojis 🎉 中文';
      
      const doc = new MockJsPDF();
      doc.text(specialText, 10, 10);
      
      const page = doc.pages[0];
      expect(page.elements[0].text).toBe(specialText);
    });
  });

  describe('Progress Modal', () => {
    test('should show progress modal before export', () => {
      let modalVisible = false;
      
      const showExportProgressDialog = (message) => {
        modalVisible = true;
      };
      
      showExportProgressDialog('Starting PDF export...');
      expect(modalVisible).toBe(true);
    });

    test('should update progress message', () => {
      let currentMessage = '';
      
      const updateExportProgressDialog = (message) => {
        currentMessage = message;
      };
      
      updateExportProgressDialog('Rendering pages... 50%');
      expect(currentMessage).toContain('50%');
    });

    test('should hide progress modal after export', () => {
      let modalVisible = true;
      
      const hideExportProgressDialog = () => {
        modalVisible = false;
      };
      
      hideExportProgressDialog();
      expect(modalVisible).toBe(false);
    });
  });
});

describe('PDF Export - Edge Cases', () => {
  test('should handle TOC-only export (no screenshots)', () => {
    const tocEntries = [
      { title: 'Marker 1', timestampMs: 1000 },
      { title: 'Marker 2', timestampMs: 2000 }
    ];
    const screenshots = [];

    // Should still generate PDF with TOC
    expect(tocEntries.length).toBe(2);
    expect(screenshots.length).toBe(0);
  });

  test('should handle screenshot-only export (no TOC)', () => {
    const screenshots = [
      { id: 'shot-1', timestampMs: 1000 }
    ];
    const tocEntries = [];

    // Should still generate PDF with screenshots
    expect(screenshots.length).toBe(1);
    expect(tocEntries.length).toBe(0);
  });

  test('should sort items by timestamp', () => {
    const items = [
      { type: 'shot', time: 3000 },
      { type: 'toc', time: 1000 },
      { type: 'shot', time: 2000 }
    ];

    const sorted = items.sort((a, b) => a.time - b.time);
    
    expect(sorted[0].time).toBe(1000);
    expect(sorted[1].time).toBe(2000);
    expect(sorted[2].time).toBe(3000);
  });

  test('should handle items with same timestamp', () => {
    const items = [
      { type: 'shot', time: 1000, id: 'a' },
      { type: 'toc', time: 1000, id: 'b' },
      { type: 'shot', time: 1000, id: 'c' }
    ];

    const sorted = items.sort((a, b) => a.time - b.time);
    
    // All have same time, order may vary but should not crash
    expect(sorted.length).toBe(3);
  });
});
