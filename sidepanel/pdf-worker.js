// PDF Generation Web Worker - Runs in background thread to prevent UI freeze
// This worker handles all CPU-intensive PDF creation operations

try {
    // Import jsPDF library into worker thread
    self.importScripts('lib/jspdf.umd.min.js');
    console.log('[PDF Worker] jsPDF loaded successfully');
} catch (importErr) {
    console.error('[PDF Worker] Failed to import jsPDF:', importErr);
    self.postMessage({ 
        success: false, 
        error: 'Failed to load PDF library: ' + importErr.message 
    });
}

self.onmessage = async function(event) {
    console.log('[PDF Worker] Received message:', event.data);
    const { screenshots, notes, metadata, title } = event.data;

    try {
        const { jsPDF } = self.jspdf;
        if (!jsPDF) {
            throw new Error('jsPDF not available in worker');
        }
        
        const doc = new jsPDF({
            orientation: 'p',
            unit: 'mm',
            format: 'a4',
            putOnlyUsedFonts: true,
            compress: true
        });
        
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 12;
        const contentWidth = pageWidth - (margin * 2);
        
        // Cover page
        doc.setFontSize(24);
        doc.setTextColor(15, 23, 42);
        doc.text(title || 'YouTube Notes', margin, 40);
        
        if (metadata?.channel) {
            doc.setFontSize(14);
            doc.setTextColor(100, 116, 139);
            doc.text(`Channel: ${metadata.channel}`, margin, 55);
        }
        
        doc.setFontSize(11);
        doc.setTextColor(100, 116, 139);
        doc.text(`Generated: ${new Date().toLocaleString()}`, margin, 70);
        doc.text(`Total Screenshots: ${screenshots.length}`, margin, 80);
        
        // Add screenshots
        let y = margin + 20;
        const lineHeight = 7;
        const imgMaxHeight = 120;
        
        for (let i = 0; i < screenshots.length; i++) {
            const shot = screenshots[i];
            
            // Check if we need a new page
            if (y > pageHeight - margin - imgMaxHeight - 20) {
                doc.addPage();
                y = margin;
            }
            
            // Screenshot header
            doc.setFontSize(10);
            doc.setFont(undefined, 'bold');
            doc.text(`Screenshot ${i + 1} - ${shot.timeFormatted || '00:00'}`, margin, y);
            y += 8;
            
            // Add image if available
            if (shot.dataUrl) {
                try {
                    let finalImgData = shot.dataUrl;
                    
                    // Web Workers don't have DOM Image objects, so jsPDF cannot parse blob: URLs directly.
                    // We must convert the blob: URL into a native base64 data string.
                    if (shot.dataUrl.startsWith('blob:')) {
                        const imgRes = await fetch(shot.dataUrl);
                        const imgBlob = await imgRes.blob();
                        const imgBuffer = await imgBlob.arrayBuffer();
                        
                        let binary = '';
                        const bytes = new Uint8Array(imgBuffer);
                        const len = bytes.byteLength;
                        const chunkSize = 8192;
                        
                        for (let j = 0; j < len; j += chunkSize) {
                            binary += String.fromCharCode.apply(null, bytes.subarray(j, j + chunkSize));
                        }
                        
                        const b64 = self.btoa(binary);
                        finalImgData = `data:${imgBlob.type || 'image/png'};base64,${b64}`;
                    }

                    const imgProps = doc.getImageProperties(finalImgData);
                    const imgWidth = contentWidth;
                    const imgHeight = (imgProps.height * imgWidth) / imgProps.width;
                    const limitedHeight = Math.min(imgHeight, imgMaxHeight);
                    
                    doc.addImage(finalImgData, imgProps.fileType || 'PNG', margin, y, imgWidth, limitedHeight, undefined, 'FAST');
                    y += limitedHeight + 5;
                } catch (imgErr) {
                    console.warn('Failed to add image to PDF:', imgErr);
                }
            }
            
            // Add notes if available
            if (shot.noteHtml) {
                const noteText = stripHtml(shot.noteHtml);
                if (noteText.trim().length > 0) {
                    doc.setFontSize(9);
                    doc.setFont(undefined, 'normal');
                    doc.setTextColor(47, 61, 74);
                    
                    const splitText = doc.splitTextToSize(noteText, contentWidth);
                    doc.text(splitText, margin, y);
                    y += (splitText.length * lineHeight) + 10;
                }
            }
            
            y += 5; // Gap between screenshots
            
            // Send progress update on every screenshot (ensures UI doesn't look frozen on small sets)
            self.postMessage({ 
                type: 'progress', 
                percent: Math.round(((i + 1) / screenshots.length) * 100) 
            });
        }
        
        // Output as blob
        const pdfBlob = doc.output('blob');
        
        // Send result back to main thread
        self.postMessage({ 
            success: true, 
            blob: pdfBlob 
        });
        
    } catch (error) {
        console.error('PDF worker error:', error);
        self.postMessage({ 
            success: false, 
            error: error.message 
        });
    }
};

// Helper function to strip HTML tags (worker-safe, no DOM access)
function stripHtml(html) {
    if (!html) return '';
    // Replace <br> and <p> with newlines
    let text = html.replace(/<br\s*[\/]?>/gi, '\n').replace(/<\/p>/gi, '\n');
    // Strip all other HTML tags
    text = text.replace(/<[^>]*>?/gm, '');
    // Decode basic HTML entities (e.g. &nbsp; &amp; &lt; &gt;)
    return text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
