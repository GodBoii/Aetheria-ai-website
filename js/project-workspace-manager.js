import { supabase } from './supabase-client.js';
import { DeployApiService } from './deploy-api-service.js';
import { sanitizeInput } from './security-utils.js';

function createDefaultState() {
    return {
        active: false,
        project: null,
        currentSource: 'workspace',
        fileLists: {
            workspace: [],
            deployment: []
        },
        preview: null,
        collapsedFolders: {
            workspace: new Set(),
            deployment: new Set()
        }
    };
}

export class ProjectWorkspaceManager {
    constructor({ apiService = new DeployApiService() } = {}) {
        this.apiService = apiService;
        this.state = createDefaultState();
        this.elements = {};
        this.bound = false;
    }

    async init() {
        this.cacheElements();
        this.bindEvents();
        this.updateUI();
    }

    cacheElements() {
        this.elements = {
            chip: document.getElementById('project-workspace-chip'),
            menuLabel: document.getElementById('project-workspace-menu-label'),
            actionsAnchor: document.getElementById('project-workspace-actions-anchor'),
            actionsBtn: document.getElementById('project-workspace-actions-btn'),
            quickMenu: document.getElementById('project-workspace-quick-menu'),
            sheetOverlay: document.getElementById('project-workspace-sheet-overlay'),
            filesSheet: document.getElementById('project-workspace-files-sheet'),
            githubSheet: document.getElementById('project-workspace-github-sheet'),
            filesClose: document.getElementById('project-workspace-files-close'),
            githubClose: document.getElementById('project-workspace-github-close'),
            fileTabs: document.querySelectorAll('.project-workspace-file-tab'),
            filesLoading: document.getElementById('project-workspace-files-loading'),
            filesEmpty: document.getElementById('project-workspace-files-empty'),
            fileTree: document.getElementById('project-workspace-file-tree'),
            filePreview: document.getElementById('project-workspace-file-preview'),
            filesSubtitle: document.getElementById('project-workspace-sheet-subtitle'),
            githubForm: document.getElementById('project-workspace-github-form'),
            githubUrl: document.getElementById('project-workspace-github-url'),
            githubBranch: document.getElementById('project-workspace-github-branch')
        };
    }

    bindEvents() {
        if (this.bound) return;
        this.bound = true;

        this.elements.actionsBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleQuickMenu();
        });

        this.elements.quickMenu?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-workspace-action]');
            if (!button) return;
            const action = button.dataset.workspaceAction;
            if (action === 'files') {
                this.openFilesSheet();
            } else if (action === 'sync') {
                this.syncFiles();
            } else if (action === 'github') {
                this.openGithubSheet();
            }
        });

        this.elements.sheetOverlay?.addEventListener('click', (event) => {
            if (event.target === this.elements.sheetOverlay) {
                this.closeSheets();
            }
        });

        this.elements.filesClose?.addEventListener('click', () => this.closeSheets());
        this.elements.githubClose?.addEventListener('click', () => this.closeSheets());

        this.elements.fileTabs?.forEach((tab) => {
            tab.addEventListener('click', () => {
                const source = tab.dataset.source;
                if (!source || source === this.state.currentSource) return;
                this.state.currentSource = source;
                this.state.preview = null;
                this.updateUI();
                this.loadFiles(source);
            });
        });

        this.elements.githubForm?.addEventListener('submit', (event) => this.handleGithubClone(event));

        document.addEventListener('click', (event) => {
            if (!event.target.closest('#project-workspace-actions-anchor')) {
                this.closeQuickMenu();
            }
        });

        document.addEventListener('project-workspace:start', (event) => {
            this.activate(event.detail?.project || null, { source: 'deployment' });
        });

        document.addEventListener('conversationCleared', () => {
            if (!this.state.active || this.state.currentSource !== 'workspace' || this.elements.filesSheet?.classList.contains('hidden')) {
                return;
            }
            this.state.preview = null;
            this.loadFiles('workspace', { silent: true });
        });

        document.addEventListener('messageAdded', (event) => {
            if (!this.state.active || event.detail?.role !== 'assistant' || this.elements.filesSheet?.classList.contains('hidden')) {
                return;
            }
            if (this.state.currentSource === 'workspace') {
                this.loadFiles('workspace', { silent: true });
            }
        });
    }

    isActive() {
        return this.state.active;
    }

    getAgentMode() {
        return this.state.active ? 'coder' : 'default';
    }

    getCurrentProject() {
        return this.state.project;
    }

    toggleFromMenu() {
        if (this.state.active) {
            this.deactivate();
        } else {
            this.activate(null, { source: 'menu' });
        }
    }

    activate(project = null, { source = 'menu' } = {}) {
        this.state.active = true;
        this.state.project = this.normalizeProject(project);
        this.state.currentSource = 'workspace';
        this.state.preview = null;
        this.state.fileLists.workspace = [];
        this.state.fileLists.deployment = [];
        this.state.collapsedFolders.workspace = new Set();
        this.state.collapsedFolders.deployment = new Set();
        this.closeQuickMenu();
        this.closeSheets();
        this.updateUI();

        if (source === 'deployment') {
            window.aios?.closePanel?.();
        }

        window.chat?.startNewConversation?.({ preserveAgentType: true });
        this.showNotification(
            this.state.project?.project_name
                ? `Coder Workspace ready for ${this.state.project.project_name}.`
                : 'Coder Workspace ready.',
            'success'
        );
    }

    deactivate() {
        this.state = createDefaultState();
        this.closeQuickMenu();
        this.closeSheets();
        this.updateUI();
        window.chat?.startNewConversation?.({ preserveAgentType: true });
        this.showNotification('Exited Coder Workspace.', 'info');
    }

    updateUI() {
        const isActive = this.state.active;
        const hasProject = Boolean(this.state.project?.site_id);

        this.elements.chip?.classList.toggle('hidden', !isActive);
        this.elements.actionsAnchor?.classList.toggle('hidden', !isActive);

        if (this.elements.menuLabel) {
            this.elements.menuLabel.textContent = isActive ? 'Exit Coder Workspace' : 'Coder Workspace';
        }

        this.elements.fileTabs?.forEach((tab) => {
            const isDeploymentTab = tab.dataset.source === 'deployment';
            tab.classList.toggle('hidden', isDeploymentTab && !hasProject);
            tab.classList.toggle('active', tab.dataset.source === this.state.currentSource);
        });

        if (this.elements.filesSubtitle) {
            this.elements.filesSubtitle.textContent = hasProject
                ? `${this.state.project.project_name} - ${this.state.currentSource === 'workspace' ? 'Sandbox workspace' : 'Deployment source'}`
                : 'Browse your sandbox workspace files';
        }
    }

    toggleQuickMenu() {
        if (!this.state.active) return;
        const isOpen = this.elements.quickMenu && !this.elements.quickMenu.classList.contains('hidden');
        this.elements.quickMenu?.classList.toggle('hidden', isOpen);
        this.elements.actionsBtn?.setAttribute('aria-expanded', String(!isOpen));
    }

    closeQuickMenu() {
        this.elements.quickMenu?.classList.add('hidden');
        this.elements.actionsBtn?.setAttribute('aria-expanded', 'false');
    }

    openFilesSheet() {
        if (!this.state.active) return;
        this.closeQuickMenu();
        this.state.preview = null;
        this.elements.sheetOverlay?.classList.remove('hidden');
        this.elements.githubSheet?.classList.add('hidden');
        this.elements.filesSheet?.classList.remove('hidden');
        this.updateUI();
        this.loadFiles(this.state.currentSource);
    }

    openGithubSheet() {
        if (!this.state.active) return;
        this.closeQuickMenu();
        this.elements.sheetOverlay?.classList.remove('hidden');
        this.elements.filesSheet?.classList.add('hidden');
        this.elements.githubSheet?.classList.remove('hidden');
        this.elements.githubUrl?.focus();
    }

    closeSheets() {
        this.elements.sheetOverlay?.classList.add('hidden');
        this.elements.filesSheet?.classList.add('hidden');
        this.elements.githubSheet?.classList.add('hidden');
    }

    async syncFiles() {
        if (!this.state.active) return;
        this.closeQuickMenu();
        this.showNotification('Files syncing...', 'info', 1200);

        try {
            await this.refreshSources();
            this.showNotification('Files synced.', 'success');
        } catch (error) {
            this.showNotification(error.message || 'Failed to sync files.', 'error');
        }
    }

    async refreshSources() {
        const token = await this.getAccessToken();
        if (!token) {
            throw new Error('You must be logged in to sync files.');
        }

        const conversationId = window.chat?.getCurrentConversationId?.();
        const tasks = [];

        if (conversationId) {
            tasks.push(
                this.apiService.listWorkspaceFiles(token, conversationId)
                    .then((payload) => {
                        this.state.fileLists.workspace = Array.isArray(payload?.files) ? payload.files : [];
                    })
            );
        }

        if (this.state.project?.site_id) {
            tasks.push(
                this.apiService.listDeploymentFiles(
                    token,
                    this.state.project.site_id,
                    this.state.project.deployment_id
                ).then((files) => {
                    this.state.fileLists.deployment = Array.isArray(files) ? files : [];
                })
            );
        }

        await Promise.all(tasks);

        if (!this.elements.filesSheet?.classList.contains('hidden')) {
            this.renderFileTree(this.state.currentSource);
        }
    }

    async loadFiles(source = 'workspace', { silent = false } = {}) {
        if (!this.state.active) return;

        const token = await this.getAccessToken();
        if (!token) {
            this.renderEmptyState('You must be logged in to browse project files.');
            return;
        }

        if (!silent) {
            this.setLoading(true);
        }

        try {
            if (source === 'workspace') {
                const conversationId = window.chat?.getCurrentConversationId?.();
                if (!conversationId) {
                    this.state.fileLists.workspace = [];
                } else {
                    const payload = await this.apiService.listWorkspaceFiles(token, conversationId);
                    this.state.fileLists.workspace = Array.isArray(payload?.files) ? payload.files : [];
                }
            } else if (source === 'deployment') {
                if (!this.state.project?.site_id) {
                    this.state.fileLists.deployment = [];
                } else {
                    this.state.fileLists.deployment = await this.apiService.listDeploymentFiles(
                        token,
                        this.state.project.site_id,
                        this.state.project.deployment_id
                    );
                }
            }

            this.renderFileTree(source);
        } catch (error) {
            this.renderEmptyState(error.message || 'Failed to load files.');
        } finally {
            if (!silent) {
                this.setLoading(false);
            }
        }
    }

    renderFileTree(source) {
        const rows = this.state.fileLists[source] || [];
        this.elements.filePreview?.classList.add('hidden');
        this.elements.fileTree?.classList.remove('hidden');
        this.elements.filePreview?.replaceChildren();

        if (!rows.length) {
            const message = source === 'workspace'
                ? 'No files yet. Ask the coder agent to inspect, create, or edit something first.'
                : 'No deployment files were found for this project.';
            this.renderEmptyState(message);
            return;
        }

        this.elements.filesEmpty?.classList.add('hidden');
        this.elements.fileTree?.replaceChildren(this.buildTreeElement(rows, source));
    }

    buildTreeElement(rows, source) {
        const root = this.buildTree(rows);
        const container = document.createElement('div');
        container.className = 'project-workspace-file-list';
        root.children.forEach((node) => {
            container.appendChild(this.renderNode(node, source));
        });
        return container;
    }

    renderNode(node, source) {
        const wrapper = document.createElement('div');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `project-workspace-tree-row ${node.type === 'folder' ? 'is-folder' : 'is-file'}`;
        row.style.paddingLeft = `${0.8 + (node.depth * 0.8)}rem`;

        if (node.type === 'folder') {
            const collapsed = this.state.collapsedFolders[source].has(node.path);
            row.innerHTML = `
                <i class="fas ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
                <i class="fas fa-folder"></i>
                <span>${this.escapeHtml(node.name)}</span>
            `;
            row.addEventListener('click', () => {
                if (collapsed) {
                    this.state.collapsedFolders[source].delete(node.path);
                } else {
                    this.state.collapsedFolders[source].add(node.path);
                }
                this.renderFileTree(source);
            });
            wrapper.appendChild(row);

            if (!collapsed) {
                const children = document.createElement('div');
                children.className = 'project-workspace-tree-children';
                node.children.forEach((child) => {
                    children.appendChild(this.renderNode(child, source));
                });
                wrapper.appendChild(children);
            }
            return wrapper;
        }

        row.innerHTML = `
            <i class="fas fa-file-code"></i>
            <span>${this.escapeHtml(node.name)}</span>
            <span class="project-workspace-tree-meta">${this.formatBytes(node.size)}</span>
        `;
        row.addEventListener('click', () => this.openFilePreview(node, source));
        wrapper.appendChild(row);
        return wrapper;
    }

    buildTree(rows) {
        const root = { type: 'folder', name: '', path: '', depth: -1, childrenMap: new Map(), children: [] };

        rows.forEach((row) => {
            const filePath = String(row?.path || '').replace(/^\/+/, '');
            if (!filePath) return;

            const parts = filePath.split('/').filter(Boolean);
            let cursor = root;

            parts.forEach((part, index) => {
                const isFile = index === parts.length - 1;
                const nodePath = parts.slice(0, index + 1).join('/');
                const existing = cursor.childrenMap.get(part);

                if (existing) {
                    cursor = existing;
                    return;
                }

                const node = {
                    type: isFile ? 'file' : 'folder',
                    name: part,
                    path: nodePath,
                    depth: index,
                    size: isFile ? Number(row?.size || 0) : 0,
                    childrenMap: isFile ? null : new Map(),
                    children: isFile ? null : []
                };

                cursor.childrenMap.set(part, node);
                cursor.children.push(node);
                cursor = node;
            });
        });

        const sortNodes = (nodes) => {
            nodes.sort((left, right) => {
                if (left.type !== right.type) {
                    return left.type === 'folder' ? -1 : 1;
                }
                return left.name.localeCompare(right.name);
            });
            nodes.forEach((node) => {
                if (node.children) sortNodes(node.children);
            });
        };

        sortNodes(root.children);
        return root;
    }

    async openFilePreview(node, source) {
        const token = await this.getAccessToken();
        if (!token) {
            this.showNotification('You must be logged in to preview files.', 'error');
            return;
        }

        this.elements.fileTree?.classList.add('hidden');
        this.elements.filePreview?.classList.remove('hidden');
        this.elements.filePreview.innerHTML = `
            <div class="project-workspace-sheet-state">
                <i class="fas fa-spinner fa-spin"></i>
                <span>Loading ${this.escapeHtml(node.name)}…</span>
            </div>
        `;

        try {
            const payload = source === 'workspace'
                ? await this.apiService.getWorkspaceFileContent(
                    token,
                    window.chat?.getCurrentConversationId?.(),
                    node.path
                )
                : await this.apiService.getDeploymentFileContent(
                    token,
                    this.state.project?.site_id,
                    node.path,
                    this.state.project?.deployment_id
                );

            this.state.preview = { source, node, payload };
            this.renderFilePreview();
        } catch (error) {
            this.elements.filePreview.innerHTML = `
                <div class="project-workspace-sheet-state">
                    <i class="fas fa-circle-exclamation"></i>
                    <span>${this.escapeHtml(error.message || 'Failed to load file preview.')}</span>
                </div>
            `;
        }
    }

    renderFilePreview() {
        if (!this.state.preview) return;
        const { node, payload } = this.state.preview;
        const warning = payload?.is_binary
            ? 'This file is binary and cannot be previewed.'
            : payload?.truncated
                ? 'This preview was truncated for performance.'
                : '';
        const content = payload?.is_binary ? '' : this.escapeHtml(payload?.content || '');

        this.elements.filePreview.innerHTML = `
            <div class="project-workspace-file-preview-header">
                <button type="button" class="project-workspace-preview-back">
                    <i class="fas fa-arrow-left"></i>
                    <span>Back</span>
                </button>
                <div>
                    <h4>${this.escapeHtml(node.name)}</h4>
                    <div class="project-workspace-preview-meta">${this.escapeHtml(node.path)}</div>
                </div>
            </div>
            ${warning ? `<div class="project-workspace-file-warning">${this.escapeHtml(warning)}</div>` : ''}
            <div class="project-workspace-preview-content">
                <pre><code>${content || this.escapeHtml('Preview unavailable for this file.')}</code></pre>
            </div>
        `;

        this.elements.filePreview.querySelector('.project-workspace-preview-back')?.addEventListener('click', () => {
            this.state.preview = null;
            this.renderFileTree(this.state.currentSource);
        });

        const codeBlock = this.elements.filePreview.querySelector('pre code');
        if (codeBlock && !payload?.is_binary && window.hljs) {
            window.hljs.highlightElement(codeBlock);
        }
    }

    async handleGithubClone(event) {
        event.preventDefault();

        const rawRepoUrl = this.elements.githubUrl?.value.trim();
        const rawBranch = this.elements.githubBranch?.value.trim();

        if (!rawRepoUrl) {
            this.showNotification('GitHub URL is required.', 'warning');
            return;
        }

        let repoUrl = '';
        let branch = '';

        try {
            repoUrl = sanitizeInput.githubUrl(rawRepoUrl).replace(/\.git$/, '');
            branch = rawBranch ? sanitizeInput.branchName(rawBranch) : '';
        } catch (error) {
            this.showNotification(error.message || 'Invalid GitHub clone input.', 'error');
            return;
        }

        const promptLines = [
            `Clone the GitHub repository ${repoUrl} into the current Coder Workspace sandbox.`,
            branch ? `Use branch ${branch}.` : 'Use the repository default branch.',
            'After cloning, verify the workspace contents and summarize the result briefly.'
        ];

        if (this.state.project?.project_name) {
            promptLines.unshift(`Project context: ${this.state.project.project_name}.`);
        }

        try {
            await window.chat?.sendProjectWorkspaceCommand?.(promptLines.join(' '));
            this.closeSheets();
            this.showNotification('GitHub clone request sent.', 'success');
            this.elements.githubForm?.reset();
        } catch (error) {
            this.showNotification(error?.message || 'Failed to send clone request.', 'error');
        }
    }

    setLoading(isLoading) {
        this.elements.filesLoading?.classList.toggle('hidden', !isLoading);
        if (!isLoading) return;
        this.elements.filesEmpty?.classList.add('hidden');
        this.elements.fileTree?.replaceChildren();
        this.elements.filePreview?.replaceChildren();
        this.elements.filePreview?.classList.add('hidden');
        this.elements.fileTree?.classList.remove('hidden');
    }

    renderEmptyState(message) {
        this.elements.filesEmpty?.classList.remove('hidden');
        this.elements.filesEmpty.innerHTML = `
            <i class="fas fa-folder-open"></i>
            <span>${this.escapeHtml(message)}</span>
        `;
        this.elements.fileTree?.replaceChildren();
        this.elements.filePreview?.replaceChildren();
        this.elements.filePreview?.classList.add('hidden');
        this.elements.fileTree?.classList.remove('hidden');
    }

    normalizeProject(project) {
        if (!project || typeof project !== 'object') return null;
        return {
            site_id: project.site_id || null,
            project_name: project.project_name || 'Untitled',
            deployment_id: project.deployment_id || null,
            slug: project.slug || null,
            hostname: project.hostname || null
        };
    }

    async getAccessToken() {
        await supabase.auth.refreshSession();
        const { data: { session } } = await supabase.auth.getSession();
        return session?.access_token || null;
    }

    showNotification(message, type = 'info', duration = 3000) {
        if (!message) return;
        window.chat?.showNotification?.(message, type, duration);
    }

    formatBytes(size) {
        const value = Number(size || 0);
        if (!value) return '0 B';
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
