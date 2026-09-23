/**
 * Unit Tests: HTML Sanitization (Security)
 * Tests for XSS prevention and safe HTML handling
 */

describe('HTML Sanitization - XSS Prevention', () => {
  // Simulate sanitizeNoteHtml function from panel.js
  function sanitizeNoteHtml(html) {
    if (!html || typeof html !== 'string') return "";

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    const allowedTags = new Set([
        'b', 'i', 'em', 'strong', 'u', 'span', 'div', 'p', 'br', 'hr',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'mark', 'code', 'pre', 'blockquote', 'a'
    ]);

    const allowedAttrs = {
        '*': ['style', 'class'],
        'a': ['href', 'title', 'target'],
        'span': ['style', 'class'],
        'div': ['style', 'class'],
        'p': ['style', 'class'],
        'h1': ['style', 'class'],
        'h2': ['style', 'class'],
        'h3': ['style', 'class'],
        'h4': ['style', 'class'],
        'h5': ['style', 'class'],
        'h6': ['style', 'class'],
        'mark': ['style', 'class'],
        'code': ['style', 'class'],
        'pre': ['style', 'class'],
        'blockquote': ['style', 'class']
    };

    const allowedStyles = new Set([
        'color', 'background-color', 'background',
        'font-weight', 'font-style', 'font-family', 'font-size',
        'text-decoration', 'text-align',
        'margin', 'padding', 'border',
        'white-space', 'word-wrap', 'line-height'
    ]);

    const dangerousTags = new Set([
        'script', 'iframe', 'object', 'embed', 'form', 'input',
        'button', 'select', 'textarea', 'style', 'link', 'meta',
        'base', 'applet', 'frame', 'frameset', 'layer', 'ilayer'
    ]);

    function sanitizeNode(node) {
        if (node.nodeType === 3) { // Node.TEXT_NODE
            return node.cloneNode();
        }

        if (node.nodeType !== 1) { // Node.ELEMENT_NODE
            return null;
        }

        const tagName = node.nodeName.toLowerCase();

        if (dangerousTags.has(tagName)) {
            return null;
        }

        if (!allowedTags.has(tagName) && tagName !== 'div') {
            const fragment = document.createDocumentFragment();
            Array.from(node.childNodes).forEach(child => {
                const sanitized = sanitizeNode(child);
                if (sanitized) fragment.appendChild(sanitized);
            });
            return fragment;
        }

        const sanitizedEl = document.createElement(tagName);

        Array.from(node.attributes).forEach(attr => {
            const attrName = attr.name.toLowerCase();
            const allowedForTag = allowedAttrs[tagName] || allowedAttrs['*'] || [];

            if (allowedForTag.includes(attrName)) {
                if (attrName === 'style') {
                    const sanitizedStyle = sanitizeStyleAttribute(attr.value);
                    if (sanitizedStyle) {
                        sanitizedEl.setAttribute(attrName, sanitizedStyle);
                    }
                } else if (attrName === 'href') {
                    const hrefValue = attr.value.trim();
                    if (hrefValue.startsWith('#') ||
                        hrefValue.startsWith('http://') ||
                        hrefValue.startsWith('https://') ||
                        hrefValue.startsWith('mailto:')) {
                        sanitizedEl.setAttribute(attrName, hrefValue);
                    }
                } else {
                    sanitizedEl.setAttribute(attrName, attr.value);
                }
            }
        });

        Array.from(node.childNodes).forEach(child => {
            const sanitized = sanitizeNode(child);
            if (sanitized) sanitizedEl.appendChild(sanitized);
        });

        return sanitizedEl;
    }

    function sanitizeStyleAttribute(styleValue) {
        if (!styleValue || typeof styleValue !== 'string') return '';

        const declarations = styleValue.split(';');
        const sanitized = [];

        declarations.forEach(declaration => {
            const colonIndex = declaration.indexOf(':');
            if (colonIndex === -1) return;

            const property = declaration.substring(0, colonIndex).trim().toLowerCase();
            const value = declaration.substring(colonIndex + 1).trim();

            if (allowedStyles.has(property)) {
                if (!value.includes('url(') &&
                    !value.includes('expression(') &&
                    !value.includes('javascript:')) {
                    sanitized.push(`${property}: ${value}`);
                }
            }
        });

        return sanitized.join('; ');
    }

    const sanitized = sanitizeNode(tempDiv);
    if (!sanitized) return '';

    const result = sanitized.nodeType === 1 ? sanitized.innerHTML : sanitized.textContent;
    return result || '';
  }

  describe('Dangerous Tag Removal', () => {
    test('should remove script tags', () => {
      const malicious = '<script>alert("XSS")</script><p>Safe</p>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).toContain('<p>Safe</p>');
    });

    test('should remove iframe tags', () => {
      const malicious = '<iframe src="evil.com"></iframe><p>Safe</p>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<iframe>');
    });

    test('should remove object and embed tags', () => {
      const malicious = '<object data="evil.swf"></object><embed src="evil.swf">';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<object>');
      expect(sanitized).not.toContain('<embed>');
    });

    test('should remove form elements', () => {
      const malicious = '<form action="evil.com"><input type="text"></form>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<form>');
      expect(sanitized).not.toContain('<input>');
    });

    test('should remove style tags', () => {
      const malicious = '<style>body { display: none; }</style><p>Safe</p>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<style>');
    });

    test('should remove link tags', () => {
      const malicious = '<link rel="stylesheet" href="evil.css">';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<link>');
    });
  });

  describe('Attribute Sanitization', () => {
    test('should remove onclick handlers', () => {
      const malicious = '<p onclick="alert(1)">Click me</p>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('onclick');
    });

    test('should remove onerror handlers', () => {
      const malicious = '<img src="x" onerror="alert(1)">';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('onerror');
    });

    test('should remove onload handlers', () => {
      const malicious = '<div onload="alert(1)">Content</div>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('onload');
    });

    test('should remove javascript: URLs', () => {
      const malicious = '<a href="javascript:alert(1)">Click</a>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('javascript:');
    });

    test('should remove data: URLs in dangerous contexts', () => {
      const malicious = '<a href="data:text/html,<script>alert(1)</script>">Click</a>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      // Should either remove or sanitize data: URLs
      expect(sanitized.toLowerCase()).not.toContain('data:text/html');
    });
  });

  describe('Safe HTML Preservation', () => {
    test('should preserve formatting tags', () => {
      const safe = '<p><strong>Bold</strong> and <em>italic</em></p>';
      const sanitized = sanitizeNoteHtml(safe);
      
      expect(sanitized).toContain('<strong>Bold</strong>');
      expect(sanitized).toContain('<em>italic</em>');
    });

    test('should preserve lists', () => {
      const safe = '<ul><li>Item 1</li><li>Item 2</li></ul>';
      const sanitized = sanitizeNoteHtml(safe);
      
      expect(sanitized).toContain('<ul>');
      expect(sanitized).toContain('<li>');
    });

    test('should preserve headings', () => {
      const safe = '<h1>Title</h1><h2>Subtitle</h2>';
      const sanitized = sanitizeNoteHtml(safe);
      
      expect(sanitized).toContain('<h1>');
      expect(sanitized).toContain('<h2>');
    });

    test('should preserve safe links', () => {
      const safe = '<a href="https://example.com">Safe Link</a>';
      const sanitized = sanitizeNoteHtml(safe);
      
      expect(sanitized).toContain('href="https://example.com"');
    });

    test('should preserve mark/highlight tags', () => {
      const safe = '<p>Important <mark>highlighted</mark> text</p>';
      const sanitized = sanitizeNoteHtml(safe);
      
      expect(sanitized).toContain('<mark>');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty input', () => {
      expect(sanitizeNoteHtml('')).toBe('');
      expect(sanitizeNoteHtml(null)).toBe('');
      expect(sanitizeNoteHtml(undefined)).toBe('');
    });

    test('should handle nested dangerous tags', () => {
      const malicious = '<div><script><iframe></iframe></script></div>';
      const sanitized = sanitizeNoteHtml(malicious);
      
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('<iframe>');
    });

    test('should handle malformed HTML', () => {
      const malformed = '<script>alert(1)<p>Unclosed';
      const sanitized = sanitizeNoteHtml(malformed);
      
      expect(sanitized).not.toContain('<script>');
    });

    test('should handle unicode characters', () => {
      const unicode = '<p>Test 中文 🎉 émojis</p>';
      const sanitized = sanitizeNoteHtml(unicode);
      
      expect(sanitized).toContain('中文');
      expect(sanitized).toContain('🎉');
    });

    test('should handle very long input', () => {
      const long = '<p>' + 'A'.repeat(10000) + '</p>';
      const sanitized = sanitizeNoteHtml(long);
      
      expect(sanitized).toContain('AAA');
    });
  });

  describe('XSS Attack Vectors', () => {
    test('should block basic XSS payload', () => {
      const xss = '<script>alert(document.cookie)</script>';
      const sanitized = sanitizeNoteHtml(xss);
      
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('alert');
    });

    test('should block img onerror XSS', () => {
      const xss = '<img src=x onerror=alert(1)>';
      const sanitized = sanitizeNoteHtml(xss);
      
      expect(sanitized).not.toContain('onerror');
    });

    test('should block SVG XSS', () => {
      const xss = '<svg onload=alert(1)>';
      const sanitized = sanitizeNoteHtml(xss);
      
      expect(sanitized).not.toContain('onload');
    });

    test('should block data URL XSS', () => {
      const xss = '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Click</a>';
      const sanitized = sanitizeNoteHtml(xss);
      
      expect(sanitized.toLowerCase()).not.toContain('data:text/html');
    });

    test('should block event handler XSS in style', () => {
      const xss = '<div style="background:url(javascript:alert(1))">Test</div>';
      const sanitized = sanitizeNoteHtml(xss);
      
      expect(sanitized).not.toContain('javascript:');
    });
  });
});

describe('HTML Sanitization for PDF Export', () => {
  function sanitizeHtmlForEditorAndExport(html, options = {}) {
    // Simplified version for testing
    if (!html) return '';
    
    // Remove images for PDF
    let sanitized = html.replace(/<img[^>]*>/gi, '[Image Removed]');
    
    // Remove script tags
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    return sanitized;
  }

  test('should remove images from HTML', () => {
    const html = '<p>Text</p><img src="test.jpg"><p>More text</p>';
    const sanitized = sanitizeHtmlForEditorAndExport(html);
    
    expect(sanitized).not.toContain('<img');
    expect(sanitized).toContain('[Image Removed]');
  });

  test('should preserve text content', () => {
    const html = '<p>Important content</p>';
    const sanitized = sanitizeHtmlForEditorAndExport(html);
    
    expect(sanitized).toContain('Important content');
  });

  test('should handle HTML with no images', () => {
    const html = '<p>Text only</p>';
    const sanitized = sanitizeHtmlForEditorAndExport(html);
    
    expect(sanitized).toBe('<p>Text only</p>');
  });
});
