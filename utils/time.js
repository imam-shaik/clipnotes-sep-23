// utils/time.js - Time formatting utilities (browser script version)
// Exposes TimeUtils object with formatting functions

window.TimeUtils = (function() {
    /**
     * Format milliseconds to human-readable time string
     * @param {number} ms - Time in milliseconds
     * @returns {string} Formatted time (HH:MM:SS or MM:SS)
     */
    function formatTime(ms) {
        if (ms === null || ms === undefined || isNaN(ms)) return "0:00";
        if (ms <= 0) return "0:00";
        let seconds = Math.floor(ms / 1000);
        let minutes = Math.floor(seconds / 60);
        seconds = seconds % 60;
        let hours = Math.floor(minutes / 60);
        minutes = minutes % 60;
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Parse time string to milliseconds
     * @param {string} timeStr - Time string (HH:MM:SS, MM:SS, or seconds)
     * @returns {number} Time in milliseconds
     */
    function parseTimeToMs(timeStr) {
        if (timeStr === null || timeStr === undefined) return 0;
        timeStr = String(timeStr).trim();
        if (!timeStr) return 0;

        const parts = timeStr.split(':');
        if (parts.length > 3) return 0;
        
        const numericParts = parts.map(Number);
        if (numericParts.some(isNaN)) return 0;

        if (parts.length === 2) {
            return (numericParts[0] * 60 + numericParts[1]) * 1000;
        }
        if (parts.length === 3) {
            return (numericParts[0] * 3600 + numericParts[1] * 60 + numericParts[2]) * 1000;
        }

        // Handle raw seconds
        return numericParts[0] * 1000;
    }

    /**
     * Format time with options
     * @param {number} ms - Time in milliseconds
     * @param {Object} options - Formatting options
     * @param {boolean} options.includeHours - Always include hours
     * @param {boolean} options.showMs - Show milliseconds
     * @returns {string} Formatted time
     */
    function formatTimeWithOptions(ms, options = {}) {
        if (ms < 0) return "00:00";
        
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const milliseconds = Math.floor(ms % 1000);

        let result = '';
        
        if (options.includeHours || hours > 0) {
            result = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            result = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        if (options.showMs) {
            result += `.${milliseconds.toString().padStart(3, '0')}`;
        }
        return result;
    }

    /**
     * Normalize time input string
     * @param {string} timeStr - Input time string
     * @returns {string} Normalized time string or empty string if invalid
     */
    function normalizeTimeInput(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return '';
        const trimmed = timeStr.trim();
        if (/^\d+:\d+(:\d+)?$/.test(trimmed)) {
            return trimmed;
        }
        return '';
    }

    // Public API
    return {
        formatTime,
        formatTimeHelper: formatTime,
        parseTimeToMs,
        formatTimeWithOptions,
        normalizeTimeInput
    };
})();

// Node.js/Jest support
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.TimeUtils;
}
