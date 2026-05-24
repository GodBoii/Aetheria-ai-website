// js/artifact-renderer.js - Enhanced artifact content rendering

class ArtifactRenderer {
    constructor() {
        this.markdownLoaded = false;
        this.loadMarkdownLibrary();
    }

    async loadMarkdownLibrary() {
        // Check if marked.js is already loaded
        if (typeof marked !== 'undefined') {
            this.markdownLoaded = true;
            this.configureMarked();
            return;
        }

        // Try to load from CDN
        try {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js';
            script.onload = () => {
                this.markdownLoaded = true;
                this.configureMarked();
                console.log('[ArtifactRenderer] Marked.js loaded successfully');
            };
            script.onerror = () => {
                console.warn('[ArtifactRenderer] Failed to load marked.js from CDN');
            };
            document.head.appendChild(script);
        } catch (error) {
            console.error('[ArtifactRenderer] Error loading marked.js:', error);
        }
    }

    configureMarked() {
        if (typeof marked === 'undefined') return;

        // Configure marked for better rendering
        marked.setOptions({
            breaks: true,
            gfm: true,
            headerIds: true,
            mangle: false,
            sanitize: false,
            pedantic: false
        });

        console.log('[ArtifactRenderer] Marked.js configured successfully');
    }

    /**
     * Render content based on file type
     * @param {string} content - File content
     * @param {string} language - Language/file type
     * @param {HTMLElement} container - Container element
     */
    render(content, language, container) {
        // Clear container
        container.innerHTML = '';

        // Determine rendering method based on language
        const normalizedLang = (language || 'plaintext').toLowerCase();

        if (normalizedLang === 'markdown' || normalizedLang === 'md') {
            this.renderMarkdown(content, container);
        } else if (normalizedLang === 'json') {
            this.renderJSON(content, container);
        } else if (normalizedLang === 'html') {
            this.renderHTML(content, container);
        } else if (normalizedLang === 'csv') {
            this.renderCSV(content, container);
        } else {
            this.renderCode(content, normalizedLang, container);
        }
    }

    /**
     * Render markdown content
     */
    renderMarkdown(content, container) {
        const wrapper = document.createElement('div');
        wrapper.className = 'artifact-markdown-content';

        console.log('[ArtifactRenderer] Rendering markdown, marked loaded:', this.markdownLoaded);
        console.log('[ArtifactRenderer] Content preview:', content.substring(0, 100));

        if (this.markdownLoaded && typeof marked !== 'undefined') {
            try {
                // Parse markdown to HTML
                const html = marked.parse(content);
                console.log('[ArtifactRenderer] Markdown parsed successfully');
                wrapper.innerHTML = html;

                // Apply syntax highlighting to code blocks
                wrapper.querySelectorAll('pre code').forEach((block) => {
                    if (typeof hljs !== 'undefined') {
                        hljs.highlightElement(block);
                    }
                });
            } catch (error) {
                console.error('[ArtifactRenderer] Markdown parsing error:', error);
                // Fallback to plain text with basic formatting
                wrapper.innerHTML = this.basicMarkdownFallback(content);
            }
        } else {
            console.warn('[ArtifactRenderer] Marked.js not loaded, using fallback');
            // Fallback: render as plain text with basic formatting
            wrapper.innerHTML = this.basicMarkdownFallback(content);
        }

        container.appendChild(wrapper);
    }

    /**
     * Basic markdown fallback (when marked.js not available)
     */
    basicMarkdownFallback(content) {
        // Simple markdown-like formatting
        let html = content
            // Escape HTML
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // Headers (must be at start of line)
            .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            // Bold
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.*?)__/g, '<strong>$1</strong>')
            // Italic
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/_(.*?)_/g, '<em>$1</em>')
            // Code blocks (multiline)
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            // Inline code
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // Links
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
            // Line breaks (double newline = paragraph)
            .replace(/\n\n/g, '</p><p>')
            // Single line breaks
            .replace(/\n/g, '<br>');

        // Wrap in paragraphs
        html = '<p>' + html + '</p>';

        return html;
    }

    /**
     * Render JSON with pretty printing
     */
    renderJSON(content, container) {
        try {
            // Parse and pretty-print JSON
            const parsed = JSON.parse(content);
            const formatted = JSON.stringify(parsed, null, 2);

            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = 'language-json';
            code.textContent = formatted;
            pre.appendChild(code);
            container.appendChild(pre);

            // Apply syntax highlighting
            if (typeof hljs !== 'undefined') {
                hljs.highlightElement(code);
            }
        } catch (error) {
            console.error('[ArtifactRenderer] JSON parsing error:', error);
            // Fallback to plain text
            this.renderCode(content, 'json', container);
        }
    }

    /**
     * Render HTML (sanitized preview)
     */
    renderHTML(content, container) {
        const wrapper = document.createElement('div');
        wrapper.className = 'artifact-html-preview';

        // Create tabs for preview and source
        const tabs = document.createElement('div');
        tabs.className = 'artifact-tabs';
        tabs.innerHTML = `
            <button class="artifact-tab active" data-tab="preview">Preview</button>
            <button class="artifact-tab" data-tab="source">Source</button>
        `;

        const previewPane = document.createElement('div');
        previewPane.className = 'artifact-tab-pane active';
        previewPane.dataset.pane = 'preview';

        const sourcePane = document.createElement('div');
        sourcePane.className = 'artifact-tab-pane';
        sourcePane.dataset.pane = 'source';

        // Preview (in iframe for safety)
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 100%; height: 500px; border: 1px solid var(--border-color); border-radius: 8px; background: white;';
        iframe.srcdoc = content;
        previewPane.appendChild(iframe);

        // Source code
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-html';
        code.textContent = content;
        pre.appendChild(code);
        sourcePane.appendChild(pre);

        if (typeof hljs !== 'undefined') {
            hljs.highlightElement(code);
        }

        // Tab switching
        tabs.querySelectorAll('.artifact-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                tabs.querySelectorAll('.artifact-tab').forEach(t => t.classList.remove('active'));
                wrapper.querySelectorAll('.artifact-tab-pane').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                wrapper.querySelector(`[data-pane="${targetTab}"]`).classList.add('active');
            });
        });

        wrapper.appendChild(tabs);
        wrapper.appendChild(previewPane);
        wrapper.appendChild(sourcePane);
        container.appendChild(wrapper);
    }

    /**
     * Render CSV as table
     */
    renderCSV(content, container) {
        try {
            const lines = content.trim().split('\n');
            if (lines.length === 0) {
                container.textContent = 'Empty CSV file';
                return;
            }

            const table = document.createElement('table');
            table.className = 'artifact-csv-table';
            table.style.cssText = 'width: 100%; border-collapse: collapse; margin: 0;';

            // Parse CSV (simple parser, doesn't handle quoted commas)
            const parseCSVLine = (line) => {
                return line.split(',').map(cell => cell.trim());
            };

            // Header row
            const headerCells = parseCSVLine(lines[0]);
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            headerCells.forEach(cell => {
                const th = document.createElement('th');
                th.textContent = cell;
                th.style.cssText = 'padding: 12px; border: 1px solid var(--border-color); background: var(--card-bg); text-align: left; font-weight: 600;';
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);

            // Data rows
            const tbody = document.createElement('tbody');
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                const cells = parseCSVLine(lines[i]);
                const row = document.createElement('tr');
                cells.forEach(cell => {
                    const td = document.createElement('td');
                    td.textContent = cell;
                    td.style.cssText = 'padding: 12px; border: 1px solid var(--border-color);';
                    row.appendChild(td);
                });
                tbody.appendChild(row);
            }
            table.appendChild(tbody);

            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'overflow-x: auto; max-width: 100%;';
            wrapper.appendChild(table);
            container.appendChild(wrapper);
        } catch (error) {
            console.error('[ArtifactRenderer] CSV parsing error:', error);
            this.renderCode(content, 'plaintext', container);
        }
    }

    /**
     * Render code with syntax highlighting
     */
    renderCode(content, language, container) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = `language-${language || 'plaintext'}`;
        code.textContent = content;
        pre.appendChild(code);
        container.appendChild(pre);

        // Apply syntax highlighting
        if (typeof hljs !== 'undefined') {
            try {
                hljs.highlightElement(code);
            } catch (error) {
                console.error('[ArtifactRenderer] Syntax highlighting error:', error);
            }
        }
    }

    /**
     * Get file icon based on language
     */
    getFileIcon(language) {
        const iconMap = {
            'markdown': 'fa-file-lines',
            'md': 'fa-file-lines',
            'json': 'fa-file-code',
            'javascript': 'fa-file-code',
            'typescript': 'fa-file-code',
            'python': 'fa-file-code',
            'html': 'fa-file-code',
            'css': 'fa-file-code',
            'java': 'fa-file-code',
            'cpp': 'fa-file-code',
            'c': 'fa-file-code',
            'go': 'fa-file-code',
            'rust': 'fa-file-code',
            'ruby': 'fa-file-code',
            'php': 'fa-file-code',
            'csv': 'fa-table',
            'image': 'fa-image',
            'mermaid': 'fa-diagram-project'
        };

        return iconMap[language] || 'fa-file';
    }
}

// Export singleton instance
export const artifactRenderer = new ArtifactRenderer();
