// js/artifact-handler.js (Updated)

import NotificationService from './notification-service.js';
import { artifactRenderer } from './artifact-renderer.js';
import { isHtmlContent } from './deploy-api-service.js';
import { ArtifactDeployManager } from './artifact-deploy-manager.js';
import { PRESENTATION_TEMPLATES } from './presentation-templates.js';
import { supabase } from './supabase-client.js';
import { config } from './config.js';

class ArtifactHandler {
    constructor() {
        this.artifacts = new Map();
        this.currentId = 0;
        this.currentArtifactId = null;
        this.notificationService = new NotificationService();
        this.renderer = artifactRenderer;
        this.deployManager = new ArtifactDeployManager({
            notify: (message, type = 'info') => this.showNotification(message, type),
            getConversationId: () => window.currentConversationId || null,
            openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer')
        });
        this.init();
    }

    init() {
        const container = document.createElement('div');
        container.id = 'artifact-container';
        container.className = 'artifact-container hidden';

        container.innerHTML = `
            <div class="artifact-window">
                <div class="artifact-header">
                    <div id="artifact-title" class="artifact-title">Artifact Viewer</div>
                    <div class="artifact-controls">
                        <div class="artifact-dropdown-container">
                            <button id="artifact-menu-btn" class="artifact-menu-btn" title="More Options"><i class="fas fa-ellipsis-v"></i></button>
                            <div id="artifact-dropdown-menu" class="artifact-dropdown-menu hidden">
                                <button id="copy-artifact-btn" class="dropdown-item"><i class="fi fi-tr-copy"></i> Copy to Clipboard</button>
                                <button id="download-artifact-btn" class="dropdown-item"><i class="fas fa-download"></i> Download</button>
                                <button id="deploy-artifact-btn" class="dropdown-item"><i class="fas fa-rocket"></i> Deploy HTML site</button>
                            </div>
                        </div>
                        <button id="close-artifact-btn" class="close-artifact-btn" title="Close"><i class="fas fa-times"></i></button>
                    </div>
                </div>
                <div id="artifact-content" class="artifact-content"></div>
            </div>
        `;
        document.body.appendChild(container);

        container.querySelector('#close-artifact-btn').addEventListener('click', () => this.hideArtifact());
        container.querySelector('#copy-artifact-btn').addEventListener('click', () => this.copyArtifactContent());
        container.querySelector('#download-artifact-btn').addEventListener('click', () => this.downloadArtifact());
        container.querySelector('#deploy-artifact-btn').addEventListener('click', () => this.deployCurrentArtifact());

        const menuBtn = container.querySelector('#artifact-menu-btn');
        const menu = container.querySelector('#artifact-dropdown-menu');
        if (menuBtn && menu) {
            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.toggle('hidden');
            });
            document.addEventListener('click', (e) => {
                if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !menuBtn.contains(e.target)) {
                    menu.classList.add('hidden');
                }
            });
        }
    }

    createArtifact(content, type, artifactId = null) {
        const id = artifactId || `artifact-${this.currentId++}`;

        let stringContent = content;
        if (typeof content === 'object' && content !== null) {
            try {
                stringContent = JSON.stringify(content, null, 2);
            } catch (error) {
                stringContent = '[object Object]';
            }
        } else if (typeof content !== 'string') {
            stringContent = String(content);
        }

        this.artifacts.set(id, { content: stringContent, type });
        return id;
    }

    showArtifact(content, type, artifactId = null, filename = null) {
        this.currentArtifactId = artifactId || this.createArtifact(content, type, artifactId);

        const container = document.getElementById('artifact-container');
        const contentDiv = container.querySelector('#artifact-content');
        const titleDiv = container.querySelector('#artifact-title');
        const deployBtn = container.querySelector('#deploy-artifact-btn');

        contentDiv.innerHTML = '';

        const artifact = this.artifacts.get(this.currentArtifactId);
        const displayContent = artifact ? artifact.content : (typeof content === 'string' ? content : JSON.stringify(content, null, 2));

        // Get appropriate icon
        const icon = this.renderer.getFileIcon(type);

        // Determine display title
        let displayTitle = '';
        if (filename) {
            // Use filename if provided
            displayTitle = `<i class="fas ${icon}"></i> ${filename}`;
        } else {
            // Fallback to type-based title
            switch (type) {
                case 'image':
                    displayTitle = `<i class="fas ${icon}"></i> Image Artifact`;
                    break;
                case 'mermaid':
                    displayTitle = `<i class="fas ${icon}"></i> Mermaid Diagram`;
                    break;
                case 'markdown':
                case 'md':
                    displayTitle = `<i class="fas ${icon}"></i> Markdown Document`;
                    break;
                case 'json':
                    displayTitle = `<i class="fas ${icon}"></i> JSON Data`;
                    break;
                case 'html':
                    displayTitle = `<i class="fas ${icon}"></i> HTML Document`;
                    break;
                case 'csv':
                    displayTitle = `<i class="fas ${icon}"></i> CSV Data`;
                    break;
                default:
                    const langName = type.charAt(0).toUpperCase() + type.slice(1);
                    displayTitle = `<i class="fas ${icon}"></i> ${type === 'browser_view' ? 'Interactive Browser' : langName}`;
            }
        }

        titleDiv.innerHTML = displayTitle;

        if (artifact) {
            artifact.filename = filename || artifact.filename || null;
            artifact.language = String(type || artifact.language || '').toLowerCase();
        }

        const deployable = this.isDeployableArtifactType(type, displayContent);
        if (deployBtn) {
            deployBtn.style.display = deployable ? 'flex' : 'none';
        }

        // Render content based on type
        switch (type) {
            case 'image':
                this.renderImageArtifact(contentDiv, displayContent);
                break;
            case 'mermaid':
                this.renderMermaidArtifact(contentDiv, displayContent);
                break;
            default:
                this.renderCodeArtifact(contentDiv, displayContent, type);
        }

        container.classList.remove('hidden');
        container.dataset.activeArtifactId = this.currentArtifactId;
        container.dataset.activeArtifactType = type;
        return this.currentArtifactId;
    }

    getActiveArtifact() {
        if (!this.currentArtifactId) return null;
        return this.artifacts.get(this.currentArtifactId) || null;
    }

    isDeployableArtifactType(type, content) {
        const lowered = String(type || '').toLowerCase();
        if (lowered === 'html' || lowered === 'htm') return true;
        return isHtmlContent(content);
    }

    async deployCurrentArtifact() {
        const artifact = this.getActiveArtifact();
        if (!artifact) {
            this.showNotification('No active artifact selected', 'error');
            return;
        }
        await this.deployManager.deployCurrentArtifact({
            content: artifact.content,
            type: artifact.type,
            language: artifact.language || artifact.type,
            title: artifact.filename || 'Generated Site'
        });
    }

    hideArtifact() {
        const container = document.getElementById('artifact-container');
        container.classList.add('hidden');
        this.currentArtifactId = null;
        delete container.dataset.activeArtifactId;
        delete container.dataset.activeArtifactType;
    }

    reopenArtifact(artifactId) {
        const artifact = this.artifacts.get(artifactId);
        if (artifact) this.showArtifact(artifact.content, artifact.type, artifactId);
    }

    renderImageArtifact(container, content) {
        const src = typeof content === 'string' && content.startsWith('data:')
            ? content
            : `data:image/png;base64,${content}`;

        const wrapper = document.createElement('div');
        wrapper.className = 'artifact-image-wrapper';

        const img = document.createElement('img');
        img.className = 'artifact-image';
        img.alt = 'Generated artifact image';
        img.src = src;
        img.loading = 'lazy';

        wrapper.appendChild(img);
        container.appendChild(wrapper);
    }

    renderMermaidArtifact(container, content) {
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-artifact-wrapper';

        const panContainer = document.createElement('div');
        panContainer.className = 'mermaid-pan-container';
        panContainer.dataset.scale = '1';
        panContainer.dataset.translateX = '0';
        panContainer.dataset.translateY = '0';

        const mermaidDiv = document.createElement('div');
        mermaidDiv.className = 'mermaid';
        mermaidDiv.removeAttribute?.('data-processed');
        mermaidDiv.textContent = content;

        panContainer.appendChild(mermaidDiv);
        wrapper.appendChild(panContainer);

        // Add zoom controls
        const controls = document.createElement('div');
        controls.className = 'mermaid-controls';
        controls.innerHTML = `
            <button class="zoom-in-btn" title="Zoom In"><i class="fas fa-plus"></i></button>
            <button class="zoom-out-btn" title="Zoom Out"><i class="fas fa-minus"></i></button>
            <button class="zoom-reset-btn" title="Reset View"><i class="fas fa-expand"></i></button>
        `;
        wrapper.appendChild(controls);
        container.appendChild(wrapper);

        // Setup zoom controls
        this.setupMermaidZoom(panContainer, controls);

        const runMermaid = async () => {
            console.log('[ArtifactHandler] Starting Mermaid render in modal');

            if (typeof window === 'undefined' || !window.mermaid) {
                console.error('[ArtifactHandler] Mermaid library not loaded');
                this.showMermaidError(container, 'Mermaid library not loaded');
                return;
            }

            try {
                // Wait a bit for the modal to be fully visible and sized
                await new Promise(resolve => setTimeout(resolve, 100));

                console.log('[ArtifactHandler] Rendering Mermaid diagram');
                console.log('[ArtifactHandler] Mermaid content:', content.substring(0, 100));

                if (typeof window.mermaid.run === 'function') {
                    await window.mermaid.run({ nodes: [mermaidDiv] });
                } else if (typeof window.mermaid.init === 'function') {
                    await window.mermaid.init(undefined, [mermaidDiv]);
                } else {
                    throw new Error('No Mermaid render method available');
                }

                // After rendering, ensure SVG is visible
                const svg = mermaidDiv.querySelector('svg');
                if (svg) {
                    console.log('[ArtifactHandler] Mermaid SVG rendered, dimensions:', {
                        width: svg.getAttribute('width'),
                        height: svg.getAttribute('height'),
                        viewBox: svg.getAttribute('viewBox')
                    });

                    // Don't remove dimensions, just ensure it's visible
                    svg.style.display = 'block';
                    svg.style.margin = '0 auto';
                } else {
                    console.error('[ArtifactHandler] No SVG found after Mermaid render');
                }
            } catch (error) {
                console.error('Mermaid rendering error:', error);
                this.showMermaidError(container, 'Failed to render diagram. Check syntax.');
            }
        };

        // Use setTimeout instead of requestAnimationFrame for better timing
        setTimeout(runMermaid, 50);
    }

    setupMermaidZoom(panContainer, controls) {
        const applyTransform = () => {
            const scale = parseFloat(panContainer.dataset.scale) || 1;
            const x = parseFloat(panContainer.dataset.translateX) || 0;
            const y = parseFloat(panContainer.dataset.translateY) || 0;
            panContainer.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        };

        controls.querySelector('.zoom-in-btn')?.addEventListener('click', () => {
            const currentScale = parseFloat(panContainer.dataset.scale) || 1;
            panContainer.dataset.scale = Math.min(3, currentScale * 1.2).toString();
            applyTransform();
        });

        controls.querySelector('.zoom-out-btn')?.addEventListener('click', () => {
            const currentScale = parseFloat(panContainer.dataset.scale) || 1;
            panContainer.dataset.scale = Math.max(0.5, currentScale / 1.2).toString();
            applyTransform();
        });

        controls.querySelector('.zoom-reset-btn')?.addEventListener('click', () => {
            panContainer.dataset.scale = '1';
            panContainer.dataset.translateX = '0';
            panContainer.dataset.translateY = '0';
            applyTransform();
        });

        // Pan with mouse drag
        let isDragging = false;
        let startX = 0;
        let startY = 0;

        panContainer.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX - (parseFloat(panContainer.dataset.translateX) || 0);
            startY = e.clientY - (parseFloat(panContainer.dataset.translateY) || 0);
            panContainer.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panContainer.dataset.translateX = (e.clientX - startX).toString();
            panContainer.dataset.translateY = (e.clientY - startY).toString();
            applyTransform();
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            panContainer.style.cursor = 'grab';
        });

        panContainer.style.cursor = 'grab';
    }

    showMermaidError(container, message) {
        container.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--error-500);">
                <i class="fas fa-exclamation-triangle" style="font-size: 2rem; margin-bottom: 12px;"></i>
                <p style="margin: 0; font-size: 0.9rem;">${message}</p>
            </div>
        `;
    }

    renderCodeArtifact(container, content, language) {
        // Use the enhanced renderer for better formatting
        this.renderer.render(content, language, container);
    }

    async copyArtifactContent() {
        if (!this.currentArtifactId) return;
        const artifact = this.artifacts.get(this.currentArtifactId);
        if (!artifact) return;
        try {
            await navigator.clipboard.writeText(artifact.content);
            this.showNotification('Content copied to clipboard!', 'success');
        } catch (err) {
            this.showNotification('Failed to copy content', 'error');
        }
    }

    async downloadArtifact() {
        if (!this.currentArtifactId) return;
        const artifact = this.artifacts.get(this.currentArtifactId);
        if (!artifact) return;

        let { content, type } = artifact;
        let suggestedName = 'artifact';
        let extension = '.txt';
        let mimeType = 'text/plain';

        if (type === 'mermaid') {
            extension = '.mmd';
            suggestedName = 'diagram';
        } else {
            extension = this.getFileExtension(type);
            suggestedName = `code`;
            mimeType = this.getMimeType(extension);
        }

        try {
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = suggestedName + extension;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.showNotification('File download started', 'success');
        } catch (error) {
            console.error('Browser Save Error:', error);
            this.showNotification('Error: ' + error.message, 'error');
        }
    }

    getFileExtension(language) {
        const map = {
            javascript: '.js', python: '.py', html: '.html', css: '.css', json: '.json',
            typescript: '.ts', java: '.java', cpp: '.cpp', c: '.c', ruby: '.rb',
            php: '.php', go: '.go', rust: '.rs', swift: '.swift', kotlin: '.kt',
            plaintext: '.txt'
        };
        return map[language] || '.txt';
    }

    getMimeType(extension) {
        const map = {
            '.js': 'application/javascript', '.py': 'text/x-python', '.html': 'text/html',
            '.css': 'text/css', '.json': 'application/json', '.ts': 'application/typescript',
            '.txt': 'text/plain', '.mmd': 'text/plain', '.cpp': 'text/x-c++src',
            '.c': 'text/x-c', '.java': 'text/x-java-source'
        };
        return map[extension] || 'text/plain';
    }

    showNotification(message, type = 'info') {
        if (this.notificationService) {
            this.notificationService.show(message, type, 3000);
        }
    }

    // --- NEW: Functions to handle terminal display ---
    showTerminal(artifactId) {
        const container = document.getElementById('artifact-container');
        const contentDiv = container.querySelector('#artifact-content');
        container.querySelector('#artifact-title').textContent = 'Sandbox Terminal';
        contentDiv.innerHTML = `<div class="terminal-output"><pre><code><span class="log-line log-status">Waiting for command...</span></code></pre></div>`;
        container.classList.remove('hidden');
        container.dataset.activeArtifactId = artifactId;
    }

    updateCommand(artifactId, command) {
        const container = document.getElementById('artifact-container');
        if (container.dataset.activeArtifactId !== artifactId) return;
        const codeEl = container.querySelector('code');
        if (codeEl) {
            codeEl.innerHTML = `<span class="log-line log-command">$ ${command}</span><span class="log-line log-status terminal-spinner">Running...</span>`;
        }
    }

    updateTerminalOutput(artifactId, stdout, stderr, exitCode) {
        const container = document.getElementById('artifact-container');
        if (container.dataset.activeArtifactId !== artifactId) return;
        const codeEl = container.querySelector('code');
        if (codeEl) {
            const spinner = codeEl.querySelector('.terminal-spinner');
            if (spinner) spinner.remove();
            if (stdout) {
                const stdoutSpan = document.createElement('span');
                stdoutSpan.className = 'log-line log-stdout';
                stdoutSpan.textContent = stdout;
                codeEl.appendChild(stdoutSpan);
            }
            if (stderr) {
                const stderrSpan = document.createElement('span');
                stderrSpan.className = 'log-line log-error';
                stderrSpan.textContent = stderr;
                codeEl.appendChild(stderrSpan);
            }
            const statusSpan = document.createElement('span');
            statusSpan.className = 'log-line log-status';
            statusSpan.textContent = `\n--- Process finished with exit code ${exitCode} ---`;
            codeEl.appendChild(statusSpan);
        }
    }

    renderPresentation(container, metadata) {
        const existing = container.querySelector('.presentation-preview-block');
        if (existing) existing.remove();

        const block = document.createElement('div');
        block.className = 'content-block presentation-preview-block';
        block.dataset.artifactId = metadata.artifact_id;

        const slides = metadata.inline?.slides || [];
        const templateId = metadata.template || 'aetheria_modern';
        
        // Find local template colors mapping
        const tplColors = PRESENTATION_TEMPLATES[templateId]?.colors || {
            bg: "#F5F6F0", surface: "#FFFFFF", ink: "#17202A", muted: "#5A6474", accent: "#1B5299", accent2: "#E8553D", accent3: "#1A936F"
        };

        const cssVars = `
            --ppt-bg: ${tplColors.bg};
            --ppt-surface: ${tplColors.surface};
            --ppt-ink: ${tplColors.ink};
            --ppt-muted: ${tplColors.muted};
            --ppt-accent: ${tplColors.accent};
            --ppt-accent2: ${tplColors.accent2};
            --ppt-accent3: ${tplColors.accent3};
        `;

        block.innerHTML = `
            <div class="presentation-hero-card" style="${cssVars}">
                <div class="hero-left">
                    <i class="fas fa-file-powerpoint icon"></i>
                    <div class="details">
                        <span class="title">${metadata.title}</span>
                        <span class="subtitle">${metadata.summary} (${templateId.replace('_', ' ')})</span>
                    </div>
                </div>
                <button class="ppt-download-btn" title="Download Presentation">
                    <i class="fas fa-download"></i> Download
                </button>
            </div>
            <div class="presentation-slides-grid">
                ${slides.map((slide, idx) => this.renderPresentationSlideThumbnail(slide, idx, cssVars)).join('')}
            </div>
        `;

        // Download button click handler
        const downloadBtn = block.querySelector('.ppt-download-btn');
        downloadBtn.addEventListener('click', async () => {
            try {
                this.showNotification('Preparing download...', 'info');
                
                // Get auth token
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) {
                    throw new Error('Authentication required');
                }

                // Fetch signed download URL from backend sandbox artifacts
                const response = await fetch(`${config.backend.url}/api/sandbox/artifacts/${metadata.artifact_id}`, {
                    headers: {
                        'Authorization': `Bearer ${session.access_token}`
                    }
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch artifact details');
                }

                const result = await response.json();
                const freshUrl = result.artifact?.download_url;

                if (!freshUrl) {
                    throw new Error('No download URL available');
                }

                // Save file via anchor tag
                const a = document.createElement('a');
                a.href = freshUrl;
                a.download = metadata.filename || 'presentation.pptx';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                this.showNotification('Download started!', 'success');
            } catch (err) {
                console.error('[Presentation] Download failed:', err);
                this.showNotification('Download failed: ' + err.message, 'error');
            }
        });

        container.appendChild(block);
    }

    renderPresentationSlideThumbnail(slide, idx, cssVars) {
        const type = String(slide.type || '').toLowerCase();
        
        let slideBodyHtml = '';
        if (type === 'title') {
            slideBodyHtml = `
              <div class="slide-thumb-cover">
                <div class="accent-top" style="background: var(--ppt-accent);"></div>
                <div class="cover-content">
                  <div class="title-block" style="background: var(--ppt-ink); opacity: 0.8; height: 10px; width: 60%; border-radius: 2px; margin-bottom: 4px;"></div>
                  <div class="subtitle-block" style="background: var(--ppt-muted); opacity: 0.6; height: 6px; width: 40%; border-radius: 1px;"></div>
                </div>
                <div class="cover-visual-block" style="border: 1px solid var(--ppt-accent); background: var(--ppt-surface);">
                  <div style="background: var(--ppt-accent); width: 8px; height: 8px; border-radius: 50%; opacity: 0.3;"></div>
                </div>
              </div>
            `;
        } else if (type === 'two_column' || type === 'comparison') {
            slideBodyHtml = `
              <div class="slide-thumb-comparison">
                <div class="accent-top" style="background: var(--ppt-accent);"></div>
                <div class="slide-thumb-title" style="background: var(--ppt-ink); opacity: 0.8; height: 6px; width: 45%; border-radius: 1px; margin-bottom: 8px;"></div>
                <div class="columns-grid">
                  <div class="column-block" style="background: var(--ppt-surface); border: 1px solid rgba(0,0,0,0.1);">
                    <div style="background: var(--ppt-accent); height: 4px; border-radius: 1px; margin-bottom: 4px;"></div>
                    <div style="background: var(--ppt-muted); height: 2px; width: 80%; border-radius: 0.5px; margin-bottom: 2px;"></div>
                    <div style="background: var(--ppt-muted); height: 2px; width: 60%; border-radius: 0.5px;"></div>
                  </div>
                  <div class="column-block" style="background: var(--ppt-surface); border: 1px solid rgba(0,0,0,0.1);">
                    <div style="background: var(--ppt-accent2); height: 4px; border-radius: 1px; margin-bottom: 4px;"></div>
                    <div style="background: var(--ppt-muted); height: 2px; width: 80%; border-radius: 0.5px; margin-bottom: 2px;"></div>
                    <div style="background: var(--ppt-muted); height: 2px; width: 60%; border-radius: 0.5px;"></div>
                  </div>
                </div>
              </div>
            `;
        } else if (type === 'chart' || type === 'evidence') {
            slideBodyHtml = `
              <div class="slide-thumb-chart">
                <div class="accent-top" style="background: var(--ppt-accent);"></div>
                <div class="slide-thumb-title" style="background: var(--ppt-ink); opacity: 0.8; height: 6px; width: 40%; border-radius: 1px; margin-bottom: 8px;"></div>
                <div class="chart-bars">
                  <div class="bar" style="background: var(--ppt-accent); height: 16px;"></div>
                  <div class="bar" style="background: var(--ppt-accent2); height: 26px;"></div>
                  <div class="bar" style="background: var(--ppt-accent3); height: 10px;"></div>
                </div>
              </div>
            `;
        } else if (type === 'table') {
            slideBodyHtml = `
              <div class="slide-thumb-table">
                <div class="accent-top" style="background: var(--ppt-accent);"></div>
                <div class="slide-thumb-title" style="background: var(--ppt-ink); opacity: 0.8; height: 6px; width: 35%; border-radius: 1px; margin-bottom: 8px;"></div>
                <div class="table-rows">
                  <div class="row header-row" style="background: var(--ppt-accent); height: 4px; border-radius: 1px; margin-bottom: 2px;"></div>
                  <div class="row" style="background: var(--ppt-surface); border: 1px solid rgba(0,0,0,0.06); height: 4px; margin-bottom: 2px;"></div>
                  <div class="row" style="background: var(--ppt-surface); border: 1px solid rgba(0,0,0,0.06); height: 4px;"></div>
                </div>
              </div>
            `;
        } else if (type === 'diagram' || type === 'process' || slide.nodes || slide.steps) {
            slideBodyHtml = `
              <div class="slide-thumb-diagram">
                <div class="accent-top" style="background: var(--ppt-accent);"></div>
                <div class="slide-thumb-title" style="background: var(--ppt-ink); opacity: 0.8; height: 6px; width: 50%; border-radius: 1px; margin-bottom: 8px;"></div>
                <div class="diagram-nodes">
                  <div class="node" style="background: var(--ppt-surface); border: 1px solid var(--ppt-accent); height: 12px; width: 22px; border-radius: 2px;"></div>
                  <div class="node-arrow" style="background: var(--ppt-muted); height: 1px; width: 8px; opacity: 0.4;"></div>
                  <div class="node" style="background: var(--ppt-surface); border: 1px solid var(--ppt-accent2); height: 12px; width: 22px; border-radius: 2px;"></div>
                  <div class="node-arrow" style="background: var(--ppt-muted); height: 1px; width: 8px; opacity: 0.4;"></div>
                  <div class="node" style="background: var(--ppt-surface); border: 1px solid var(--ppt-accent3); height: 12px; width: 22px; border-radius: 2px;"></div>
                </div>
              </div>
            `;
        } else {
            slideBodyHtml = `
              <div class="slide-thumb-content">
                <div class="accent-top" style="background: var(--ppt-accent);"></div>
                <div class="slide-thumb-title" style="background: var(--ppt-ink); opacity: 0.8; height: 6px; width: 50%; border-radius: 1px; margin-bottom: 8px;"></div>
                <div class="bullets-container">
                  <div class="bullet-row"><span style="background: var(--ppt-accent);"></span><div class="line" style="background: var(--ppt-ink); opacity: 0.7; width: 70%;"></div></div>
                  <div class="bullet-row"><span style="background: var(--ppt-accent2);"></span><div class="line" style="background: var(--ppt-ink); opacity: 0.7; width: 60%;"></div></div>
                  <div class="bullet-row"><span style="background: var(--ppt-accent3);"></span><div class="line" style="background: var(--ppt-ink); opacity: 0.7; width: 50%;"></div></div>
                </div>
              </div>
            `;
        }

        return `
          <div class="presentation-slide-thumbnail" style="${cssVars}">
            <div class="slide-thumbnail-card-title">${slide.title || `Slide ${idx + 1}`}</div>
            <div class="slide-thumbnail-body" style="background: var(--ppt-bg);">
              ${slideBodyHtml}
            </div>
          </div>
        `;
    }
}

export const artifactHandler = new ArtifactHandler();
