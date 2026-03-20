
// sidepanel/note-editor-big.js

(function () {
    const editor = document.getElementById('editor');
    const toolbar = document.getElementById('toolbar');
    const videoInfo = document.getElementById('video-info');
    const btnSave = document.getElementById('btn-save');
    const btnCancel = document.getElementById('btn-cancel');

    // Get parameters from URL
    const urlParams = new URLSearchParams(window.location.search);
    const shotId = urlParams.get('shotId');
    const videoTitle = urlParams.get('videoTitle');
    const videoId = urlParams.get('videoId');

    if (videoTitle) {
        videoInfo.textContent = `Video: ${videoTitle}`;
    }

    // Load content from opener if available, otherwise from storage
    function loadInitialContent() {
        // Try to get data from chrome storage if opener isn't available
        chrome.storage.local.get(['bigEditorBuffer'], (result) => {
            if (result.bigEditorBuffer && result.bigEditorBuffer.shotId === shotId) {
                editor.innerHTML = result.bigEditorBuffer.html;
            }
        });
    }

    loadInitialContent();

    // Toolbar logic
    toolbar.querySelectorAll('button:not(.list-style-btn)').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const cmd = btn.getAttribute('data-cmd');
            const val = btn.getAttribute('data-val');
            document.execCommand(cmd, false, val || null);
            editor.focus();
        });
    });

    toolbar.querySelectorAll('.list-style-btn').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            editor.focus();
            document.execCommand('insertText', false, btn.getAttribute('data-marker') + ' ');
        });
    });

    // Auto-List Continuation Logic
    editor.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;

        const selection = window.getSelection();
        if (!selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const container = range.startContainer;
        const lineText = container.textContent || "";

        const markers = ["→", "✓"];
        let activeMarker = null;

        for (const m of markers) {
            if (lineText.trim().startsWith(m)) {
                activeMarker = m;
                break;
            }
        }

        if (activeMarker) {
            // Exit list if line only contains marker
            if (lineText.trim() === activeMarker) {
                event.preventDefault();
                if (container.nodeType === Node.TEXT_NODE) {
                    container.textContent = "";
                } else {
                    container.innerHTML = "";
                }
                return;
            }

            // Continue list
            event.preventDefault();
            document.execCommand('insertHTML', false, `<br>${activeMarker} &nbsp;`);
        }
    });

    // Save and Sync
    btnSave.addEventListener('click', () => {
        const finalHtml = editor.innerHTML;

        // Use messaging to sync back to the panel
        chrome.runtime.sendMessage({
            action: 'syncNoteEdit',
            shotId: shotId,
            videoId: videoId,
            html: finalHtml
        }, (response) => {
            window.close();
        });
    });

    btnCancel.addEventListener('click', async () => {
        const confirmed = await showConfirm("Discard unsaved changes?");
        if (confirmed) window.close();
    });

    // ── CUSTOM DIALOG OVERLAY ───────────────────────────────────
    function showConfirm(message) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('custom-prompt-overlay');
            const msgEl = document.getElementById('custom-prompt-message');
            const confirmBtn = document.getElementById('custom-prompt-confirm');
            const cancelBtn = document.getElementById('custom-prompt-cancel');

            msgEl.textContent = message;
            cancelBtn.classList.remove('hidden');
            overlay.classList.remove('hidden');

            const cleanup = (val) => {
                overlay.classList.add('hidden');
                confirmBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(val);
            };

            confirmBtn.onclick = () => cleanup(true);
            cancelBtn.onclick = () => cleanup(false);
        });
    }

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
        const key = String(e.key || '').toLowerCase();
        const withModifier = e.ctrlKey || e.metaKey;

        if (e.key === 'Escape') {
            e.preventDefault();
            window.close();
        }

        if (withModifier && key === 's') {
            e.preventDefault();
            btnSave.click();
        }
    });

    editor.focus();
})();
