// ── YouTube Notes Pro - Refined Drawing Engine ──

let shotId, videoId;
let bgCanvas, drawCanvas, previewCanvas;
let bgCtx, drawCtx, previewCtx;
let isDrawing = false;
let startPos = { x: 0, y: 0 };
let currentTool = 'pen';
let currentColor = '#ff4757';
let currentSize = 5;
let baseImage = new Image();

// History System for Annotations
let historyStack = [];
let redoStack = [];
const MAX_HISTORY = 40;

document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    shotId = params.get('shotId');
    videoId = params.get('videoId');

    if (!shotId) return window.close();

    chrome.storage.local.get([`edit_state_${shotId}`], (result) => {
        const data = result[`edit_state_${shotId}`];
        if (!data || !data.dataUrl) return window.close();
        document.getElementById('status-text').textContent = `Editing capture from ${data.timeFormatted}`;
        initEditor(data.dataUrl);
    });
});

function initEditor(dataUrl) {
    bgCanvas = document.getElementById('bg-canvas');
    drawCanvas = document.getElementById('draw-canvas');
    previewCanvas = document.getElementById('preview-canvas');

    bgCtx = bgCanvas.getContext('2d');
    drawCtx = drawCanvas.getContext('2d');
    previewCtx = previewCanvas.getContext('2d', { alpha: true });

    baseImage.onload = () => {
        const w = baseImage.width;
        const h = baseImage.height;

        // Set all canvases to match image
        [bgCanvas, drawCanvas, previewCanvas].forEach(c => {
            c.width = w;
            c.height = h;
        });

        // Set container size
        const container = document.getElementById('canvas-container');
        container.style.width = w + 'px';
        container.style.height = h + 'px';

        // Initial background
        bgCtx.drawImage(baseImage, 0, 0);

        // Context settings
        [drawCtx, previewCtx].forEach(ctx => {
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
        });

        saveToHistory(); // Initial blank state for annotations
        setupInteractions();
    };
    baseImage.src = dataUrl;
}

function setupInteractions() {
    let points = [];

    const getPos = (e) => {
        const rect = drawCanvas.getBoundingClientRect();
        const scaleX = drawCanvas.width / rect.width;
        const scaleY = drawCanvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
            pressure: e.pressure || (e.pointerType === 'mouse' ? 0.5 : 1)
        };
    };

    drawCanvas.addEventListener('pointerdown', (e) => {
        drawCanvas.setPointerCapture(e.pointerId);
        isDrawing = true;
        const pos = getPos(e);
        startPos = pos;
        points = [pos];

        redoStack = [];
        updateHistoryButtons();

        if (currentTool === 'pen' || currentTool === 'eraser') {
            drawCtx.beginPath();
            drawCtx.moveTo(pos.x, pos.y);
        }
    });

    window.addEventListener('pointermove', (e) => {
        if (!isDrawing) return;
        const pos = getPos(e);

        if (currentTool === 'pen' || currentTool === 'eraser') {
            points.push(pos);

            if (points.length < 3) {
                // Not enough points for a curve yet, draw a simple line
                drawCtx.beginPath();
                drawCtx.lineWidth = currentSize * (pos.pressure * 1.5 || 1);
                if (currentTool === 'eraser') {
                    drawCtx.globalCompositeOperation = 'destination-out';
                } else {
                    drawCtx.globalCompositeOperation = 'source-over';
                    drawCtx.strokeStyle = currentColor;
                }
                const prev = points[points.length - 2];
                drawCtx.moveTo(prev.x, prev.y);
                drawCtx.lineTo(pos.x, pos.y);
                drawCtx.stroke();
            } else {
                drawCtx.beginPath();

                // Pressure smoothing (average last few points)
                const avgPressure = points.slice(-3).reduce((acc, p) => acc + p.pressure, 0) / 3;
                drawCtx.lineWidth = currentSize * (avgPressure * 1.5 || 1);

                if (currentTool === 'eraser') {
                    drawCtx.globalCompositeOperation = 'destination-out';
                } else {
                    drawCtx.globalCompositeOperation = 'source-over';
                    drawCtx.strokeStyle = currentColor;
                }

                // Bezier Smoothing: Midpoint logic
                const p1 = points[points.length - 3];
                const p2 = points[points.length - 2];
                const p3 = points[points.length - 1];

                const mid1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                const mid2 = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };

                drawCtx.moveTo(mid1.x, mid1.y);
                drawCtx.quadraticCurveTo(p2.x, p2.y, mid2.x, mid2.y);
                drawCtx.stroke();
            }
        } else {
            // Shapes on Preview Layer
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            drawShape(previewCtx, startPos, pos, currentTool, currentColor, currentSize);
        }
    });

    window.addEventListener('pointerup', (e) => {
        if (!isDrawing) return;
        isDrawing = false;
        drawCanvas.releasePointerCapture(e.pointerId);

        if (currentTool !== 'pen' && currentTool !== 'eraser') {
            // Commit shape from preview to drawing layer
            const pos = getPos(e);
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            drawShape(drawCtx, startPos, pos, currentTool, currentColor, currentSize);
        } else {
            // Draw the final segment
            if (points.length >= 2) {
                const last = points[points.length - 1];
                const prev = points[points.length - 2];
                drawCtx.beginPath();
                drawCtx.moveTo(prev.x, prev.y);
                drawCtx.lineTo(last.x, last.y);
                drawCtx.stroke();
            }
        }

        points = [];
        saveToHistory();
    });

    // Toolbar logic
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTool = btn.dataset.tool;
        });
    });

    document.querySelectorAll('.swatch').forEach(sw => {
        sw.addEventListener('click', () => {
            document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
            sw.classList.add('active');
            currentColor = sw.dataset.color;
            // Auto switch to pen if color selected but currently on eraser
            if (currentTool === 'eraser') {
                document.querySelector('[data-tool="pen"]').click();
            }
        });
    });

    const sizeSlider = document.getElementById('brush-size');
    const sizeVal = document.getElementById('brush-size-val');
    sizeSlider.addEventListener('input', () => {
        currentSize = sizeSlider.value;
        sizeVal.textContent = currentSize;
    });

    // History Actions
    document.getElementById('undo-btn').addEventListener('click', undo);
    document.getElementById('redo-btn').addEventListener('click', redo);

    document.getElementById('clear-btn').addEventListener('click', () => {
        if (confirm("Clear all annotations? Original image will be kept.")) {
            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
            saveToHistory();
        }
    });

    document.getElementById('cancel-edit').addEventListener('click', () => window.close());

    document.getElementById('save-edit').addEventListener('click', () => {
        // Flatten layers for saving
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = bgCanvas.width;
        finalCanvas.height = bgCanvas.height;
        const fCtx = finalCanvas.getContext('2d');

        fCtx.drawImage(bgCanvas, 0, 0);
        fCtx.drawImage(drawCanvas, 0, 0);

        chrome.runtime.sendMessage({
            action: 'screenshotEdited',
            shotId: shotId,
            dataUrl: finalCanvas.toDataURL('image/png')
        }, () => window.close());
    });
}

// ── Shape Drawing Math ───────────────────────────────────────
function drawShape(ctx, start, end, tool, color, size) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.globalCompositeOperation = 'source-over';

    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(start.x - end.x);
    const h = Math.abs(start.y - end.y);

    if (tool === 'rect') {
        ctx.strokeRect(x, y, w, h);
    } else if (tool === 'circle') {
        ctx.beginPath();
        const radius = Math.sqrt(w * w + h * h) / 2;
        const centerX = (start.x + end.x) / 2;
        const centerY = (start.y + end.y) / 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();
    } else if (tool === 'arrow') {
        drawArrow(ctx, start.x, start.y, end.x, end.y, size * 3);
    }
}

function drawArrow(ctx, fromX, fromY, toX, toY, headlen) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headlen * Math.cos(angle - Math.PI / 6), toY - headlen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headlen * Math.cos(angle + Math.PI / 6), toY - headlen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}

// ── History Engine ───────────────────────────────────────────
function saveToHistory() {
    // Only save the drawing layer
    historyStack.push(drawCanvas.toDataURL());
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    updateHistoryButtons();
}

function undo() {
    if (historyStack.length <= 1) return;
    redoStack.push(historyStack.pop());
    restoreFromData(historyStack[historyStack.length - 1]);
}

function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    historyStack.push(next);
    restoreFromData(next);
}

function restoreFromData(dataUrl) {
    const img = new Image();
    img.onload = () => {
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawCtx.globalCompositeOperation = 'source-over';
        drawCtx.drawImage(img, 0, 0);
        updateHistoryButtons();
    };
    img.src = dataUrl;
}

function updateHistoryButtons() {
    document.getElementById('undo-btn').disabled = historyStack.length <= 1;
    document.getElementById('redo-btn').disabled = redoStack.length === 0;
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z') undo();
    if (e.ctrlKey && e.key === 'y') redo();
});
