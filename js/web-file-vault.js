import { backendRequest } from './backend-api.js';
import { supabase } from './supabase-client.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const formatBytes = value => {
    const bytes = Math.max(0, Number(value) || 0);
    return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export class WebFileVault {
    constructor({ notify = () => {} } = {}) {
        this.notify = notify;
        this.rows = [];
        this.view = 'detailed';
        this.request = null;
        this.uploadController = null;
        this.previewRequest = null;
        this.previewUrl = null;
        this.bound = false;
        supabase.auth.onAuthStateChange(event => {
            if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') this.reset();
        });
    }

    bindEvents() {
        if (this.bound) return;
        this.bound = true;
        document.getElementById('refresh-files-btn')?.addEventListener('click', () => this.load());
        document.getElementById('files-search-input')?.addEventListener('input', () => this.render());
        document.getElementById('files-type-filter')?.addEventListener('change', () => this.render());
        document.getElementById('settings-upload-file-btn')?.addEventListener('click', () => {
            document.getElementById('settings-files-input')?.click();
        });
        document.getElementById('settings-files-input')?.addEventListener('change', async event => {
            await this.upload(Array.from(event.target.files || []));
            event.target.value = '';
        });
        document.querySelectorAll('[data-view-mode]').forEach(button => button.addEventListener('click', () => {
            this.view = button.dataset.viewMode;
            this.render();
        }));
        document.getElementById('files-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-vault-action]');
            const row = this.rows.find(item => item.id === button?.dataset.fileId);
            if (!row) return;
            const action = button.dataset.vaultAction;
            if (action === 'preview') this.preview(row).catch(error => this.notify(error.message, 'error'));
            if (action === 'download') this.download(row).catch(error => this.notify(error.message, 'error'));
            if (action === 'delete') this.remove(row).catch(error => this.notify(error.message, 'error'));
        });
    }

    reset() {
        this.request?.abort();
        this.uploadController?.abort();
        this.closePreview();
        this.rows = [];
        this.render();
        const storage = document.getElementById('files-storage-status');
        if (storage) storage.textContent = '';
    }

    status(message, error = false) {
        const target = document.getElementById('files-empty');
        if (!target) return;
        target.textContent = message;
        target.classList.toggle('hidden', !message);
        target.setAttribute('role', error ? 'alert' : 'status');
    }

    async load() {
        this.bindEvents();
        this.request?.abort();
        const controller = new AbortController();
        this.request = controller;
        this.status('Loading files...');
        try {
            const result = await backendRequest('/user-files?limit=500', { signal: controller.signal });
            if (!Array.isArray(result.files)) throw new Error('The server returned an invalid file list.');
            this.rows = result.files.filter(row => typeof row.id === 'string' && typeof row.file_name === 'string');
            const storage = result.storage || {};
            const target = document.getElementById('files-storage-status');
            if (target) target.textContent = `${formatBytes(storage.used_bytes)} of ${formatBytes(storage.quota_bytes || storage.limit_bytes || 500 * 1024 * 1024)} used`;
            this.render();
        } catch (error) {
            if (error.name === 'AbortError') return;
            this.rows = [];
            this.render();
            this.status(error.message, true);
        }
    }

    render() {
        const list = document.getElementById('files-list');
        if (!list) return;
        const search = document.getElementById('files-search-input')?.value.trim().toLowerCase() || '';
        const type = document.getElementById('files-type-filter')?.value || 'all';
        const rows = this.rows.filter(row => row.file_name.toLowerCase().includes(search)
            && (type === 'all' || String(row.mime_type).startsWith(`${type}/`)
                || type === 'document' && !/^(image|audio|video)\//.test(row.mime_type)));
        list.replaceChildren();
        list.classList.toggle('files-preview-view', this.view === 'preview');
        list.classList.toggle('files-detailed-view', this.view !== 'preview');
        document.querySelectorAll('[data-view-mode]').forEach(button => {
            button.classList.toggle('active', button.dataset.viewMode === this.view);
            button.setAttribute('aria-pressed', String(button.dataset.viewMode === this.view));
        });
        this.status(rows.length ? '' : this.rows.length ? 'No files match your filters.' : 'No files yet. Upload a file to use it in your chats.');
        for (const row of rows) {
            const card = document.createElement('article');
            card.className = 'web-vault-card';
            const name = document.createElement('h3');
            name.textContent = row.file_name;
            const meta = document.createElement('p');
            meta.textContent = `${formatBytes(row.size_bytes)} · ${row.mime_type || 'File'}`;
            const actions = document.createElement('div');
            actions.className = 'web-vault-actions';
            for (const [action, label] of [['preview', 'Preview'], ['download', 'Download'], ['delete', 'Delete']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = label;
                button.dataset.vaultAction = action;
                button.dataset.fileId = row.id;
                button.setAttribute('aria-label', `${label} ${row.file_name}`);
                actions.appendChild(button);
            }
            card.append(name, meta, actions);
            list.appendChild(card);
        }
    }

    async upload(files) {
        const controller = new AbortController();
        this.uploadController = controller;
        const button = document.getElementById('settings-upload-file-btn');
        if (button) button.disabled = true;
        let completed = 0;
        try {
            for (const file of files) {
                if (file.size > MAX_FILE_BYTES) {
                    this.notify(`${file.name} exceeds the 50 MB file limit.`, 'warning');
                    continue;
                }
                this.status(`Uploading ${file.name}...`);
                const body = new FormData();
                body.append('file', file);
                await backendRequest('/user-files/upload', { method: 'POST', body, signal: controller.signal });
                completed += 1;
            }
            if (completed) this.notify(`${completed} ${completed === 1 ? 'file uploaded' : 'files uploaded'}.`, 'success');
        } catch (error) {
            if (error.name !== 'AbortError') this.notify(error.message, 'error');
        } finally {
            if (button) button.disabled = false;
            await this.load();
        }
    }

    async download(row) {
        const blob = await backendRequest(`/user-files/${encodeURIComponent(row.id)}/download`, { binary: true });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = row.file_name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    async remove(row) {
        if (!window.confirm(`Delete "${row.file_name}" from your file vault?`)) return;
        await backendRequest(`/user-files/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        if (this.previewFileId === row.id) this.closePreview();
        await this.load();
    }

    closePreview() {
        this.previewRequest?.abort();
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.previewUrl = null;
        this.previewFileId = null;
        const panel = document.getElementById('files-inline-preview');
        panel?.replaceChildren();
        panel?.classList.add('hidden');
    }

    async preview(row) {
        this.closePreview();
        const panel = document.getElementById('files-inline-preview');
        if (!panel) return;
        const controller = new AbortController();
        this.previewRequest = controller;
        this.previewFileId = row.id;
        const heading = document.createElement('h3');
        heading.textContent = row.file_name;
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close preview';
        close.addEventListener('click', () => this.closePreview());
        const content = document.createElement('div');
        content.textContent = 'Loading preview...';
        panel.append(heading, close, content);
        panel.classList.remove('hidden');
        try {
            const mime = String(row.mime_type || '');
            if (/^(image|audio|video)\//.test(mime) && mime !== 'image/svg+xml') {
                const blob = await backendRequest(`/user-files/${encodeURIComponent(row.id)}/download`, { binary: true, signal: controller.signal });
                this.previewUrl = URL.createObjectURL(blob);
                const media = document.createElement(mime.startsWith('image/') ? 'img' : mime.split('/')[0]);
                media.src = this.previewUrl;
                if (media.tagName === 'IMG') media.alt = row.file_name;
                else media.controls = true;
                content.replaceChildren(media);
            } else {
                const result = await backendRequest(`/user-files/${encodeURIComponent(row.id)}/content?max_chars=40000`, { signal: controller.signal });
                const pre = document.createElement('pre');
                pre.textContent = result.file?.content || result.file?.text || 'Preview unavailable. Download this file to open it.';
                content.replaceChildren(pre);
            }
        } catch (error) {
            if (error.name !== 'AbortError') content.textContent = error.message;
        }
    }
}
