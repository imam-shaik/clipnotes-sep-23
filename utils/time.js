// utils/time.js - Time formatting utilities (browser script version)
// Exposes TimeUtils object with formatting functions

window.TimeUtils = (function() {
    /**
     * Format milliseconds to human-readable time string
     * @param {number} ms - Time in milliseconds
     * @returns {string} Formatted time (HH:MM:SS or MM:SS)
     */
    function formatTime(ms) {
        if (ms < 0) return "00:00";
        let seconds = Math.floor(ms / 1000);
        let minutes = Math.floor(seconds / 60);
        seconds = seconds % 60;
        let hours = Math.floor(minutes / 60);
        minutes = minutes % 60;
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Parse time string to milliseconds
     * @param {string} timeStr - Time string (HH:MM:SS, MM:SS, or seconds)
     * @returns {number} Time in milliseconds
     */
    function parseTimeToMs(timeStr) {
        if (!timeStr) return 0;

        // Handle "HH:MM:SS" or "MM:SS"
        const parts = timeStr.split(':').map(Number);
        if (parts.length === 2) {
            return (parts[0] * 60 + parts[1]) * 1000;
        }
        if (parts.length === 3) {
            return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }

        // Handle raw seconds
        const seconds = parseFloat(timeStr);
        return isNaN(seconds) ? 0 : seconds * 1000;
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

    // Public API
    return {
        formatTime,
        formatTimeHelper: formatTime,
        parseTimeToMs,
        formatTimeWithOptions
    };
})();
