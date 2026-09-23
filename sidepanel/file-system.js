// sidepanel/file-system.js

const FileSystemModule = {
    dbName: "YouTubeNotesFSPrefs",
    dbVersion: 1,
    db: null,
    dirHandle: null,
    lastPdfDirHandle: null,
    permissionNeedsUserGesture: false,

    isBraveBrowser() {
        try {
            return !!(navigator.brave && typeof navigator.brave.isBrave === 'function');
        } catch (e) {
            return false;
        }
    },

    getBraveFolderPickerMessage() {
        return [
            "Brave is blocking the folder picker for this extension.",
            "",
            "To use full local auto-save (same as Chrome/Edge):",
            "1) Open brave://flags",
            "2) Search: File System Access API",
            "3) Set it to Enabled",
            "4) Relaunch Brave",
            "5) Click Select Folder again in the side panel"
        ].join('\n');
    },

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (event) => {
                this.db = event.target.result;
                if (!this.db.objectStoreNames.contains('prefs')) {
                    this.db.createObjectStore('prefs');
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => reject(event.target.error);
        });
    },

    async saveHandle(handle) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['prefs'], 'readwrite');
            const store = transaction.objectStore('prefs');
            const request = store.put(handle, 'targetDirectory');
            request.onsuccess = () => {
                this.dirHandle = handle;
                this.permissionNeedsUserGesture = false;
                resolve();
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    async loadHandle() {
        return new Promise((resolve) => {
            const transaction = this.db.transaction(['prefs'], 'readonly');
            const store = transaction.objectStore('prefs');
            const request = store.get('targetDirectory');
            const pdfRequest = store.get('lastPdfDirectory');

            let count = 0;
            let results = { root: null, pdf: null };

            request.onsuccess = () => {
                results.root = request.result;
                if (++count === 2) resolve(results);
            };
            pdfRequest.onsuccess = () => {
                results.pdf = pdfRequest.result;
                if (++count === 2) resolve(results);
            };
            request.onerror = (e) => {
                console.error("FileSystem: loadHandle root failed:", e.target.error);
                if (++count === 2) resolve(results);
            };
            pdfRequest.onerror = (e) => {
                console.error("FileSystem: loadHandle pdf failed:", e.target.error);
                if (++count === 2) resolve(results);
            };
        });
    },

    async savePdfHandle(handle) {
        return new Promise((resolve) => {
            const transaction = this.db.transaction(['prefs'], 'readwrite');
            const store = transaction.objectStore('prefs');
            const request = store.put(handle, 'lastPdfDirectory');
            request.onsuccess = () => {
                this.lastPdfDirHandle = handle;
                resolve();
            };
            request.onerror = () => resolve();
        });
    },

    async verifyPermission(fileHandle, readWrite, withPrompt = false) {
        if (!fileHandle) return false;

        const options = {};
        if (readWrite) {
            options.mode = 'readwrite';
        }

        // 1) Silent check (no user gesture needed)
        try {
            if ((await fileHandle.queryPermission(options)) === 'granted') {
                this.permissionNeedsUserGesture = false;
                return true;
            }
        } catch (e) {
            const name = e?.name || '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                this.permissionNeedsUserGesture = true;
            } else {
                console.warn("FileSystem: Permission query failed:", e?.message || e);
            }
        }

        this.permissionNeedsUserGesture = true;

        // 2) Prompt only when explicitly requested from a direct user gesture
        if (withPrompt) {
            try {
                if ((await fileHandle.requestPermission(options)) === 'granted') {
                    this.permissionNeedsUserGesture = false;
                    return true;
                }
            } catch (e) {
                const name = e?.name || '';
                const msg = String(e?.message || '');
                // Expected when called without direct user activation.
                if (name === 'SecurityError' || name === 'NotAllowedError' || /user activation/i.test(msg)) {
                    this.permissionNeedsUserGesture = true;
                } else {
                    console.warn("FileSystem: Failed to request permission:", e?.message || e);
                }
            }
        }

        return false;
    },

    async setup() {
        await this.initDB();
        const handles = await this.loadHandle();

        let rootState = false;

        // Load Root Handle
        if (handles.root) {
            this.dirHandle = handles.root;
            const hasPerm = await this.verifyPermission(handles.root, true, false);
            rootState = hasPerm ? true : 'needs_permission';
            if (!hasPerm) this.permissionNeedsUserGesture = true;
        }

        // Load PDF Handle
        if (handles.pdf) {
            const hasPerm = await this.verifyPermission(handles.pdf, true, false);
            if (hasPerm) this.lastPdfDirHandle = handles.pdf;
            else this.lastPdfDirHandle = handles.pdf; // Store it anyway so showSaveFilePicker can try startIn
        }

        return rootState;
    },

    async selectTargetFolder() {
        // IMPORTANT: Avoid any await before showDirectoryPicker to preserve user activation.
        const isBrave = this.isBraveBrowser();

        if (typeof window.showDirectoryPicker !== 'function') {
            if (isBrave) {
                this.showAlert(this.getBraveFolderPickerMessage());
            } else {
                this.showAlert("Your browser does not support the File System Access API. Please use a supported browser like Chrome or Edge for local folder auto-save.");
            }
            return false;
        }

        try {
            const directoryHandle = await window.showDirectoryPicker({
                mode: 'readwrite'
            });
            await this.saveHandle(directoryHandle);
            return true;
        } catch (err) {
            if (err?.name === 'AbortError') {
                return false; // User cancelled picker
            }

            // Most common false-positive in Brave: user activation is lost if picker is not called immediately.
            if (err?.name === 'SecurityError' || err?.name === 'NotAllowedError') {
                console.error("Directory picker needs direct user activation:", err);
                this.showAlert("Folder picker must be opened from a direct button click.\n\nPlease click Select Folder once again. If this keeps happening, close/reopen the side panel and try again.");
                return false;
            }

            if (isBrave) {
                const msg = String(err?.message || "");
                const looksBlockedOrUnsupported =
                    err?.name === 'NotSupportedError' ||
                    /file system access|disabled|unsupported|not supported/i.test(msg);

                if (looksBlockedOrUnsupported) {
                    console.error("Brave blocked or does not support directory picker in current mode:", err);
                    this.showAlert(this.getBraveFolderPickerMessage());
                    return false;
                }
            }

            console.error("Failed to open directory picker", err);
            this.showAlert("Could not open the folder picker. Please try again.");
            return false;
        }
    },

    /**
     * Get a file handle from the root directory with robust permission checks.
     */
    async getFile(filename, create = false) {
        if (!this.dirHandle) return null;

        // Verify root health
        const rootState = await this.isRootHandleAlive();
        if (!rootState.alive) {
            console.warn("FileSystem: Root folder missing or inaccessible.");
            this.dirHandle = null;
            return null;
        }

        if (rootState.reason === 'needs_permission') {
            this.permissionNeedsUserGesture = true;
            return null;
        }

        try {
            return await this.dirHandle.getFileHandle(filename, { create });
        } catch (err) {
            if (err.name === 'NotFoundError') return null;
            
            if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
                this.permissionNeedsUserGesture = true;
            } else {
                console.error(`FileSystem: Error getting file ${filename}:`, err);
            }
            return null;
        }
    },

    /**
     * Get the text content of a file. Returns null if file missing or error.
     */
    async getFileText(filename) {
        try {
            const fileHandle = await this.getFile(filename, false);
            if (!fileHandle) return null;
            const file = await fileHandle.getFile();
            return await file.text();
        } catch (err) {
            console.error(`FileSystem: Error reading file ${filename}:`, err);
            return null;
        }
    },

    async saveFile(filename, blobData, subFolderHandle = null, withPrompt = false) {
        const targetHandle = subFolderHandle || this.dirHandle;

        if (!targetHandle || !this.dirHandle) {
            throw new Error("No directory handle available. User must select a folder first.");
        }

        // 1. Pre-flight permission check
        const hasPerm = await this.verifyPermission(this.dirHandle, true, withPrompt);
        if (!hasPerm) {
            this.permissionNeedsUserGesture = true;
            if (withPrompt) {
                throw new Error("Permission to write to directory was denied.");
            }
            return false;
        }

        // 2. Multi-attempt save logic for transient errors (e.g. file locks)
        const maxAttempts = 3;
        const SAVE_TIMEOUT_MS = 2000; // Overall timeout for all retries combined
        const saveStartTime = Date.now();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (Date.now() - saveStartTime > SAVE_TIMEOUT_MS) {
                console.warn("FileSystem: Save timed out after " + SAVE_TIMEOUT_MS + "ms");
                break;
            }
            try {
                const fileHandle = await targetHandle.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(blobData);
                await writable.close();

                this.permissionNeedsUserGesture = false;
                return true;
            } catch (err) {
                const name = err?.name || '';

                // CRITICAL: Handle Staleness (Root folder moved or deleted)
                if (name === 'NotFoundError') {
                    console.error("FileSystem: Target location not found. Handle is stale.", err);
                    // Invalidating the root handle triggers the "Select Folder" UI automatically.
                    this.dirHandle = null;
                    return false;
                }

                if (name === 'NotAllowedError' || name === 'SecurityError') {
                    this.permissionNeedsUserGesture = true;
                    return false;
                }

                if (name === 'QuotaExceededError') {
                    console.error("FileSystem: Disk quota exceeded.", err);
                    this.showAlert("Your disk is full or the browser quota has been exceeded.\n\nPlease free up some space and try again.");
                    return false;
                }

                // Retry for generic transient errors (e.g. "The user aborted a request" or lock issues)
                if (attempt < maxAttempts) {
                    const delay = attempt * 150; // Reduced from 300ms to 150ms for faster feedback
                    console.warn(`FileSystem: Save attempt ${attempt} failed, retrying in ${delay}ms:`, err.message);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    console.error("FileSystem: Final save attempt failed:", err);
                }
            }
        }
        return false;
    },

    async saveFileAs(suggestedName, blobData) {
        const fileHandle = await this.pickPdfSaveFileHandle(suggestedName);
        if (!fileHandle) return false;
        return await this.writeFileHandle(fileHandle, blobData);
    },

    async pickPdfSaveFileHandle(suggestedName) {
        try {
            const options = {
                suggestedName: suggestedName,
                types: [{
                    description: 'PDF Document',
                    accept: { 'application/pdf': ['.pdf'] },
                }],
            };

            // Keep PDF export location independent from screenshot root folder.
            if (this.lastPdfDirHandle) {
                options.startIn = this.lastPdfDirHandle;
            } else {
                options.startIn = 'documents';
            }

            if (typeof window.showSaveFilePicker !== 'function') {
                this.showAlert("Your browser does not support the File System Access API. Please use a supported browser like Chrome or Edge.");
                return null;
            }

            let fileHandle;
            try {
                fileHandle = await window.showSaveFilePicker(options);
            } catch (pickerErr) {
                // Some browsers reject stale/unsupported startIn handles.
                if ((pickerErr?.name === 'TypeError' || pickerErr?.name === 'NotFoundError') && options.startIn) {
                    const fallbackOptions = { ...options };
                    delete fallbackOptions.startIn;
                    fileHandle = await window.showSaveFilePicker(fallbackOptions);
                } else {
                    throw pickerErr;
                }
            }

            // Remember this location for next time
            await this.savePdfHandle(fileHandle);
            return fileHandle;
        } catch (err) {
            if (err?.name === 'AbortError') return null;
            console.error("Save As picker error:", err);
            return null;
        }
    },

    async writeFileHandle(fileHandle, blobData) {
        if (!fileHandle) return false;
        try {
            const writable = await fileHandle.createWritable();
            await writable.write(blobData);
            await writable.close();
            return true;
        } catch (err) {
            if (err?.name === 'AbortError') return false;
            console.error("Write file error:", err);
            return false;
        }
    },

    sanitizeFolderName(videoTitle) {
        let safeName = "Unknown Video";
        if (videoTitle && typeof videoTitle === 'string') {
            safeName = videoTitle
                .replace(/[<>:"/\\|?*\x00-\x1F\u200B-\u200F\u2028-\u202F\uFEFF]/g, ' ')
                .replace(/\s+/g, ' ');

            const chars = Array.from(safeName);
            safeName = chars.slice(0, 100).join('');

            safeName = safeName.trim().replace(/[.\s]+$/, '').trim();
        }

        if (!safeName || safeName.length === 0) {
            safeName = "Unknown Video";
        }

        return safeName;
    },

    // Verify root handle health without misclassifying permission/context errors as "deleted".
    async isRootHandleAlive() {
        if (!this.dirHandle) return { alive: false, reason: 'missing' };

        // 1) Verify existence by trying to get a dummy handle or list entries.
        // This is the only way to reliably catch "NotFoundError" (folder moved/deleted).
        try {
            const iter = this.dirHandle.values();
            await iter.next();
            // If we get here, the directory EXISTS (even if permission is not yet granted).
        } catch (e) {
            const name = e?.name || '';

            // This is the "Stale Handle" signal.
            if (name === 'NotFoundError') {
                console.error("FileSystem: Root handle is STALE (directory deleted/moved).");
                return { alive: false, reason: 'missing' };
            }

            // Permissions errors are NOT "stale handle" signals. They just mean we need a gesture.
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                return { alive: true, reason: 'needs_permission' };
            }
        }

        // 2) Verify current permission level
        try {
            const permission = await this.dirHandle.queryPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                return { alive: true, reason: 'ok' };
            }
            return { alive: true, reason: 'needs_permission' };
        } catch (e) {
            return { alive: true, reason: 'needs_permission' };
        }
    },

    // Get or create a subdirectory handle based on a clean folder name.
    // Accepts optional videoId for robust fallback if title-based name fails.
    // Get or create a subdirectory handle based on a clean folder name.
    // VERIFICATION: If videoId is provided, we check if the folder's state file matches.
    async getVideoFolderHandle(videoTitle, createIfMissing = true, videoId = null) {
        if (!this.dirHandle) {
            return null;
        }

        if (createIfMissing) {
            const rootState = await this.isRootHandleAlive();
            if (!rootState.alive) {
                console.warn("FileSystem: Root folder no longer exists.");
                this.dirHandle = null;
                return null;
            }

            if (rootState.reason === 'needs_permission') {
                this.permissionNeedsUserGesture = true;
                return null;
            }
        }

        const baseTitle = this.sanitizeFolderName(videoTitle);
        const folderWithId = videoId ? `${baseTitle} _${videoId}` : baseTitle;

        // Strategy 1: Check if the "ID-Specific" folder exists first
        if (videoId) {
            try {
                return await this.dirHandle.getDirectoryHandle(folderWithId, { create: createIfMissing });
            } catch (e) {
                const name = e?.name || '';
                // Handle stale root detected during subfolder access
                if (name === 'NotFoundError' && createIfMissing) {
                    const rootCheck = await this.isRootHandleAlive();
                    if (!rootCheck.alive) {
                        this.dirHandle = null;
                        return null;
                    }
                }
                if (name === 'NotAllowedError' || name === 'SecurityError') {
                    this.permissionNeedsUserGesture = true;
                    return null;
                }
                // Not found is fine, move to title-based search
            }
        }

        // Strategy 2: Check the generic title folder
        try {
            const subDirHandle = await this.dirHandle.getDirectoryHandle(baseTitle, { create: false });

            // VERIFICATION: Check if this folder belongs to a DIFFERENT videoId
            if (videoId) {
                try {
                    const fileHandle = await subDirHandle.getFileHandle("video_state.json");
                    const file = await fileHandle.getFile();
                    const text = await file.text();
                    const state = JSON.parse(text);

                    if (state?.metadata?.videoId && state.metadata.videoId !== videoId) {
                        console.warn(`FileSystem: Folder "${baseTitle}" belongs to a different video (${state.metadata.videoId}). Clashing!`);
                        // Mismatch! If we need to create, use the ID-specific one
                        if (createIfMissing) {
                            return await this.dirHandle.getDirectoryHandle(folderWithId, { create: true });
                        }
                        return null; // Don't return the clashing one for loading
                    }
                } catch (readErr) {
                    // No state file found? Safe to assume it's either new or ours.
                }
            }
            return subDirHandle;
        } catch (err) {
            const name = err?.name || '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                this.permissionNeedsUserGesture = true;
                return null;
            }

            if (createIfMissing) {
                // If title-based didn't exist or clashing, create ID-specific
                try {
                    return await this.dirHandle.getDirectoryHandle(folderWithId, { create: true });
                } catch (createErr) {
                    const createErrName = createErr?.name || '';
                    if (createErrName === 'NotAllowedError' || createErrName === 'SecurityError') {
                        this.permissionNeedsUserGesture = true;
                        return null;
                    }
                    console.error("FileSystem: FAILED to create folder:", createErr);
                }
            }
            return null;
        }
    },

    // List all sub-folders in the root directory
    async listSubFolders() {
        if (!this.dirHandle) return [];
        const folders = [];
        try {
            for await (const entry of this.dirHandle.values()) {
                if (entry.kind === 'directory') {
                    folders.push(entry);
                }
            }
            return folders;
        } catch (err) {
            console.error("Failed to list sub-folders:", err);
            return [];
        }
    },

    // Delete a directory recursively
    async deleteDirectory(folderName) {
        if (!this.dirHandle) return false;
        try {
            await this.dirHandle.removeEntry(folderName, { recursive: true });
            return true;
        } catch (err) {
            console.error(`Failed to delete directory ${folderName}:`, err);
            return false;
        }
    },

    showAlert(message) {
        if (typeof window.showAlert === 'function') {
            window.showAlert(message);
        } else {
            alert(message);
        }
    }
};
