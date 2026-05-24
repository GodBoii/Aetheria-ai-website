import { supabase } from './supabase-client.js';
import { DeployApiService, inferContentTypeFromPath } from './deploy-api-service.js';
import { userFileCache } from './user-file-cache.js';

export class DeploySettingsManager {
    constructor({ apiService = new DeployApiService(), notify = () => {} } = {}) {
        this.apiService = apiService;
        this.notify = notify;
        this.deploymentsCache = [];
        this.filesCache = [];
        this.filteredFiles = [];
        this.fileSearchQuery = '';
        this.fileViewMode = 'detailed';
        this.fileSearchDebounceTimer = null;
        this.thumbnailObjectUrls = new Map();
        this.thumbnailPromises = new Map();
        this.previewObserver = null;
        this.inlinePreviewObjectUrl = null;
        this.activeInlinePreviewFileId = null;
        this.textPreviewSnippets = new Map();
        this.textPreviewPromises = new Map();
        this.localFileIds = new Set();
        this.backgroundDownloadQueue = [];
        this.backgroundDownloadsInFlight = new Set();
        this.backgroundDownloadConcurrency = 2;
        this.lastFilesSyncAt = 0;
        this.nativeFileVaultPlugin = null;
        this.nativeFileVaultReady = false;
        this.nativeFileVaultAvailable = false;
        this.bound = false;
    }

    bindEvents() {
        if (this.bound) return;
        this.bound = true;

        document.getElementById('refresh-deployments-btn')?.addEventListener('click', () => {
            this.loadDeployments(true);
        });
        document.getElementById('refresh-files-btn')?.addEventListener('click', () => {
            this.loadFiles(true);
        });
        document.getElementById('files-search-input')?.addEventListener('input', (event) => {
            this.fileSearchQuery = event.target?.value || '';
            this.handleSearchInput();
        });
        document.getElementById('files-view-detailed-btn')?.addEventListener('click', () => {
            this.setFileViewMode('detailed');
        });
        document.getElementById('files-view-preview-btn')?.addEventListener('click', () => {
            this.setFileViewMode('preview');
        });
        document.getElementById('settings-upload-file-btn')?.addEventListener('click', () => {
            document.getElementById('settings-files-input')?.click();
        });
        document.getElementById('settings-files-input')?.addEventListener('change', async (event) => {
            const files = Array.from(event.target?.files || []);
            if (!files.length) return;
            await this.uploadFiles(files);
            event.target.value = '';
        });
        document.getElementById('open-files-cache-folder-btn')?.addEventListener('click', async () => {
            await this.openCacheLocation();
        });
        document.getElementById('files-inline-preview')?.addEventListener('click', (event) => {
            if (event.target?.closest?.('[data-close-inline-preview]')) {
                this.hideInlinePreview();
            }
        });
    }

    async getAccessToken() {
        try {
            await supabase.auth.refreshSession();
        } catch (_error) {
            // Allow local-only file access when refresh is unavailable.
        }
        try {
            const { data: { session } } = await supabase.auth.getSession();
            return session?.access_token || null;
        } catch (_error) {
            return null;
        }
    }

    async ensureNativeFileVaultPlugin() {
        if (this.nativeFileVaultReady) return;
        this.nativeFileVaultReady = true;
        this.nativeFileVaultAvailable = false;
        this.nativeFileVaultPlugin = null;
    }

    async getLocalRows() {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            try {
                const result = await this.nativeFileVaultPlugin.listLocalFiles();
                const files = Array.isArray(result?.files) ? result.files : [];
                return files.map((row) => ({
                    id: String(row.id || ''),
                    file_name: row.file_name || 'Untitled',
                    mime_type: row.mime_type || 'application/octet-stream',
                    size_bytes: Number(row.size_bytes || 0),
                    created_at: row.created_at || null,
                    storage_path: row.storage_path || '',
                    tags: Array.isArray(row.tags) ? row.tags : [],
                    local_available: !!row.local_available,
                    local_cached_at: row.local_cached_at || null,
                    updatedAt: Number(row.updated_at || Date.now()),
                }));
            } catch (_error) {
                // Fallback below.
            }
        }
        return userFileCache.listRows();
    }

    async syncLocalMetadata(rows = []) {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            try {
                await this.nativeFileVaultPlugin.syncMetadata({ files: rows });
                return;
            } catch (_error) {
                // Fallback below.
            }
        }
        await userFileCache.upsertMetadataRows(rows);
    }

    async hasLocalFile(fileId) {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            try {
                const result = await this.nativeFileVaultPlugin.hasFile({ fileId: String(fileId || '') });
                return !!result?.has_file;
            } catch (_error) {
                // Fallback below.
            }
        }
        return userFileCache.hasLocalBlob(fileId);
    }

    async saveLocalFile(row, blob) {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            const base64 = await this.blobToBase64(blob);
            await this.nativeFileVaultPlugin.saveFile({
                fileId: String(row?.id || ''),
                fileName: String(row?.file_name || 'file.bin'),
                mimeType: String(row?.mime_type || 'application/octet-stream'),
                sizeBytes: Number(row?.size_bytes || blob?.size || 0),
                createdAt: String(row?.created_at || ''),
                storagePath: String(row?.storage_path || ''),
                tags: Array.isArray(row?.tags) ? row.tags : [],
                contentBase64: base64,
            });
            return;
        }
        await userFileCache.saveFileBlob(row, blob);
    }

    async getLocalBlob(fileId) {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            try {
                const result = await this.nativeFileVaultPlugin.readFile({ fileId: String(fileId || '') });
                const base64 = String(result?.content_base64 || '');
                const mimeType = String(result?.mime_type || 'application/octet-stream');
                if (!base64) return null;
                return this.base64ToBlob(base64, mimeType);
            } catch (_error) {
                return null;
            }
        }
        return userFileCache.getFileBlob(fileId);
    }

    async deleteLocalFile(fileId) {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            try {
                await this.nativeFileVaultPlugin.deleteFile({ fileId: String(fileId || '') });
                return;
            } catch (_error) {
                // Fallback below.
            }
        }
        await userFileCache.deleteFile(fileId);
    }

    async loadDeployments(showNotification = false) {
        this.bindEvents();
        try {
            const token = await this.getAccessToken();
            if (!token) {
                this.deploymentsCache = [];
                this.renderDeployments([]);
                return;
            }
            this.deploymentsCache = await this.apiService.listDeployments(token, 100);
            this.renderDeployments(this.deploymentsCache);
            if (showNotification) this.notify('Deployments refreshed', 'success');
        } catch (error) {
            this.renderDeployments([]);
            if (showNotification) this.notify(error.message || 'Failed to load deployments', 'error');
        }
    }

    async loadFiles(showNotification = false) {
        this.bindEvents();
        let localRows = [];
        try {
            localRows = await this.getLocalRows();
            if (localRows.length > 0) {
                this.filesCache = this.sortRowsByCreated(localRows);
                this.localFileIds = new Set(localRows.filter((row) => row.local_available).map((row) => String(row.id)));
                this.applyFiltersAndRender(false);
            }

            const token = await this.getAccessToken();
            if (!token) {
                if (localRows.length === 0) {
                    this.filesCache = [];
                    this.localFileIds = new Set();
                    this.applyFiltersAndRender(false);
                }
                return;
            }

            const now = Date.now();
            const shouldNetworkSync =
                showNotification ||
                localRows.length === 0 ||
                (now - this.lastFilesSyncAt) > (3 * 60 * 1000);

            if (!shouldNetworkSync) {
                this.startBackgroundLazyDownload(token, this.filesCache);
                return;
            }

            const remoteRows = await this.apiService.listUserFiles(token, {
                limit: 200,
                search: '',
                fileType: 'all',
            });

            await this.syncLocalMetadata(remoteRows);
            const mergedRows = await this.getLocalRows();
            this.filesCache = this.sortRowsByCreated(mergedRows);
            this.localFileIds = new Set(mergedRows.filter((row) => row.local_available).map((row) => String(row.id)));
            this.lastFilesSyncAt = now;
            this.applyFiltersAndRender(true);
            this.startBackgroundLazyDownload(token, this.filesCache);
            if (showNotification) this.notify('Files refreshed', 'success');
        } catch (error) {
            if (localRows.length === 0) {
                this.filesCache = [];
                this.localFileIds = new Set();
                this.applyFiltersAndRender(false);
            }
            if (showNotification) this.notify(error.message || 'Failed to load files', 'error');
        }
    }

    reset() {
        this.deploymentsCache = [];
        this.filesCache = [];
        this.filteredFiles = [];
        this.fileSearchQuery = '';
        this.fileViewMode = 'detailed';
        this.localFileIds = new Set();
        this.backgroundDownloadQueue = [];
        this.backgroundDownloadsInFlight.clear();
        this.lastFilesSyncAt = 0;
        if (this.fileSearchDebounceTimer) {
            clearTimeout(this.fileSearchDebounceTimer);
            this.fileSearchDebounceTimer = null;
        }
        this.cleanupPreviewResources();
        this.hideInlinePreview();
        this.renderDeployments([]);
        this.applyFiltersAndRender(false);
    }

    renderDeployments(projects) {
        const list = document.getElementById('deployments-list');
        const empty = document.getElementById('deployments-empty');
        if (!list || !empty) return;

        list.innerHTML = '';
        const items = Array.isArray(projects) ? projects : [];
        if (!items.length) {
            empty.classList.remove('hidden');
            empty.innerHTML = '<div class="empty-state-text">No deployments found.</div>';
            return;
        }
        empty.classList.add('hidden');

        items.forEach((project) => {
            const status = this.safeText(project.deployment_status, 'unknown').toLowerCase();
            const badgeClass = status === 'active' ? 'status-active' : status === 'draft' ? 'status-draft' : '';
            const hostname = this.safeText(project.hostname, '');
            const url = hostname ? `https://${hostname}` : '';

            const card = document.createElement('div');
            card.className = 'settings-card';
            card.innerHTML = `
                <div class="settings-card-header">
                    <h4>${this.safeText(project.project_name, 'Untitled')}</h4>
                    <div class="settings-card-actions">
                        <span class="settings-badge ${badgeClass}">${this.safeText(project.deployment_status, 'unknown')}</span>
                        <button class="settings-secondary-btn" data-start-project-workspace type="button">
                            <i class="fas fa-laptop-code"></i>
                            <span>Start Coding</span>
                        </button>
                        ${url ? `<button class="settings-link-btn" data-open-url="${this.escapeHtml(url)}" type="button"><i class="fas fa-up-right-from-square"></i></button>` : ''}
                    </div>
                </div>
                <div class="settings-meta-grid">
                    <div><strong>Site ID</strong><span>${this.safeText(project.site_id)}</span></div>
                    <div><strong>Slug</strong><span>${this.safeText(project.slug)}</span></div>
                    <div><strong>Hostname</strong><span>${this.safeText(project.hostname)}</span></div>
                    <div><strong>Version</strong><span>v${this.safeText(project.version)}</span></div>
                    <div><strong>Deployment ID</strong><span>${this.safeText(project.deployment_id)}</span></div>
                    <div><strong>R2 Prefix</strong><span>${this.safeText(project.r2_prefix)}</span></div>
                </div>
            `;
            card.querySelector('[data-open-url]')?.addEventListener('click', (event) => {
                const targetUrl = event.currentTarget?.dataset?.openUrl;
                if (targetUrl) window.open(targetUrl, '_blank', 'noopener,noreferrer');
            });
            card.querySelector('[data-start-project-workspace]')?.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('project-workspace:start', {
                    detail: { project }
                }));
            });
            list.appendChild(card);
        });
    }

    handleSearchInput() {
        if (this.fileSearchDebounceTimer) {
            clearTimeout(this.fileSearchDebounceTimer);
        }
        this.fileSearchDebounceTimer = setTimeout(() => {
            this.applyFiltersAndRender(false);
        }, 120);
    }

    setFileViewMode(mode) {
        const normalized = mode === 'preview' ? 'preview' : 'detailed';
        if (this.fileViewMode === normalized) return;
        this.fileViewMode = normalized;
        this.syncViewToggleUI();
        this.applyFiltersAndRender(true);
    }

    syncViewToggleUI() {
        const detailedBtn = document.getElementById('files-view-detailed-btn');
        const previewBtn = document.getElementById('files-view-preview-btn');
        const isDetailed = this.fileViewMode === 'detailed';
        detailedBtn?.classList.toggle('active', isDetailed);
        previewBtn?.classList.toggle('active', !isDetailed);
    }

    getFilesPanelScrollContainer() {
        return document.getElementById('files-panel-content');
    }

    applyFiltersAndRender(preserveScroll = true) {
        const query = String(this.fileSearchQuery || '').trim().toLowerCase();
        const rows = Array.isArray(this.filesCache) ? this.filesCache : [];
        if (!query) {
            this.filteredFiles = rows;
        } else {
            this.filteredFiles = rows.filter((row) => {
                const tags = Array.isArray(row?.tags) ? row.tags.join(' ') : '';
                const searchable = [
                    row?.file_name,
                    row?.mime_type,
                    row?.id,
                    row?.storage_path,
                    tags,
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                return searchable.includes(query);
            });
        }
        this.renderFiles(this.filteredFiles, { preserveScroll });
    }

    renderFiles(files, { preserveScroll = true } = {}) {
        const list = document.getElementById('files-list');
        const empty = document.getElementById('files-empty');
        if (!list || !empty) return;

        this.syncViewToggleUI();

        const scroller = this.getFilesPanelScrollContainer();
        const previousScrollTop = preserveScroll ? (scroller?.scrollTop || 0) : 0;
        const rows = Array.isArray(files) ? files : [];
        list.innerHTML = '';
        list.classList.remove('files-detailed-view', 'files-preview-view');
        list.classList.add(this.fileViewMode === 'preview' ? 'files-preview-view' : 'files-detailed-view');

        if (!rows.length) {
            empty.classList.remove('hidden');
            empty.innerHTML = '<div class="empty-state-text">No files found.</div>';
            return;
        }
        empty.classList.add('hidden');

        if (this.fileViewMode === 'preview') {
            this.renderFilesPreview(rows, list);
        } else {
            this.renderFilesDetailed(rows, list);
        }

        if (scroller) {
            requestAnimationFrame(() => {
                scroller.scrollTop = previousScrollTop;
            });
        }
    }

    renderFilesDetailed(rows, list) {
        rows.forEach((row) => {
            const fileName = this.safeText(row.file_name, 'Untitled');
            const mimeType = this.safeText(row.mime_type, 'application/octet-stream');
            const majorType = this.getMajorType(row).toLowerCase();
            const isLocal = !!row.local_available;
            const card = document.createElement('div');
            card.className = 'settings-card files-detailed-card';
            card.innerHTML = `
                <div class="settings-card-header">
                    <div class="files-card-heading">
                        <i class="${this.getFileIconClass(row)}"></i>
                        <h4>${fileName}</h4>
                    </div>
                    <div class="settings-card-actions">
                        <span class="settings-badge">${this.safeText(majorType, 'file')}</span>
                        <span class="settings-badge ${isLocal ? 'status-active' : 'status-draft'}">${isLocal ? 'Local' : 'Syncing'}</span>
                        <button class="settings-secondary-btn" data-open-file type="button">
                            <i class="fas fa-eye"></i>
                            <span>Open</span>
                        </button>
                        <button class="settings-link-btn" data-download-file type="button" title="Download">
                            <i class="fas fa-download"></i>
                        </button>
                        <button class="settings-link-btn" data-delete-file type="button" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="settings-meta-grid">
                    <div><strong>File ID</strong><span>${this.safeText(row.id)}</span></div>
                    <div><strong>MIME Type</strong><span>${mimeType}</span></div>
                    <div><strong>Size</strong><span>${this.formatFileSize(row.size_bytes)}</span></div>
                    <div><strong>Created</strong><span>${this.formatDate(row.created_at)}</span></div>
                    <div><strong>Storage</strong><span>${this.safeText(row.storage_path)}</span></div>
                    <div><strong>Tags</strong><span>${this.safeText(this.formatTags(row.tags), 'none')}</span></div>
                </div>
            `;
            card.querySelector('[data-open-file]')?.addEventListener('click', () => this.openFile(row));
            card.querySelector('[data-download-file]')?.addEventListener('click', () => this.downloadFile(row));
            card.querySelector('[data-delete-file]')?.addEventListener('click', () => this.deleteFile(row));
            list.appendChild(card);
        });
    }

    renderFilesPreview(rows, list) {
        rows.forEach((row) => {
            const card = document.createElement('article');
            card.className = 'files-preview-card';
            const fileName = this.safeText(row.file_name, 'Untitled');
            const typeLabel = this.safeText(this.getMajorType(row).toLowerCase(), 'file');
            const isLocal = !!row.local_available;
            const isImage = this.isImageFile(row);
            const isTextLike = this.isTextLikeMime(row?.mime_type, row?.file_name);
            card.innerHTML = `
                <div class="files-preview-media">
                    ${isImage ? `<img class="files-preview-image hidden" alt="${fileName}" loading="lazy" />` : ''}
                    ${isTextLike ? `<pre class="files-preview-text-snippet hidden"></pre>` : ''}
                    <div class="files-preview-fallback ${isImage ? 'is-image-placeholder' : ''}">
                        <i class="${this.getFileIconClass(row)}"></i>
                    </div>
                </div>
                <div class="files-preview-body">
                    <h4>${fileName}</h4>
                    <p>${typeLabel} · ${this.formatFileSize(row.size_bytes)} · ${isLocal ? 'local' : 'syncing'}</p>
                </div>
                <div class="files-preview-actions">
                    <button class="settings-link-btn" data-open-file type="button" title="Open"><i class="fas fa-eye"></i></button>
                    <button class="settings-link-btn" data-download-file type="button" title="Download"><i class="fas fa-download"></i></button>
                    <button class="settings-link-btn" data-delete-file type="button" title="Delete"><i class="fas fa-trash"></i></button>
                </div>
            `;

            card.querySelector('[data-open-file]')?.addEventListener('click', () => this.openFile(row));
            card.querySelector('[data-download-file]')?.addEventListener('click', () => this.downloadFile(row));
            card.querySelector('[data-delete-file]')?.addEventListener('click', () => this.deleteFile(row));

            list.appendChild(card);
            this.populatePreviewCardMedia(row, card, { isLocal, isImage, isTextLike });
        });
    }

    async populatePreviewCardMedia(row, card, { isLocal, isImage, isTextLike }) {
        if (!card || !isLocal) return;
        const fallback = card.querySelector('.files-preview-fallback');
        if (!fallback) return;

        if (isImage) {
            const imgEl = card.querySelector('.files-preview-image');
            if (!imgEl) return;
            await this.loadImagePreview(row, imgEl);
            return;
        }

        if (!isTextLike) return;
        const snippetEl = card.querySelector('.files-preview-text-snippet');
        if (!snippetEl) return;

        const fileId = String(row?.id || '');
        if (!fileId) return;

        let snippet = this.textPreviewSnippets.get(fileId);
        if (!snippet) {
            if (!this.textPreviewPromises.has(fileId)) {
                this.textPreviewPromises.set(fileId, this.fetchTextSnippet(row));
            }
            snippet = await this.textPreviewPromises.get(fileId);
            this.textPreviewPromises.delete(fileId);
            if (snippet) this.textPreviewSnippets.set(fileId, snippet);
        }

        if (!snippet || !snippetEl.isConnected) return;
        snippetEl.textContent = snippet;
        snippetEl.classList.remove('hidden');
        fallback.classList.add('hidden');
    }

    async fetchTextSnippet(file) {
        try {
            const blob = await this.getLocalBlob(file?.id);
            if (!blob) return '';
            const text = await blob.text();
            return this.formatTextSnippet(text, 280);
        } catch (_error) {
            return '';
        }
    }

    formatTextSnippet(text, maxLength = 280) {
        const normalized = String(text || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\s+/g, ' ')
            .trim();
        if (!normalized) return '';
        return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
    }

    async uploadFiles(files) {
        const token = await this.getAccessToken();
        if (!token) {
            this.notify('Login required to upload files.', 'error');
            return;
        }

        for (const file of files) {
            try {
                const contentBase64 = await this.readFileAsBase64(file);
                const mimeType = this.inferMimeType(file);
                const uploadResult = await this.apiService.uploadUserFile(token, {
                    fileName: file.name,
                    mimeType,
                    contentBase64,
                    sizeBytes: Number(file.size || 0),
                    tags: [],
                });
                const uploadedRow = uploadResult?.file || {
                    id: uploadResult?.id || `${Date.now()}-${Math.random()}`,
                    file_name: file.name,
                    mime_type: mimeType,
                    size_bytes: Number(file.size || 0),
                    created_at: new Date().toISOString(),
                    storage_path: '',
                    tags: [],
                };
                await this.saveLocalFile(uploadedRow, file);
                this.notify(`Uploaded: ${file.name}`, 'success');
            } catch (error) {
                this.notify(`Upload failed for ${file.name}: ${error.message}`, 'error');
            }
        }
        await this.loadFiles(true);
    }

    async openFile(file) {
        try {
            let token = null;
            try {
                token = await this.getAccessToken();
            } catch (_error) {
                token = null;
            }
            const hasLocal = await this.hasLocalFile(file?.id);
            if (!token && !hasLocal) {
                this.notify('Login required to open files.', 'error');
                return;
            }
            await this.renderInlinePreview(file, token);
        } catch (error) {
            this.notify(error.message || 'Failed to open file', 'error');
        }
    }
    async renderInlinePreview(file, token = null) {
        const panel = document.getElementById('files-inline-preview');
        if (!panel || !file?.id) return;

        const fileId = String(file.id);
        const fileName = this.safeText(file.file_name, 'Untitled');
        panel.classList.remove('hidden');
        panel.innerHTML = `
            <div class="files-inline-preview-header">
                <div class="files-inline-preview-title-wrap">
                    <h3 class="files-inline-preview-title">${fileName}</h3>
                    <p class="files-inline-preview-subtitle">Loading preview...</p>
                </div>
                <button class="settings-link-btn" type="button" data-close-inline-preview title="Close preview">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>
            <div class="files-inline-preview-body">
                <div class="files-inline-preview-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>Loading content...</span>
                </div>
            </div>
        `;

        if (this.inlinePreviewObjectUrl) {
            URL.revokeObjectURL(this.inlinePreviewObjectUrl);
            this.inlinePreviewObjectUrl = null;
        }
        this.activeInlinePreviewFileId = fileId;

        const mimeType = String(file.mime_type || this.inferMimeType({ name: file.file_name, type: '' }) || '').toLowerCase();
        const subtitle = panel.querySelector('.files-inline-preview-subtitle');
        const body = panel.querySelector('.files-inline-preview-body');
        if (!body) return;

        let localBlob = await this.getLocalBlob(fileId);
        if (!localBlob) {
            if (!token) {
                body.innerHTML = `
                    <div class="files-inline-preview-empty">
                        <i class="fas fa-clock"></i>
                        <p>This file is not yet downloaded locally. Connect and refresh to sync it.</p>
                    </div>
                `;
                return;
            }
            const downloadedBlob = await this.apiService.downloadUserFile(token, fileId);
            await this.saveLocalFile(file, downloadedBlob);
            localBlob = downloadedBlob;
            this.localFileIds.add(fileId);
            this.markFileAsLocal(fileId);
        }

        if (!localBlob || this.activeInlinePreviewFileId !== fileId) return;

        if (mimeType.startsWith('image/')) {
            this.inlinePreviewObjectUrl = URL.createObjectURL(localBlob);
            if (subtitle) subtitle.textContent = `${this.safeText(mimeType)} · ${this.formatFileSize(file.size_bytes)} · local`;
            body.innerHTML = `
                <div class="files-inline-preview-media-wrap">
                    <img src="${this.inlinePreviewObjectUrl}" alt="${fileName}" class="files-inline-preview-image" />
                </div>
            `;
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        const isTextLike = this.isTextLikeMime(mimeType, file.file_name);
        if (!isTextLike) {
            body.innerHTML = `
                <div class="files-inline-preview-empty">
                    <i class="${this.getFileIconClass(file)}"></i>
                    <p>This file is binary and cannot be shown as text preview here.</p>
                    <button class="btn btn-secondary settings-refresh-btn" type="button" data-download-inline-binary>
                        <i class="fas fa-download"></i>
                        <span>Download File</span>
                    </button>
                </div>
            `;
            body.querySelector('[data-download-inline-binary]')?.addEventListener('click', () => this.downloadFile(file));
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        const textContent = await localBlob.text();
        const extension = this.extractFileExtension(file.file_name);
        const language = this.mapExtensionToLanguage(extension);
        if (subtitle) subtitle.textContent = `${this.safeText(mimeType || 'text/plain')} · local`;
        body.innerHTML = `
            <div class="files-inline-preview-code-header">
                <span>${this.escapeHtml(extension ? `.${extension}` : 'text')}</span>
                <span>${this.escapeHtml(this.formatFileSize(file.size_bytes))}</span>
            </div>
            <pre class="files-inline-preview-code"><code class="language-${this.escapeHtml(language)}">${this.escapeHtml(textContent)}</code></pre>
        `;
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    hideInlinePreview() {
        this.activeInlinePreviewFileId = null;
        const panel = document.getElementById('files-inline-preview');
        if (panel) {
            panel.classList.add('hidden');
            panel.innerHTML = '';
        }
        if (this.inlinePreviewObjectUrl) {
            URL.revokeObjectURL(this.inlinePreviewObjectUrl);
            this.inlinePreviewObjectUrl = null;
        }
    }

    async downloadFile(file) {
        try {
            let blob = await this.getLocalBlob(file?.id);
            if (!blob) {
                const token = await this.getAccessToken();
                if (!token) {
                    this.notify('Login required to download files.', 'error');
                    return;
                }
                blob = await this.apiService.downloadUserFile(token, file.id);
                if (blob) {
                    await this.saveLocalFile(file, blob);
                    this.localFileIds.add(String(file?.id || ''));
                    this.markFileAsLocal(file?.id);
                }
            }
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = file.file_name || 'file.bin';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
        } catch (error) {
            this.notify(error.message || 'Failed to download file', 'error');
        }
    }

    async deleteFile(file) {
        if (!file?.id) return;
        if (!confirm(`Delete "${file.file_name || 'this file'}"?`)) return;

        try {
            const token = await this.getAccessToken();
            if (!token) {
                this.notify('Login required to delete files.', 'error');
                return;
            }
            await this.apiService.deleteUserFile(token, file.id);
            this.revokeThumbnail(file.id);
            await this.deleteLocalFile(file.id);
            this.localFileIds.delete(String(file.id || ''));
            this.notify('File deleted', 'success');
            await this.loadFiles(true);
        } catch (error) {
            this.notify(error.message || 'Failed to delete file', 'error');
        }
    }

    inferMimeType(file) {
        const browserType = String(file?.type || '').trim();
        if (browserType) return browserType;
        const inferred = inferContentTypeFromPath(file?.name || '');
        return inferred || 'application/octet-stream';
    }

    getMajorType(file) {
        const mimeType = String(file?.mime_type || '').toLowerCase();
        if (mimeType.includes('/')) return mimeType.split('/')[0] || 'file';
        return 'file';
    }

    extractFileExtension(fileName) {
        const name = String(fileName || '').toLowerCase();
        const parts = name.split('.');
        if (parts.length < 2) return '';
        return parts.pop() || '';
    }

    mapExtensionToLanguage(ext) {
        const key = String(ext || '').toLowerCase();
        const map = {
            js: 'javascript',
            mjs: 'javascript',
            jsx: 'javascript',
            ts: 'typescript',
            tsx: 'typescript',
            py: 'python',
            html: 'html',
            htm: 'html',
            css: 'css',
            json: 'json',
            md: 'markdown',
            txt: 'plaintext',
            yml: 'yaml',
            yaml: 'yaml',
            sh: 'bash',
            sql: 'sql',
            xml: 'xml',
            java: 'java',
            go: 'go',
            rs: 'rust',
            c: 'c',
            cpp: 'cpp',
            cs: 'csharp',
            php: 'php',
        };
        return map[key] || 'plaintext';
    }

    getFileIconClass(file) {
        const mime = String(file?.mime_type || '').toLowerCase();
        const fileName = String(file?.file_name || '').toLowerCase();
        if (mime.startsWith('image/')) return 'fas fa-image';
        if (mime.startsWith('video/')) return 'fas fa-file-video';
        if (mime.startsWith('audio/')) return 'fas fa-file-audio';
        if (mime === 'application/pdf' || fileName.endsWith('.pdf')) return 'fas fa-file-pdf';
        if (mime.includes('json') || fileName.match(/\.(js|jsx|ts|tsx|json|py|java|go|rs|html|css|md|txt)$/)) {
            return 'fas fa-file-code';
        }
        if (mime.includes('zip') || mime.includes('archive') || fileName.match(/\.(zip|rar|7z|tar|gz)$/)) {
            return 'fas fa-file-zipper';
        }
        return 'fas fa-file';
    }

    isImageFile(file) {
        return String(file?.mime_type || '').toLowerCase().startsWith('image/');
    }

    attachImagePreview(file, imageEl, fallbackEl) {
        if (!imageEl) return;
        const cachedUrl = this.thumbnailObjectUrls.get(String(file.id || ''));
        if (cachedUrl) {
            imageEl.src = cachedUrl;
            imageEl.classList.remove('hidden');
            fallbackEl?.classList.add('hidden');
            return;
        }

        imageEl.dataset.fileId = String(file.id || '');
        if (!this.previewObserver && typeof IntersectionObserver !== 'undefined') {
            this.previewObserver = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    const target = entry.target;
                    this.previewObserver?.unobserve(target);
                    const fileId = String(target?.dataset?.fileId || '');
                    const targetFile = this.filesCache.find((row) => String(row?.id || '') === fileId);
                    if (targetFile) this.loadImagePreview(targetFile, target);
                });
            }, { rootMargin: '140px 0px' });
        }

        if (this.previewObserver) {
            this.previewObserver.observe(imageEl);
        } else {
            this.loadImagePreview(file, imageEl);
        }
    }

    async loadImagePreview(file, imageEl) {
        try {
            const fileId = String(file?.id || '');
            if (!fileId) return;
            let objectUrl = this.thumbnailObjectUrls.get(fileId);
            if (!objectUrl) {
                if (!this.thumbnailPromises.has(fileId)) {
                    this.thumbnailPromises.set(fileId, this.fetchThumbnailObjectUrl(file));
                }
                objectUrl = await this.thumbnailPromises.get(fileId);
                this.thumbnailPromises.delete(fileId);
                if (objectUrl) this.thumbnailObjectUrls.set(fileId, objectUrl);
            }
            if (!objectUrl || !imageEl?.isConnected) return;
            const fallbackEl = imageEl.closest('.files-preview-media')?.querySelector('.files-preview-fallback');
            imageEl.src = objectUrl;
            imageEl.classList.remove('hidden');
            fallbackEl?.classList.add('hidden');
        } catch (_error) {
            // Keep icon fallback when preview loading fails.
        }
    }

    async fetchThumbnailObjectUrl(file) {
        const blob = await this.getLocalBlob(file.id);
        if (!blob) return null;
        return URL.createObjectURL(blob);
    }

    revokeThumbnail(fileId) {
        const key = String(fileId || '');
        if (!key) return;
        const objectUrl = this.thumbnailObjectUrls.get(key);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        this.thumbnailObjectUrls.delete(key);
        this.thumbnailPromises.delete(key);
        this.textPreviewSnippets.delete(key);
        this.textPreviewPromises.delete(key);
    }

    cleanupPreviewResources() {
        this.hideInlinePreview();
        if (this.previewObserver) {
            this.previewObserver.disconnect();
            this.previewObserver = null;
        }
        this.thumbnailObjectUrls.forEach((url) => URL.revokeObjectURL(url));
        this.thumbnailObjectUrls.clear();
        this.thumbnailPromises.clear();
        this.textPreviewSnippets.clear();
        this.textPreviewPromises.clear();
    }

    sortRowsByCreated(rows = []) {
        return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
            const ta = new Date(a?.created_at || 0).getTime();
            const tb = new Date(b?.created_at || 0).getTime();
            return tb - ta;
        });
    }

    markFileAsLocal(fileId) {
        const key = String(fileId || '');
        if (!key) return;
        this.filesCache = this.filesCache.map((row) =>
            String(row?.id || '') === key ? { ...row, local_available: true, local_cached_at: Date.now() } : row
        );
        this.filteredFiles = this.filteredFiles.map((row) =>
            String(row?.id || '') === key ? { ...row, local_available: true, local_cached_at: Date.now() } : row
        );
        this.applyFiltersAndRender(true);
    }

    startBackgroundLazyDownload(token, rows = []) {
        if (!token) return;
        const missing = (Array.isArray(rows) ? rows : []).filter((row) => !row?.local_available && row?.id);
        if (!missing.length) return;

        const existing = new Set(this.backgroundDownloadQueue.map((row) => String(row?.id || '')));
        missing.forEach((row) => {
            const key = String(row.id || '');
            if (!key) return;
            if (existing.has(key)) return;
            if (this.backgroundDownloadsInFlight.has(key)) return;
            this.backgroundDownloadQueue.push(row);
            existing.add(key);
        });

        this.processBackgroundDownloadQueue(token);
    }

    processBackgroundDownloadQueue(token) {
        if (!token) return;
        while (
            this.backgroundDownloadsInFlight.size < this.backgroundDownloadConcurrency &&
            this.backgroundDownloadQueue.length > 0
        ) {
            const row = this.backgroundDownloadQueue.shift();
            const fileId = String(row?.id || '');
            if (!fileId || this.backgroundDownloadsInFlight.has(fileId)) continue;

            this.backgroundDownloadsInFlight.add(fileId);
            this.apiService.downloadUserFile(token, fileId)
                .then(async (blob) => {
                    if (!blob) return;
                    await this.saveLocalFile(row, blob);
                    this.localFileIds.add(fileId);
                    this.markFileAsLocal(fileId);
                })
                .catch(() => {
                    // Best-effort background sync.
                })
                .finally(() => {
                    this.backgroundDownloadsInFlight.delete(fileId);
                    this.processBackgroundDownloadQueue(token);
                });
        }
    }

    isTextLikeMime(mimeType = '', fileName = '') {
        const mime = String(mimeType || '').toLowerCase();
        if (!mime) {
            const inferred = this.inferMimeType({ name: fileName, type: '' });
            return this.isTextLikeMime(inferred, fileName);
        }
        if (mime.startsWith('text/')) return true;
        if (mime.includes('json') || mime.includes('xml') || mime.includes('javascript') || mime.includes('markdown')) {
            return true;
        }
        const ext = this.extractFileExtension(fileName);
        return ['txt', 'md', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'json', 'xml', 'yml', 'yaml'].includes(ext);
    }

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || '');
                const commaIdx = result.indexOf(',');
                resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
            };
            reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
            reader.readAsDataURL(blob);
        });
    }

    base64ToBlob(base64, mimeType = 'application/octet-stream') {
        const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new Blob([bytes], { type: mimeType });
    }

    async openCacheLocation() {
        await this.ensureNativeFileVaultPlugin();
        if (this.nativeFileVaultAvailable && this.nativeFileVaultPlugin) {
            try {
                const result = await this.nativeFileVaultPlugin.openCacheFolder();
                const path = String(result?.path || '').trim();
                if (path) this.notify(`Cache folder: ${path}`, 'info');
                return;
            } catch (_error) {
                // Fallback below.
            }
        }
        if (typeof window.showDirectoryPicker === 'function') {
            try {
                await window.showDirectoryPicker();
                return;
            } catch (_error) {
                // user dismissed picker.
            }
        }
        this.notify('Files are cached in secure app storage on this device. Direct folder browsing is limited on this platform.', 'info');
    }

    readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || '');
                const commaIdx = result.indexOf(',');
                resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
            };
            reader.onerror = () => reject(new Error('Unable to read file'));
            reader.readAsDataURL(file);
        });
    }

    safeText(value, fallback = '-') {
        if (value === null || value === undefined) return fallback;
        const text = String(value).trim();
        return text.length ? this.escapeHtml(text) : fallback;
    }

    formatTags(tags) {
        if (!Array.isArray(tags) || !tags.length) return '';
        return tags.map((entry) => String(entry || '').trim()).filter(Boolean).join(', ');
    }

    formatFileSize(bytes) {
        const size = Number(bytes || 0);
        if (!Number.isFinite(size) || size <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
        const value = size / (1024 ** exponent);
        return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
    }

    formatDate(value) {
        if (!value) return '-';
        try {
            return new Date(value).toLocaleString();
        } catch (_error) {
            return this.safeText(value);
        }
    }

    escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Backward compatibility with older callers.
    loadDatabases(showNotification = false) {
        return this.loadFiles(showNotification);
    }
}


