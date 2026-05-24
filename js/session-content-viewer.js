// js/session-content-viewer.js
// Session Content Viewer - Shows artifacts and executions from previous conversations

import { supabase } from './supabase-client.js';
import { config } from './config.js';
import { artifactHandler } from './artifact-handler.js';

class SessionContentViewer {
    constructor() {
        this.modal = document.getElementById('session-content-modal');
        this.closeBtn = this.modal?.querySelector('.close-content-viewer-btn');
        this.tabs = this.modal?.querySelectorAll('.viewer-tab');
        this.artifactsContent = this.modal?.querySelector('#artifacts-content');
        this.executionsContent = this.modal?.querySelector('#executions-content');

        this.currentSessionId = null;
        this.content = [];

        this.bindEvents();
    }

    bindEvents() {
        if (!this.modal) return;

        // Close button
        this.closeBtn?.addEventListener('click', () => this.hide());

        // Click outside to close
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.hide();
        });

        // Tab switching
        this.tabs?.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                this.switchTab(tabName);
            });
        });
    }

    switchTab(tabName) {
        // Update active tab
        this.tabs?.forEach(tab => {
            if (tab.dataset.tab === tabName) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        // Update active content
        const contents = this.modal?.querySelectorAll('.viewer-tab-content');
        contents?.forEach(content => {
            if (content.id === `${tabName}-content`) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });
    }

    async show(sessionId) {
        if (!this.modal) return;

        this.currentSessionId = sessionId;
        this.modal.classList.remove('hidden');

        // Show loading state
        this.showLoading();

        // Fetch content
        await this.loadContent(sessionId);
    }

    hide() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
        this.currentSessionId = null;
    }

    showLoading() {
        const loadingElements = this.modal?.querySelectorAll('.content-loading');
        const emptyElements = this.modal?.querySelectorAll('.content-empty');
        const listElements = this.modal?.querySelectorAll('.content-list');

        loadingElements?.forEach(el => el.classList.remove('hidden'));
        emptyElements?.forEach(el => el.classList.add('hidden'));
        listElements?.forEach(el => {
            el.classList.add('hidden');
            el.innerHTML = '';
        });
    }

    async loadContent(sessionId) {
        try {
            console.log('[SessionContentViewer] Loading content for session:', sessionId);

            // Get Supabase session for auth
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                console.error('[SessionContentViewer] No auth session');
                this.showError('Authentication required');
                return;
            }

            // Fetch session content from backend
            const url = `${config.backend.url}/api/sessions/${sessionId}/content`;
            console.log('[SessionContentViewer] Fetching from:', url);

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[SessionContentViewer] Response status:', response.status);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[SessionContentViewer] Error response:', errorText);
                throw new Error(`Failed to fetch content: ${response.statusText}`);
            }

            const data = await response.json();
            this.content = data.content || [];

            console.log(`[SessionContentViewer] Loaded ${this.content.length} items:`, this.content);

            // Render content
            this.renderContent();

        } catch (error) {
            console.error('[SessionContentViewer] Error loading content:', error);
            this.showError('Failed to load content');
        }
    }

    renderContent() {
        // Separate artifacts, executions, and uploads
        const artifacts = this.content.filter(item => item.content_type === 'artifact');
        const executions = this.content.filter(item => item.content_type === 'execution');
        const uploads = this.content.filter(item => item.content_type === 'upload');

        console.log('[SessionContentViewer] Rendering:', {
            artifacts: artifacts.length,
            executions: executions.length,
            uploads: uploads.length
        });

        // Combine artifacts and uploads for the Files tab
        const allFiles = [...artifacts, ...uploads];

        // Render files (artifacts + uploads)
        this.renderArtifacts(allFiles);

        // Render executions
        this.renderExecutions(executions);
    }

    renderArtifacts(artifacts) {
        const container = this.artifactsContent?.querySelector('.content-list');
        const loading = this.artifactsContent?.querySelector('.content-loading');
        const empty = this.artifactsContent?.querySelector('.content-empty');

        if (!container) return;

        loading?.classList.add('hidden');

        if (artifacts.length === 0) {
            empty?.classList.remove('hidden');
            container.classList.add('hidden');
            return;
        }

        empty?.classList.add('hidden');
        container.classList.remove('hidden');
        container.innerHTML = '';

        artifacts.forEach(artifact => {
            const item = this.createArtifactItem(artifact);
            container.appendChild(item);
        });
    }

    renderExecutions(executions) {
        const container = this.executionsContent?.querySelector('.content-list');
        const loading = this.executionsContent?.querySelector('.content-loading');
        const empty = this.executionsContent?.querySelector('.content-empty');

        if (!container) return;

        loading?.classList.add('hidden');

        if (executions.length === 0) {
            empty?.classList.remove('hidden');
            container.classList.add('hidden');
            return;
        }

        empty?.classList.add('hidden');
        container.classList.remove('hidden');
        container.innerHTML = '';

        executions.forEach(execution => {
            const item = this.createExecutionItem(execution);
            container.appendChild(item);
        });
    }

    createArtifactItem(artifact) {
        const div = document.createElement('div');
        div.className = 'content-item';

        const metadata = artifact.metadata || {};
        const contentType = artifact.content_type;
        const filename = metadata.filename || 'Unknown file';
        const size = this.formatFileSize(metadata.size || 0);

        // Different icon for uploads vs generated files
        const icon = contentType === 'upload' ? 'fa-paperclip' : 'fa-file';
        const label = contentType === 'upload' ? 'Uploaded' : 'Generated';

        div.innerHTML = `
            <div class="content-item-icon">
                <i class="fas ${icon}"></i>
            </div>
            <div class="content-item-details">
                <div class="content-item-name">${this.escapeHtml(filename)}</div>
                <div class="content-item-meta">
                    <span class="content-item-size">
                        <i class="fas fa-weight"></i>
                        ${size}
                    </span>
                    <span style="color: var(--text-tertiary); font-size: 0.8em;">${label}</span>
                </div>
            </div>
        `;

        // Click handler to view artifact
        div.addEventListener('click', async () => {
            if (contentType === 'upload') {
                await this.viewUpload(artifact);
            } else {
                await this.viewArtifact(artifact);
            }
        });

        return div;
    }

    createExecutionItem(execution) {
        const div = document.createElement('div');
        div.className = 'content-item';

        const metadata = execution.metadata || {};
        const command = metadata.command || 'Unknown command';
        const exitCode = metadata.exit_code ?? '?';
        const exitCodeClass = exitCode === 0 ? 'exit-code-success' : 'exit-code-error';

        div.innerHTML = `
            <div class="content-item-icon">
                <i class="fas fa-terminal"></i>
            </div>
            <div class="content-item-details">
                <div class="content-item-name">${this.escapeHtml(command)}</div>
                <div class="content-item-meta">
                    <span class="content-item-exit-code ${exitCodeClass}">
                        <i class="fas fa-circle-check"></i>
                        Exit: ${exitCode}
                    </span>
                </div>
            </div>
        `;

        // Click handler to view execution
        div.addEventListener('click', async () => {
            await this.viewExecution(execution);
        });

        return div;
    }

    async viewArtifact(artifact) {
        try {
            // Fetch content from download URL
            const downloadUrl = artifact.download_url;
            if (!downloadUrl) {
                console.error('[SessionContentViewer] No download URL for artifact');
                return;
            }

            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error('Failed to fetch artifact content');
            }

            const content = await response.text();
            const metadata = artifact.metadata || {};
            const filename = metadata.filename || 'file';

            // Detect language from filename
            const language = this.detectLanguage(filename);

            // Show in artifact viewer
            artifactHandler.showArtifact(content, language, null, filename);

        } catch (error) {
            console.error('[SessionContentViewer] Error viewing artifact:', error);
        }
    }

    async viewUpload(upload) {
        try {
            const metadata = upload.metadata || {};
            const path = metadata.path;
            const filename = metadata.filename || 'file';
            const mimeType = metadata.mime_type || 'application/octet-stream';

            if (!path) {
                console.error('[SessionContentViewer] No path for upload');
                return;
            }

            // Get Supabase public URL for the uploaded file
            const { data: { publicUrl } } = supabase.storage
                .from('media-uploads')
                .getPublicUrl(path);

            console.log('[SessionContentViewer] Upload URL:', publicUrl);

            // Handle different file types
            if (mimeType.startsWith('image/')) {
                // Show image in artifact viewer
                artifactHandler.showArtifact(publicUrl, 'image', null, filename);
            } else if (mimeType.startsWith('video/')) {
                // Show video in artifact viewer
                artifactHandler.showArtifact(publicUrl, 'video', null, filename);
            } else if (mimeType.startsWith('audio/')) {
                // Show audio in artifact viewer
                artifactHandler.showArtifact(publicUrl, 'audio', null, filename);
            } else if (mimeType === 'application/pdf') {
                // Open PDF in new tab
                window.open(publicUrl, '_blank');
            } else if (metadata.is_text) {
                // Fetch and show text content
                const response = await fetch(publicUrl);
                const content = await response.text();
                const language = this.detectLanguage(filename);
                artifactHandler.showArtifact(content, language, null, filename);
            } else {
                // Download other file types
                window.open(publicUrl, '_blank');
            }

        } catch (error) {
            console.error('[SessionContentViewer] Error viewing upload:', error);
        }
    }

    async viewExecution(execution) {
        try {
            // Fetch stdout/stderr from URLs
            const stdoutUrl = execution.stdout_url;
            const stderrUrl = execution.stderr_url;

            let stdout = '';
            let stderr = '';

            if (stdoutUrl) {
                const response = await fetch(stdoutUrl);
                if (response.ok) {
                    stdout = await response.text();
                }
            }

            if (stderrUrl) {
                const response = await fetch(stderrUrl);
                if (response.ok) {
                    stderr = await response.text();
                }
            }

            const metadata = execution.metadata || {};
            const command = metadata.command || 'Unknown command';
            const exitCode = metadata.exit_code ?? '?';

            // Format terminal output
            const terminalOutput = `$ ${command}\n\n${stdout}${stderr ? '\n\nSTDERR:\n' + stderr : ''}\n\nExit code: ${exitCode}`;

            // Show in artifact viewer
            artifactHandler.showArtifact(terminalOutput, 'bash', null, 'Terminal Output');

        } catch (error) {
            console.error('[SessionContentViewer] Error viewing execution:', error);
        }
    }

    detectLanguage(filename) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const languageMap = {
            'py': 'python',
            'js': 'javascript',
            'ts': 'typescript',
            'jsx': 'javascript',
            'tsx': 'typescript',
            'html': 'html',
            'css': 'css',
            'json': 'json',
            'md': 'markdown',
            'sh': 'bash',
            'bash': 'bash',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'go': 'go',
            'rs': 'rust',
            'rb': 'ruby',
            'php': 'php'
        };
        return languageMap[ext] || 'plaintext';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showError(message) {
        const loadingElements = this.modal?.querySelectorAll('.content-loading');
        const emptyElements = this.modal?.querySelectorAll('.content-empty');

        loadingElements?.forEach(el => el.classList.add('hidden'));
        emptyElements?.forEach(el => {
            el.classList.remove('hidden');
            el.querySelector('span').textContent = message;
        });
    }
}

// Create singleton instance
export const sessionContentViewer = new SessionContentViewer();
