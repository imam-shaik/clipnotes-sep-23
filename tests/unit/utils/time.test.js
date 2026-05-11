/**
 * Unit Tests: Time Utilities
 * Tests for utils/time.js - time formatting and parsing functions
 */

import { formatTime, parseTimeToMs, normalizeTimeInput } from '../../utils/time';

describe('Time Utilities', () => {
  describe('formatTime', () => {
    describe('Normal Cases', () => {
      test('should format milliseconds to MM:SS format', () => {
        expect(formatTime(60000)).toBe('1:00');
        expect(formatTime(120000)).toBe('2:00');
        expect(formatTime(90000)).toBe('1:30');
      });

      test('should format milliseconds to HH:MM:SS when hours > 0', () => {
        expect(formatTime(3600000)).toBe('1:00:00');
        expect(formatTime(7200000)).toBe('2:00:00');
        expect(formatTime(3661000)).toBe('1:01:01');
      });

      test('should handle zero milliseconds', () => {
        expect(formatTime(0)).toBe('0:00');
      });

      test('should pad seconds with leading zero', () => {
        expect(formatTime(1000)).toBe('0:01');
        expect(formatTime(5000)).toBe('0:05');
        expect(formatTime(61000)).toBe('1:01');
      });
    });

    describe('Edge Cases', () => {
      test('should handle negative milliseconds', () => {
        const result = formatTime(-1000);
        expect(result).toMatch(/^\d+:\d{2}$/);
      });

      test('should handle very large milliseconds', () => {
        const result = formatTime(86400000); // 24 hours
        expect(result).toContain(':');
      });

      test('should handle fractional milliseconds', () => {
        expect(formatTime(1500)).toBe('0:01');
        expect(formatTime(59999)).toBe('0:59');
      });

      test('should handle NaN input', () => {
        const result = formatTime(NaN);
        expect(typeof result).toBe('string');
      });

      test('should handle null/undefined input', () => {
        expect(() => formatTime(null)).not.toThrow();
        expect(() => formatTime(undefined)).not.toThrow();
      });
    });

    describe('Boundary Conditions', () => {
      test('should format exactly 1 second', () => {
        expect(formatTime(1000)).toBe('0:01');
      });

      test('should format exactly 1 minute', () => {
        expect(formatTime(60000)).toBe('1:00');
      });

      test('should format exactly 1 hour', () => {
        expect(formatTime(3600000)).toBe('1:00:00');
      });

      test('should format 59 minutes 59 seconds', () => {
        expect(formatTime(3599000)).toBe('59:59');
      });

      test('should format 23:59:59', () => {
        expect(formatTime(86399000)).toBe('23:59:59');
      });
    });
  });

  describe('parseTimeToMs', () => {
    describe('Normal Cases', () => {
      test('should parse MM:SS format', () => {
        expect(parseTimeToMs('1:00')).toBe(60000);
        expect(parseTimeToMs('2:30')).toBe(150000);
        expect(parseTimeToMs('59:59')).toBe(3599000);
      });

      test('should parse HH:MM:SS format', () => {
        expect(parseTimeToMs('1:00:00')).toBe(3600000);
        expect(parseTimeToMs('1:30:45')).toBe(5445000);
        expect(parseTimeToMs('23:59:59')).toBe(86399000);
      });

      test('should parse plain seconds as string', () => {
        expect(parseTimeToMs('60')).toBe(60000);
        expect(parseTimeToMs('120.5')).toBe(120500);
      });

      test('should parse numeric seconds', () => {
        expect(parseTimeToMs(60)).toBe(60000);
        expect(parseTimeToMs(120.5)).toBe(120500);
      });
    });

    describe('Edge Cases', () => {
      test('should handle empty string', () => {
        expect(parseTimeToMs('')).toBe(0);
      });

      test('should handle null/undefined', () => {
        expect(parseTimeToMs(null)).toBe(0);
        expect(parseTimeToMs(undefined)).toBe(0);
      });

      test('should handle invalid format', () => {
        expect(parseTimeToMs('invalid')).toBe(0);
        expect(parseTimeToMs('1:2:3:4')).toBe(0);
      });

      test('should handle negative values', () => {
        const result = parseTimeToMs('-1:00');
        expect(typeof result).toBe('number');
      });

      test('should handle whitespace', () => {
        expect(parseTimeToMs(' 1:00 ')).toBe(60000);
        expect(parseTimeToMs('  60  ')).toBe(60000);
      });
    });

    describe('Boundary Conditions', () => {
      test('should parse 0:00', () => {
        expect(parseTimeToMs('0:00')).toBe(0);
      });

      test('should parse 0:01 (minimum non-zero)', () => {
        expect(parseTimeToMs('0:01')).toBe(1000);
      });

      test('should handle single digit minutes', () => {
        expect(parseTimeToMs('1:5')).toBe(65000);
        expect(parseTimeToMs('5:9')).toBe(309000);
      });
    });
  });

  describe('normalizeTimeInput', () => {
    describe('Normal Cases', () => {
      test('should normalize valid time strings', () => {
        expect(normalizeTimeInput('1:00')).toBe('1:00');
        expect(normalizeTimeInput('1:00:00')).toBe('1:00:00');
      });

      test('should trim whitespace', () => {
        expect(normalizeTimeInput('  1:00  ')).toBe('1:00');
      });
    });

    describe('Edge Cases', () => {
      test('should return empty string for invalid input', () => {
        expect(normalizeTimeInput('')).toBe('');
        expect(normalizeTimeInput('invalid')).toBe('');
      });

      test('should handle null/undefined', () => {
        expect(normalizeTimeInput(null)).toBe('');
        expect(normalizeTimeInput(undefined)).toBe('');
      });
    });
  });
});
