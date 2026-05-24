/**
 * Screen Analysis Manager
 * Handles the Mindspace functionality - storing and displaying screen analysis history
 * Inspired by OnePlus Mind Space UI
 * 
 * Key Features:
 * - Deduplication using unique analysis IDs
 * - Base64 image storage for reliable WebView display
 * - Automatic title extraction from AI response
 * - OnePlus-inspired card UI
 */

export class ScreenAnalysisManager {
    constructor(aios) {
        this.aios = aios;
        this.STORAGE_KEY = 'mindspace_history';
        this.history = this.loadHistory();
        this.currentDetailItem = null;
    }

    /**
     * Load history from localStorage
     */
    loadHistory() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error("Failed to load Mindspace history", e);
            return [];
        }
    }

    /**
     * Save history to localStorage
     */
    saveHistory() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.history));
        } catch (e) {
            console.error("Failed to save Mindspace history", e);
        }
    }

    /**
     * Handle incoming analysis result from native layer
     * @param {string} analysisId - Unique ID for this analysis (prevents duplicates)
     * @param {string} text - The AI analysis text
     * @param {string} imageData - Base64 encoded image or empty string
     * @param {number} timestamp - Unix timestamp in milliseconds
     */
    handleResult(analysisId, text, imageData, timestamp) {
        console.log("Received Screen Analysis Result, ID:", analysisId);

        const normalized = {
            id: analysisId,
            timestamp: timestamp || Date.now(),
            title: this.extractTitle(text),
            text,
            imageData,
        };

        this.upsertItem(normalized, { showDetail: true });
    }

    mergeNativeAnalyses(analyses = []) {
        if (!Array.isArray(analyses) || analyses.length === 0) {
            return;
        }

        analyses.forEach((record) => {
            if (!record) return;
            const id = record.id || record.analysisId || record.analysis_id;
            if (!id) return;

            const text = record.text || record.result || '';
            const imageData = record.imageData || record.image_base64 || record.image || '';
            const timestamp = Number(record.timestamp || record.createdAt || record.created_at || Date.now());
            const title = record.title || this.extractTitle(text);

            this.upsertItem({ id, text, imageData, timestamp, title }, { showDetail: false, save: false });
        });

        this.history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        if (this.history.length > 50) {
            this.history = this.history.slice(0, 50);
        }
        this.saveHistory();
    }

    upsertItem(item, options = {}) {
        const { showDetail = false, save = true } = options;
        const existingIndex = this.history.findIndex(entry => entry.id === item.id);

        if (existingIndex !== -1) {
            const existing = this.history[existingIndex];
            this.history[existingIndex] = {
                ...existing,
                ...item,
                title: item.title || existing.title || this.extractTitle(item.text || existing.text),
            };
            if (save) this.saveHistory();
            if (showDetail) this.showDetailView(this.history[existingIndex]);
            return this.history[existingIndex];
        }

        const newItem = {
            id: item.id,
            timestamp: item.timestamp || Date.now(),
            title: item.title || this.extractTitle(item.text),
            text: item.text || '',
            imageData: item.imageData || '',
        };

        this.history.unshift(newItem);
        if (this.history.length > 50) {
            this.history = this.history.slice(0, 50);
        }
        if (save) this.saveHistory();
        if (showDetail) this.showDetailView(newItem);
        return newItem;
    }

    /**
     * Extract a meaningful title from the analysis text
     */
    extractTitle(text) {
        if (!text) return "Screen Analysis";

        // Remove markdown formatting
        let cleaned = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^#+\s*/gm, '');

        // Get first line or first sentence
        const lines = cleaned.split('\n').filter(l => l.trim().length > 0);
        const firstLine = lines[0] || '';

        // Try to extract a meaningful title
        let title = firstLine.trim();

        // If first line is too long, try first sentence
        if (title.length > 60) {
            const firstSentence = cleaned.split(/[.!?]/)[0].trim();
            title = firstSentence.length < 60 ? firstSentence : title.substring(0, 57) + '...';
        }

        // Truncate if still too long
        if (title.length > 50) {
            title = title.substring(0, 47) + '...';
        }

        return title || "Screen Analysis";
    }

    /**
     * Extract a short preview from the analysis text
     */
    extractPreview(text, maxLength = 100) {
        if (!text) return "";

        // Remove markdown and get clean text
        let cleaned = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^#+\s*/gm, '');

        // Get first meaningful content
        const lines = cleaned.split('\n').filter(l => l.trim().length > 0);
        let preview = lines.slice(0, 3).join(' ').trim();

        if (preview.length > maxLength) {
            preview = preview.substring(0, maxLength - 3) + '...';
        }

        return preview;
    }

    /**
     * Format timestamp for display
     */
    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        const timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        if (diffDays === 0) {
            return `Today ${timeStr}`;
        } else if (diffDays === 1) {
            return `Yesterday ${timeStr}`;
        } else {
            return date.toLocaleDateString('en-US', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            }) + ` ${timeStr}`;
        }
    }

    /**
     * Render the Mindspace list view
     */
    renderMindspace(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (this.history.length === 0) {
            container.innerHTML = `
                <div class="mindspace-empty">
                    <i class="fi fi-tr-brain"></i>
                    <h3>No analyses yet</h3>
                    <p>Use the "Analyze Screen" tile in your Quick Settings to capture and analyze any screen.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.history.map(item => `
            <div class="mindspace-card" data-id="${item.id}">
                <div class="mindspace-card-content">
                    <div class="mindspace-card-text">
                        <h3 class="mindspace-card-title">${this.escapeHtml(item.title)}</h3>
                        <p class="mindspace-card-preview">${this.escapeHtml(this.extractPreview(item.text))}</p>
                        <div class="mindspace-card-meta">
                            <i class="fi fi-tr-clock"></i>
                            <span>${this.formatTimestamp(item.timestamp)}</span>
                        </div>
                    </div>
                    <div class="mindspace-card-thumbnail">
                        ${item.imageData ?
                `<img src="${item.imageData}" alt="Screenshot" onerror="this.style.display='none'; this.parentElement.innerHTML='<i class=\\'fi fi-tr-picture\\'></i>';">` :
                '<i class="fi fi-tr-picture"></i>'}
                    </div>
                </div>
            </div>
        `).join('');

        // Add click listeners
        container.querySelectorAll('.mindspace-card').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.dataset.id;
                const item = this.history.find(i => i.id === id);
                if (item) this.showDetailView(item);
            });
        });
    }

    /**
     * Show the detail view for an analysis item
     */
    showDetailView(item) {
        this.currentDetailItem = item;

        // Create or get the detail panel
        let panel = document.getElementById('mindspace-detail-panel');
        if (!panel) {
            panel = this.createDetailPanel();
        }

        // Populate the panel
        const imageContainer = panel.querySelector('.detail-image-container');
        const titleEl = panel.querySelector('.detail-title');
        const metaEl = panel.querySelector('.detail-meta');
        const contentEl = panel.querySelector('.detail-content');

        // Set image
        if (item.imageData) {
            imageContainer.innerHTML = `<img src="${item.imageData}" alt="Screenshot" class="detail-screenshot">`;
        } else {
            imageContainer.innerHTML = `<div class="detail-no-image"><i class="fi fi-tr-picture"></i><span>Screenshot not available</span></div>`;
        }

        // Set title
        titleEl.textContent = item.title;

        // Set meta info
        metaEl.innerHTML = `
            <i class="fi fi-tr-smartphone"></i>
            <span>Screen Capture</span>
            <span class="detail-meta-separator">•</span>
            <span>${this.formatTimestamp(item.timestamp)}</span>
        `;

        // Set content with proper formatting
        contentEl.innerHTML = `
            <div class="detail-section">
                <div class="detail-section-header">
                    <i class="fi fi-tr-document"></i>
                    <span>AI Summary</span>
                </div>
                <div class="detail-section-body">
                    ${this.formatAnalysisText(item.text)}
                </div>
            </div>
        `;

        // Show the panel
        panel.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    /**
     * Create the detail panel element
     */
    createDetailPanel() {
        const panel = document.createElement('div');
        panel.id = 'mindspace-detail-panel';
        panel.className = 'mindspace-detail-panel hidden';

        panel.innerHTML = `
            <div class="detail-header">
                <button class="detail-back-btn">
                    <i class="fas fa-arrow-left"></i>
                </button>
                <div class="detail-header-actions">
                    <button class="detail-action-btn detail-delete-btn" title="Delete">
                        <i class="fi fi-tr-trash"></i>
                    </button>
                </div>
            </div>
            <div class="detail-scroll-content">
                <div class="detail-image-container"></div>
                <div class="detail-info">
                    <h1 class="detail-title"></h1>
                    <div class="detail-meta"></div>
                </div>
                <div class="detail-content"></div>
            </div>
        `;

        // Add event listeners
        panel.querySelector('.detail-back-btn').addEventListener('click', () => {
            this.hideDetailView();
        });

        panel.querySelector('.detail-delete-btn').addEventListener('click', () => {
            this.deleteCurrentItem();
        });

        document.body.appendChild(panel);
        return panel;
    }

    /**
     * Hide the detail view
     */
    hideDetailView() {
        const panel = document.getElementById('mindspace-detail-panel');
        if (panel) {
            panel.classList.add('hidden');
            document.body.style.overflow = '';
        }
        this.currentDetailItem = null;
    }

    /**
     * Delete the current item
     */
    deleteCurrentItem() {
        if (!this.currentDetailItem) return;

        const confirmed = confirm('Delete this analysis?');
        if (!confirmed) return;

        const id = this.currentDetailItem.id;
        this.history = this.history.filter(item => item.id !== id);
        this.saveHistory();

        this.hideDetailView();

        // Refresh the list if it's visible
        const listContainer = document.getElementById('mindspace-list');
        if (listContainer) {
            this.renderMindspace('mindspace-list');
        }
    }

    /**
     * Format analysis text with proper HTML structure
     */
    formatAnalysisText(text) {
        if (!text) return '<p>No analysis available.</p>';

        // Convert markdown-style formatting to HTML
        let html = text
            // Convert headers
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/^# (.+)$/gm, '<h2>$1</h2>')
            // Convert bold
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // Convert italic
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            // Convert bullet points
            .replace(/^[•\-\*] (.+)$/gm, '<li>$1</li>')
            // Convert line breaks
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        // Wrap in paragraph
        html = '<p>' + html + '</p>';

        // Wrap consecutive <li> items in <ul>
        html = html.replace(/(<li>.*?<\/li>)+/gs, (match) => {
            return '<ul class="detail-list">' + match + '</ul>';
        });

        // Clean up empty paragraphs
        html = html.replace(/<p>\s*<\/p>/g, '');
        html = html.replace(/<p>\s*<ul/g, '<ul');
        html = html.replace(/<\/ul>\s*<\/p>/g, '</ul>');

        return html;
    }

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
