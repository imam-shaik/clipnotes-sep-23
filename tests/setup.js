/**
 * Test Setup File
 * Initializes global mocks, utilities, and test helpers
 */

require('@testing-library/jest-dom');

// ==========================================
// Chrome API Mocks
// ==========================================

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage: jest.fn((message, callback) => {
      if (typeof callback === 'function') {
        callback({ success: true });
      }
      return Promise.resolve({ success: true });
    }),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    onInstalled: {
      addListener: jest.fn()
    }
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        if (typeof callback === 'function') {
          callback({});
        }
        return Promise.resolve({});
      }),
      set: jest.fn((items, callback) => {
        if (typeof callback === 'function') {
          callback();
        }
        return Promise.resolve();
      }),
      remove: jest.fn((key, callback) => {
        if (typeof callback === 'function') {
          callback();
        }
        return Promise.resolve();
      })
    },
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    }
  },
  tabs: {
    sendMessage: jest.fn((tabId, message, callback) => {
      if (typeof callback === 'function') {
        callback({ success: true });
      }
      return Promise.resolve({ success: true });
    }),
    query: jest.fn((queryInfo, callback) => {
      if (typeof callback === 'function') {
        callback([]);
      }
      return Promise.resolve([]);
    }),
    get: jest.fn((tabId, callback) => {
      if (typeof callback === 'function') {
        callback({ id: tabId, url: 'https://www.youtube.com/watch?v=test123' });
      }
      return Promise.resolve({ id: tabId, url: 'https://www.youtube.com/watch?v=test123' });
    }),
    onUpdated: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    onRemoved: {
      addListener: jest.fn()
    }
  },
  windows: {
    create: jest.fn((createData, callback) => {
      if (typeof callback === 'function') {
        callback({ id: 100, focused: true });
      }
      return Promise.resolve({ id: 100, focused: true });
    }),
    get: jest.fn((windowId, callback) => {
      if (typeof callback === 'function') {
        callback({ id: windowId, state: 'normal', left: 0, top: 0, width: 800, height: 600 });
      }
      return Promise.resolve({ id: windowId, state: 'normal', left: 0, top: 0, width: 800, height: 600 });
    }),
    remove: jest.fn((windowId, callback) => {
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    }),
    update: jest.fn((windowId, updateInfo, callback) => {
      if (typeof callback === 'function') {
        callback({ id: windowId, ...updateInfo });
      }
      return Promise.resolve({ id: windowId, ...updateInfo });
    }),
    onRemoved: {
      addListener: jest.fn()
    },
    onBoundsChanged: {
      addListener: jest.fn()
    }
  },
  sidePanel: {
    setOptions: jest.fn((options, callback) => {
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    }),
    open: jest.fn((options, callback) => {
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    })
  },
  downloads: {
    download: jest.fn((options, callback) => {
      if (typeof callback === 'function') {
        callback(1);
      }
      return Promise.resolve(1);
    }),
    open: jest.fn((downloadId, callback) => {
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    }),
    onChanged: {
      addListener: jest.fn()
    }
  },
  contextMenus: {
    create: jest.fn(),
    onClicked: {
      addListener: jest.fn()
    }
  },
  scripting: {
    executeScript: jest.fn((details, callback) => {
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    })
  },
  action: {
    onClicked: {
      addListener: jest.fn()
    }
  }
};

// ==========================================
// Mock requestIdleCallback
// ==========================================

if (!global.requestIdleCallback) {
  global.requestIdleCallback = (callback) => {
    return setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 1);
  };
}

if (!global.cancelIdleCallback) {
  global.cancelIdleCallback = (id) => {
    clearTimeout(id);
  };
}

// ==========================================
// Mock URL.createObjectURL and revokeObjectURL
// ==========================================

global.URL.createObjectURL = jest.fn((blob) => {
  return `blob:test-${Date.now()}-${Math.random()}`;
});

global.URL.revokeObjectURL = jest.fn();

// ==========================================
// Mock FileReader
// ==========================================

class MockFileReader {
  constructor() {
    this.result = null;
    this.onloadend = null;
    this.onerror = null;
  }

  readAsDataURL(blob) {
    this.result = 'data:image/png;base64,test';
    setTimeout(() => {
      if (this.onloadend) {
        this.onloadend({ target: { result: this.result } });
      }
    }, 0);
  }

  readAsText(blob) {
    this.result = '{}';
    setTimeout(() => {
      if (this.onloadend) {
        this.onloadend({ target: { result: this.result } });
      }
    }, 0);
  }
}

global.FileReader = MockFileReader;

// ==========================================
// Mock Canvas API
// ==========================================

class MockCanvasContext {
  constructor() {
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.globalCompositeOperation = 'source-over';
  }

  fillRect(x, y, width, height) {}
  strokeRect(x, y, width, height) {}
  clearRect(x, y, width, height) {}
  beginPath() {}
  moveTo(x, y) {}
  lineTo(x, y) {}
  arc(x, y, radius, startAngle, endAngle) {}
  stroke() {}
  fill() {}
  drawImage(img, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) {}
  getImageData(x, y, width, height) {
    return { data: new Array(width * height * 4).fill(0) };
  }
  toDataURL(type, quality) {
    return 'data:image/png;base64,test';
  }
}

class MockCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this._context = null;
  }

  getContext(type) {
    if (!this._context) {
      this._context = new MockCanvasContext();
    }
    return this._context;
  }

  toDataURL(type, quality) {
    return 'data:image/png;base64,test';
  }

  toBlob(callback, type, quality) {
    const blob = { type, size: 1000 };
    setTimeout(() => callback(blob), 0);
  }
}

global.HTMLCanvasElement = MockCanvas;

// ==========================================
// Mock Image
// ==========================================

class MockImage {
  constructor() {
    this.width = 1920;
    this.height = 1080;
    this.src = '';
    this.onload = null;
    this.onerror = null;
  }

  set src(value) {
    this._src = value;
    setTimeout(() => {
      if (value && (value.includes('invalid') || value === 'invalid-url')) {
        if (this.onerror) {
          this.onerror();
        }
      } else {
        if (this.onload) {
          this.onload();
        }
      }
    }, 0);
  }

  get src() {
    return this._src;
  }
}

global.Image = MockImage;

// ==========================================
// Mock localStorage
// ==========================================

const mockLocalStorage = {
  store: {},
  getItem(key) {
    return this.store[key] || null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
  clear() {
    this.store = {};
  },
  get length() {
    return Object.keys(this.store).length;
  },
  key(index) {
    const keys = Object.keys(this.store);
    return keys[index] || null;
  }
};

Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage
});

// ==========================================
// Mock matchMedia
// ==========================================

Object.defineProperty(global, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn()
  }))
});

// ==========================================
// Mock scrollTo
// ==========================================

Element.prototype.scrollTo = jest.fn();
Element.prototype.scrollIntoView = jest.fn();

// ==========================================
// Mock IntersectionObserver
// ==========================================

global.IntersectionObserver = class IntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
  }
  observe(target) {}
  unobserve(target) {}
  disconnect() {}
};

// ==========================================
// Test Utilities
// ==========================================

global.testUtils = {
  /**
   * Wait for async operations to complete
   */
  flushPromises: () => new Promise(resolve => setImmediate(resolve)),

  /**
   * Create a mock screenshot object
   */
  createMockScreenshot: (overrides = {}) => ({
    id: `shot-${Date.now()}`,
    timestampMs: 60000,
    timeFormatted: '01:00',
    filename: `Shot_01-00_test.jpg`,
    dataUrl: 'data:image/jpeg;base64,test',
    noteHtml: '',
    createdAt: Date.now(),
    ...overrides
  }),

  /**
   * Create a mock TOC entry
   */
  createMockTOC: (overrides = {}) => ({
    id: `toc-${Date.now()}`,
    title: 'Test Marker',
    level: 'H2',
    timestampMs: 120000,
    timeFormatted: '02:00',
    createdAt: Date.now(),
    ...overrides
  }),

  /**
   * Create mock video metadata
   */
  createMockMetadata: (overrides = {}) => ({
    videoId: 'test123',
    videoTitle: 'Test Video',
    videoUrl: 'https://www.youtube.com/watch?v=test123',
    channel: 'Test Channel',
    lastTimeMs: 0,
    selectedInterval: 'None',
    ...overrides
  }),

  /**
   * Reset all chrome mocks
   */
  resetChromeMocks: () => {
    Object.keys(chrome).forEach(key => {
      if (chrome[key] && typeof chrome[key] === 'object') {
        Object.keys(chrome[key]).forEach(subKey => {
          if (chrome[key][subKey] && typeof chrome[key][subKey] === 'function') {
            chrome[key][subKey].mockClear();
          } else if (chrome[key][subKey] && typeof chrome[key][subKey] === 'object') {
            Object.keys(chrome[key][subKey]).forEach(method => {
              if (typeof chrome[key][subKey][method] === 'function') {
                chrome[key][subKey][method].mockClear();
              }
            });
          }
        });
      }
    });
  },

  /**
   * Simulate file system handle
   */
  createMockFileHandle: (name = 'test.txt', content = 'test') => ({
    name,
    kind: 'file',
    getFile: jest.fn().mockResolvedValue({
      text: jest.fn().mockResolvedValue(content)
    }),
    createWritable: jest.fn().mockResolvedValue({
      write: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue()
    })
  }),

  /**
   * Simulate directory handle
   */
  createMockDirectoryHandle: (name = 'test-dir') => ({
    name,
    kind: 'directory',
    getFileHandle: jest.fn().mockResolvedValue(this.createMockFileHandle()),
    getDirectoryHandle: jest.fn().mockResolvedValue(this.createMockDirectoryHandle('subdir')),
    removeEntry: jest.fn().mockResolvedValue(),
    values: jest.fn().mockImplementation(async function* () {
      yield this.createMockFileHandle();
    })
  })
};

// ==========================================
// Silence console errors in tests (optional)
// ==========================================

// Uncomment to suppress console output during tests
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn()
// };
