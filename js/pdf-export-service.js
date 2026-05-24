import { conversationExtractor } from './conversation-extractor.js';

const JSPDF_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const DEFAULT_FILENAME_FALLBACK = 'Aetheria-AI-Conversation';

class PDFExportService {
    constructor() {
        this.isGenerating = false;
        this.loaderPromise = null;
        this.imageMetadataCache = new Map();
        this.emojiImageCache = new Map();
    }

    async exportEntireConversationPdf() {
        if (this.isGenerating) {
            throw new Error('PDF generation is already in progress.');
        }

        this.isGenerating = true;
        this.debugLog('export:start', {
            href: window.location?.href || null,
            hasShareApi: typeof navigator.share === 'function',
            hasCanShare: typeof navigator.canShare === 'function',
            userAgent: navigator.userAgent,
        });

        try {
            const conversation = await conversationExtractor.extractConversation();
            this.debugLog('extract:done', {
                conversationId: conversation.conversationId,
                title: conversation.title,
                turnCount: conversation.turns.length,
                sessionFiles: conversation.sessionContent?.files?.length || 0,
                sessionExecutions: conversation.sessionContent?.executions?.length || 0,
            });
            const jsPDFCtor = await this.ensureJsPdf();
            const previewPdf = await this.buildPdfDocument(jsPDFCtor, conversation, {
                fileSizeLabel: 'Calculating...',
            });
            const previewBlob = previewPdf.output('blob');
            const fileSizeLabel = this.formatFileSize(previewBlob.size);

            const pdf = await this.buildPdfDocument(jsPDFCtor, conversation, {
                fileSizeLabel,
            });
            const pdfBlob = pdf.output('blob');
            this.debugLog('pdf:blob-ready', {
                blobSizeBytes: pdfBlob.size,
                blobType: pdfBlob.type,
                fileSizeLabel,
            });
            return this.shareOrDownload(pdfBlob, conversation);
        } finally {
            this.isGenerating = false;
            this.debugLog('export:end', {});
        }
    }

    async buildPdfDocument(jsPDFCtor, conversation, options = {}) {
        const pdf = new jsPDFCtor({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4',
            compress: true,
        });

        await this.renderConversationPdf(pdf, conversation, options);
        return pdf;
    }

    async ensureJsPdf() {
        if (window.jspdf?.jsPDF) {
            return window.jspdf.jsPDF;
        }

        if (!this.loaderPromise) {
            this.loaderPromise = new Promise((resolve, reject) => {
                const existingScript = document.getElementById('jspdf-export-service-script');
                if (existingScript) {
                    existingScript.addEventListener('load', () => resolve(window.jspdf?.jsPDF));
                    existingScript.addEventListener('error', () => reject(new Error('Failed to load PDF generator.')));
                    return;
                }

                const script = document.createElement('script');
                script.id = 'jspdf-export-service-script';
                script.src = JSPDF_CDN_URL;
                script.async = true;
                script.onload = () => {
                    this.debugLog('jspdf:loaded', { src: JSPDF_CDN_URL });
                    if (window.jspdf?.jsPDF) {
                        resolve(window.jspdf.jsPDF);
                        return;
                    }
                    reject(new Error('PDF generator loaded without exposing jsPDF.'));
                };
                script.onerror = () => {
                    this.debugLog('jspdf:error', { src: JSPDF_CDN_URL });
                    reject(new Error('Failed to load PDF generator.'));
                };
                document.head.appendChild(script);
            });
        }

        return this.loaderPromise;
    }

    async renderConversationPdf(pdf, conversation, options = {}) {
        const layout = {
            pageWidth: pdf.internal.pageSize.getWidth(),
            pageHeight: pdf.internal.pageSize.getHeight(),
            margin: 14,
        };
        layout.contentWidth = layout.pageWidth - (layout.margin * 2);
        layout.maxY = layout.pageHeight - 16;

        let cursorY = layout.margin;

        pdf.setFillColor(20, 26, 35);
        pdf.roundedRect(layout.margin, cursorY, layout.contentWidth, 33, 4, 4, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(12);
        pdf.text('aetheria ai', layout.margin + 8, cursorY + 8.5);
        pdf.setFontSize(16);
        await this.drawRichTextLine(
            pdf,
            conversation.title || 'Aetheria AI Conversation',
            layout.margin + 8,
            cursorY + 16.2,
            { fontSize: 16 }
        );
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8.8);
        pdf.setTextColor(219, 225, 231);
        cursorY += 41;

        pdf.setDrawColor(224, 231, 239);
        pdf.line(layout.margin, cursorY - 2, layout.pageWidth - layout.margin, cursorY - 2);

        for (const [index, turn] of conversation.turns.entries()) {
            cursorY = await this.renderTurn(pdf, turn, index, cursorY, layout);
        }

        cursorY = this.renderSessionContentAppendix(pdf, conversation, cursorY, layout);

        const totalPages = pdf.getNumberOfPages();
        const fileSizeLabel = options.fileSizeLabel || 'Unknown';
        pdf.setPage(1);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8.8);
        pdf.setTextColor(219, 225, 231);
        pdf.text(`Date & Time: ${this.formatDateTime(conversation.exportedAt)}`, layout.margin + 50, layout.margin + 22.5);
        pdf.text(`Size: ${fileSizeLabel}`, layout.margin + 50, layout.margin + 28.2);
        pdf.text(`Total Pages: ${totalPages}`, layout.pageWidth - layout.margin - 8, layout.margin + 22.5, { align: 'right' });
        pdf.text(`Messages: ${conversation.turns.length}`, layout.pageWidth - layout.margin - 8, layout.margin + 28.2, { align: 'right' });

        for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
            pdf.setPage(pageNumber);
            pdf.setDrawColor(230, 235, 240);
            pdf.line(layout.margin, layout.pageHeight - 12, layout.pageWidth - layout.margin, layout.pageHeight - 12);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.setTextColor(120, 130, 145);
            pdf.text(`aetheria ai | Page ${pageNumber} of ${totalPages}`, layout.pageWidth / 2, layout.pageHeight - 7, { align: 'center' });
        }
    }

    async renderTurn(pdf, turn, index, cursorY, layout) {
        const isUser = turn.role === 'user';
        const title = isUser ? 'User' : 'Aetheria AI';
        const cardFill = isUser ? [240, 247, 255] : [247, 248, 250];
        const accentFill = isUser ? [47, 111, 237] : [15, 118, 110];
        const attachmentGroups = [];

        if (Array.isArray(turn.attachments?.files) && turn.attachments.files.length > 0) {
            attachmentGroups.push({ label: 'Attached files', items: turn.attachments.files });
        }
        if (Array.isArray(turn.attachments?.sessions) && turn.attachments.sessions.length > 0) {
            attachmentGroups.push({ label: 'Referenced chats', items: turn.attachments.sessions });
        }

        const textLines = pdf.splitTextToSize(turn.text || '[Empty message]', layout.contentWidth - 16);
        const estimatedHeight = await this.measureTurnHeight(pdf, textLines, attachmentGroups, layout);

        if (cursorY + estimatedHeight > layout.maxY) {
            pdf.addPage();
            cursorY = layout.margin;
        }

        const cardY = cursorY;
        pdf.setFillColor(...cardFill);
        pdf.roundedRect(layout.margin, cardY, layout.contentWidth, estimatedHeight, 4, 4, 'F');

        pdf.setFillColor(...accentFill);
        pdf.roundedRect(layout.margin + 6, cardY + 6, 28, 7, 3, 3, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(9);
        pdf.setTextColor(255, 255, 255);
        pdf.text(title, layout.margin + 20, cardY + 10.8, { align: 'center' });

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        pdf.setTextColor(120, 130, 145);
        pdf.text(`Turn ${index + 1}`, layout.pageWidth - layout.margin - 6, cardY + 10.8, { align: 'right' });

        let innerY = cardY + 18;
        pdf.setTextColor(24, 32, 45);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10.5);
        for (const line of textLines) {
            await this.drawRichTextLine(pdf, line, layout.margin + 8, innerY, { fontSize: 10.5 });
            innerY += 5;
        }

        for (const group of attachmentGroups) {
            innerY += 2;
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            pdf.setTextColor(67, 76, 94);
            pdf.text(group.label, layout.margin + 8, innerY);
            innerY += 5;

            for (const item of group.items) {
                if (item.kind === 'session') {
                    pdf.setFont('helvetica', 'normal');
                    pdf.setFontSize(9);
                    pdf.setTextColor(55, 65, 81);
                    const sessionLines = pdf.splitTextToSize(
                        `- ${item.title} (${item.messageCount || 0} runs)`,
                        layout.contentWidth - 20
                    );
                    sessionLines.forEach((line) => {
                        pdf.text(line, layout.margin + 11, innerY);
                        innerY += 4.5;
                    });
                    innerY += 1;
                    continue;
                }

                const descriptor = [item.name, item.type].filter(Boolean).join(' | ');
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(9);
                pdf.setTextColor(55, 65, 81);
                const attachmentLines = pdf.splitTextToSize(`- ${descriptor}`, layout.contentWidth - 20);
                attachmentLines.forEach((line) => {
                    pdf.text(line, layout.margin + 11, innerY);
                    innerY += 4.5;
                });

                if (item.textExcerpt) {
                    pdf.setFont('courier', 'normal');
                    pdf.setFontSize(8);
                    pdf.setTextColor(87, 96, 112);
                    const excerptLines = pdf.splitTextToSize(item.textExcerpt, layout.contentWidth - 28);
                    excerptLines.slice(0, 3).forEach((line) => {
                        pdf.text(line, layout.margin + 15, innerY);
                        innerY += 4;
                    });
                }

                if (item.previewUrl && item.previewUrl.startsWith('data:image/')) {
                    innerY = await this.addImageAttachment(pdf, item.previewUrl, layout.margin + 15, innerY, layout.contentWidth - 30, layout);
                }

                innerY += 2;
            }
        }

        return Math.max(innerY + 5, cardY + estimatedHeight + 6);
    }

    async measureTurnHeight(pdf, textLines, attachmentGroups, layout) {
        let height = 20 + (textLines.length * 5);

        for (const group of attachmentGroups) {
            height += 7;

            for (const item of group.items) {
                if (item.kind === 'session') {
                    const lines = pdf.splitTextToSize(
                        `- ${item.title} (${item.messageCount || 0} runs)`,
                        layout.contentWidth - 20
                    );
                    height += lines.length * 4.5 + 1;
                    continue;
                }

                const descriptor = [item.name, item.type].filter(Boolean).join(' | ');
                const attachmentLines = pdf.splitTextToSize(`- ${descriptor}`, layout.contentWidth - 20);
                height += attachmentLines.length * 4.5;

                if (item.textExcerpt) {
                    const excerptLines = pdf.splitTextToSize(item.textExcerpt, layout.contentWidth - 28);
                    height += Math.min(excerptLines.length, 3) * 4;
                }

                if (item.previewUrl && item.previewUrl.startsWith('data:image/')) {
                    const metadata = await this.getImageMetadata(item.previewUrl);
                    const ratio = metadata.width > 0 && metadata.height > 0 ? metadata.height / metadata.width : 0.75;
                    const width = Math.min(54, layout.contentWidth - 30);
                    const imageHeight = Math.min(42, width * ratio);
                    height += imageHeight + 4;
                }

                height += 2;
            }
        }

        return height + 8;
    }

    renderSessionContentAppendix(pdf, conversation, cursorY, layout) {
        const files = Array.isArray(conversation?.sessionContent?.files)
            ? conversation.sessionContent.files
            : [];
        const executions = Array.isArray(conversation?.sessionContent?.executions)
            ? conversation.sessionContent.executions
            : [];

        if (files.length === 0 && executions.length === 0) {
            return cursorY;
        }

        const ensureSpace = (requiredHeight = 10) => {
            if (cursorY + requiredHeight <= layout.maxY) {
                return;
            }
            pdf.addPage();
            cursorY = layout.margin;
        };

        ensureSpace(18);
        cursorY += 2;
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(11);
        pdf.setTextColor(24, 32, 45);
        pdf.text('Frontend Session Content', layout.margin, cursorY);
        cursorY += 6;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8.5);
        pdf.setTextColor(96, 106, 123);
        pdf.text('Included from currently visible frontend context panels.', layout.margin, cursorY);
        cursorY += 6;

        if (files.length > 0) {
            ensureSpace(8);
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9.5);
            pdf.setTextColor(34, 44, 62);
            pdf.text(`Files (${files.length})`, layout.margin, cursorY);
            cursorY += 5;

            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(9);
            files.forEach((file) => {
                const line = [file.name, file.meta].filter(Boolean).join(' | ');
                const lines = pdf.splitTextToSize(`- ${line}`, layout.contentWidth - 2);
                ensureSpace((lines.length * 4.5) + 1);
                lines.forEach((textLine) => {
                    pdf.text(textLine, layout.margin + 2, cursorY);
                    cursorY += 4.2;
                });
                cursorY += 0.8;
            });
        }

        if (executions.length > 0) {
            ensureSpace(8);
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9.5);
            pdf.setTextColor(34, 44, 62);
            pdf.text(`Terminal Logs (${executions.length})`, layout.margin, cursorY);
            cursorY += 5;

            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(9);
            executions.forEach((execution) => {
                const line = [execution.command, execution.exit].filter(Boolean).join(' | ');
                const lines = pdf.splitTextToSize(`- ${line}`, layout.contentWidth - 2);
                ensureSpace((lines.length * 4.5) + 1);
                lines.forEach((textLine) => {
                    pdf.text(textLine, layout.margin + 2, cursorY);
                    cursorY += 4.2;
                });
                cursorY += 0.8;
            });
        }

        return cursorY + 2;
    }

    async addImageAttachment(pdf, dataUrl, x, y, maxWidth, layout) {
        const metadata = await this.getImageMetadata(dataUrl);
        const ratio = metadata.width > 0 && metadata.height > 0 ? metadata.height / metadata.width : 0.75;
        const width = Math.min(54, maxWidth);
        const height = Math.min(42, width * ratio);

        if (y + height > layout.maxY) {
            pdf.addPage();
            y = layout.margin;
        }

        pdf.addImage(dataUrl, metadata.format, x, y, width, height, undefined, 'FAST');
        return y + height + 4;
    }

    getImageMetadata(dataUrl) {
        if (this.imageMetadataCache.has(dataUrl)) {
            return Promise.resolve(this.imageMetadataCache.get(dataUrl));
        }

        return new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
                const format = dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
                const metadata = {
                    width: image.naturalWidth || image.width || 1,
                    height: image.naturalHeight || image.height || 1,
                    format,
                };
                this.imageMetadataCache.set(dataUrl, metadata);
                resolve(metadata);
            };
            image.onerror = () => {
                const metadata = { width: 1, height: 1, format: 'JPEG' };
                this.imageMetadataCache.set(dataUrl, metadata);
                resolve(metadata);
            };
            image.src = dataUrl;
        });
    }

    async shareOrDownload(blob, conversation) {
        const filename = this.buildFilename(conversation.title);
        const file = new File([blob], filename, { type: 'application/pdf' });
        this.debugLog('shareOrDownload:start', {
            filename,
            fileSizeBytes: file.size,
            canUseWebShare: typeof navigator.share === 'function',
            platform: 'web',
        });

        if (navigator.share) {
            try {
                if (!navigator.canShare || navigator.canShare({ files: [file] })) {
                    this.debugLog('share:web-share-attempt', { filename });
                    await navigator.share({
                        title: conversation.title || 'Aetheria AI Conversation',
                        text: 'Aetheria AI conversation export',
                        files: [file],
                    });
                    this.debugLog('share:web-share-success', { filename });
                    return { action: 'shared', filename };
                }
                this.debugLog('share:web-share-unavailable-for-files', { filename });
            } catch (error) {
                this.debugLog('share:web-share-error', {
                    filename,
                    name: error?.name || 'UnknownError',
                    message: error?.message || '',
                });
                if (error?.name === 'AbortError') {
                    throw error;
                }
            }
        }

        const pickerSaved = await this.trySaveWithFilePicker(blob, filename);
        if (pickerSaved) {
            return { action: 'saved', filename };
        }

        const objectUrl = URL.createObjectURL(blob);
        try {
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            this.debugLog('share:download-triggered', {
                filename,
                objectUrlPrefix: objectUrl.slice(0, 32),
            });
            return { action: 'downloaded', filename };
        } finally {
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
        }
    }

    getNativePdfPlugin() {
        return null;
    }

    async tryNativeSaveAndShare(blob, filename, title) {
        const plugin = this.getNativePdfPlugin();
        if (!plugin) {
            return null;
        }

        const base64 = await this.blobToBase64(blob);
        this.debugLog('native-plugin:save-attempt', {
            filename,
            base64Bytes: base64.length,
        });

        // Save first so the file is guaranteed to exist on-device even if share is canceled.
        const saveResult = await plugin.savePdfToDownloads({
            base64,
            filename,
        });

        this.debugLog('native-plugin:save-success', {
            filename,
            uri: saveResult?.uri || null,
            bytes: saveResult?.bytes || null,
        });

        // Then try to open the native share sheet. If this fails, we still report saved.
        try {
            this.debugLog('native-plugin:share-attempt', { filename });
            const shareResult = await plugin.sharePdf({
                base64,
                filename,
                title: title || 'Aetheria AI Conversation',
                text: 'Aetheria AI conversation export',
            });
            this.debugLog('native-plugin:share-success', {
                filename,
                cacheUri: shareResult?.cacheUri || null,
            });

            return {
                action: 'saved-and-shared-native',
                filename,
                uri: saveResult?.uri || null,
            };
        } catch (error) {
            this.debugLog('native-plugin:share-error', {
                filename,
                name: error?.name || 'UnknownError',
                message: error?.message || '',
            });
            return {
                action: 'saved-native',
                filename,
                uri: saveResult?.uri || null,
            };
        }
    }

    async drawRichTextLine(pdf, text, x, y, options = {}) {
        const raw = String(text || '');
        const tokens = this.tokenizeWithEmoji(raw);
        const fontSize = Number(options.fontSize || pdf.getFontSize() || 10);
        const emojiBox = fontSize * 0.72;
        let cursorX = x;

        for (const token of tokens) {
            if (token.type === 'text') {
                const safeText = this.sanitizePdfText(token.value);
                if (!safeText) {
                    continue;
                }
                pdf.text(safeText, cursorX, y);
                cursorX += pdf.getTextWidth(safeText);
                continue;
            }

            const dataUrl = this.getEmojiImageDataUrl(token.value);
            if (!dataUrl) {
                continue;
            }
            pdf.addImage(dataUrl, 'PNG', cursorX, y - (emojiBox * 0.76), emojiBox, emojiBox, undefined, 'FAST');
            cursorX += emojiBox * 0.84;
        }
    }

    tokenizeWithEmoji(text) {
        const tokens = [];
        const emojiRegex = /\p{Extended_Pictographic}/u;
        let textBuffer = '';

        for (const char of text) {
            if (emojiRegex.test(char)) {
                if (textBuffer) {
                    tokens.push({ type: 'text', value: textBuffer });
                    textBuffer = '';
                }
                tokens.push({ type: 'emoji', value: char });
            } else {
                textBuffer += char;
            }
        }

        if (textBuffer) {
            tokens.push({ type: 'text', value: textBuffer });
        }

        return tokens;
    }

    getEmojiImageDataUrl(emoji) {
        if (this.emojiImageCache.has(emoji)) {
            return this.emojiImageCache.get(emoji);
        }

        try {
            const canvas = document.createElement('canvas');
            canvas.width = 96;
            canvas.height = 96;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return null;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '72px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif';
            ctx.fillText(emoji, canvas.width / 2, canvas.height / 2 + 2);

            const dataUrl = canvas.toDataURL('image/png');
            this.emojiImageCache.set(emoji, dataUrl);
            return dataUrl;
        } catch (_) {
            return null;
        }
    }

    sanitizePdfText(text) {
        return String(text || '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .replace(/\s+/g, ' ');
    }

    stripEmoji(text) {
        return String(text || '')
            .replace(/\p{Extended_Pictographic}/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    buildFilename(title) {
        const cleanedTitle = String(title || '')
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);

        const baseName = cleanedTitle || DEFAULT_FILENAME_FALLBACK;
        return `${baseName}.pdf`;
    }

    formatDateTime(value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) {
            return new Date().toLocaleString();
        }

        return date.toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    formatFileSize(sizeBytes) {
        const size = Number(sizeBytes || 0);
        if (size <= 0) {
            return '0 B';
        }
        const units = ['B', 'KB', 'MB', 'GB'];
        let unitIndex = 0;
        let value = size;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
        return `${value.toFixed(precision)} ${units[unitIndex]}`;
    }

    async trySaveWithFilePicker(blob, filename) {
        if (typeof window.showSaveFilePicker !== 'function') {
            this.debugLog('save-picker:unavailable', {});
            return false;
        }

        try {
            this.debugLog('save-picker:attempt', { filename });
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: 'PDF Document',
                    accept: { 'application/pdf': ['.pdf'] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            this.debugLog('save-picker:success', { filename });
            return true;
        } catch (error) {
            this.debugLog('save-picker:error', {
                filename,
                name: error?.name || 'UnknownError',
                message: error?.message || '',
            });
            if (error?.name === 'AbortError') {
                throw error;
            }
            return false;
        }
    }

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = String(reader.result || '');
                const commaIndex = result.indexOf(',');
                resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
            };
            reader.onerror = (error) => reject(error);
            reader.readAsDataURL(blob);
        });
    }

    debugLog(event, data = {}) {
        const payload = {
            ts: new Date().toISOString(),
            event,
            ...data,
        };

        if (!window.__pdfExportDebugLog) {
            window.__pdfExportDebugLog = [];
        }
        window.__pdfExportDebugLog.push(payload);
        window.__pdfExportDebugLast = payload;

        try {
            console.log('[PDFExport]', payload);
            // Easier to read in Android logcat than [object Object]
            console.log(`[PDFExportJSON] ${JSON.stringify(payload)}`);
        } catch (_) {
            // no-op
        }
    }
}

export const pdfExportService = new PDFExportService();
