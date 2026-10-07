import { config } from './config.js';

export function slugify(input) {
    const base = String(input || 'site')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
    const root = base || 'site';
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${root}-${suffix}`.slice(0, 50);
}

export function isHtmlContent(content) {
    const text = String(content || '').trim().toLowerCase();
    if (!text) return false;
    return (
        text.startsWith('<!doctype html') ||
        text.includes('<html') ||
        text.includes('<body') ||
        text.includes('<head')
    );
}

export function inferContentTypeFromPath(path) {
    const ext = String(path || '').toLowerCase().split('.').pop();
    const map = {
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'text/javascript',
        mjs: 'text/javascript',
        json: 'application/json',
        txt: 'text/plain',
        md: 'text/markdown',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
        eot: 'application/vnd.ms-fontobject',
        xml: 'application/xml',
        wasm: 'application/wasm'
    };
    return map[ext] || 'application/octet-stream';
}

export function normalizeDeployPath(rawPath, fallbackName = null) {
    let path = String(rawPath || fallbackName || '')
        .replace(/\\/g, '/')
        .trim();

    if (!path) return null;

    path = path.replace(/^\/home\/sandboxuser\//, '');
    path = path.replace(/^\/+/, '');
    path = path.replace(/^\.\/+/, '');

    if (!path || path.endsWith('/') || path.split('/').includes('..')) {
        return null;
    }
    return path;
}

export class DeployApiService {
    constructor(backendBaseUrl = config.backend.url) {
        this.backendBaseUrl = backendBaseUrl;
    }

    async request(path, { token, method = 'GET', body = null } = {}) {
        const response = await fetch(`${this.backendBaseUrl}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (_error) {
            payload = null;
        }

        if (!response.ok) {
            const reason = payload?.error || payload?.message || `HTTP ${response.status}`;
            throw new Error(reason);
        }
        return payload;
    }

    async requestBinary(path, { token, method = 'GET' } = {}) {
        const response = await fetch(`${this.backendBaseUrl}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            }
        });

        if (!response.ok) {
            let reason = `HTTP ${response.status}`;
            try {
                const payload = await response.json();
                reason = payload?.error || payload?.message || reason;
            } catch (_err) {
                try {
                    const text = await response.text();
                    if (text) reason = text;
                } catch (_ignored) {
                    // noop
                }
            }
            throw new Error(reason);
        }
        return response.blob();
    }

    async getSessionContent(sessionId, token) {
        const payload = await this.request(`/api/sessions/${sessionId}/content`, { token, method: 'GET' });
        return Array.isArray(payload?.content) ? payload.content : [];
    }

    async listDeployments(token, limit = 100) {
        const payload = await this.request(`/api/deploy/projects?limit=${limit}`, { token, method: 'GET' });
        return Array.isArray(payload?.projects) ? payload.projects : [];
    }

    async listDatabases(token, limit = 200) {
        const payload = await this.request(`/api/deploy/databases?limit=${limit}`, { token, method: 'GET' });
        return Array.isArray(payload?.databases) ? payload.databases : [];
    }

    async listUserFiles(token, { limit = 200, search = '', fileType = 'all' } = {}) {
        const params = new URLSearchParams({
            limit: String(limit || 200),
            search: String(search || ''),
            file_type: String(fileType || 'all')
        });
        const payload = await this.request(`/api/user-files?${params.toString()}`, { token, method: 'GET' });
        return Array.isArray(payload?.files) ? payload.files : [];
    }

    async uploadUserFile(token, { fileName, mimeType, contentBase64, sizeBytes = 0, tags = [] } = {}) {
        return this.request('/api/user-files/upload', {
            token,
            method: 'POST',
            body: {
                fileName,
                mimeType,
                contentBase64,
                sizeBytes,
                tags
            }
        });
    }

    async deleteUserFile(token, fileId) {
        return this.request(`/api/user-files/${encodeURIComponent(String(fileId || ''))}`, {
            token,
            method: 'DELETE'
        });
    }

    async downloadUserFile(token, fileId) {
        return this.requestBinary(`/api/user-files/${encodeURIComponent(String(fileId || ''))}/download`, {
            token,
            method: 'GET'
        });
    }

    async getUserFileContent(token, fileId, maxChars = 120000) {
        const params = new URLSearchParams({
            max_chars: String(maxChars || 120000)
        });
        return this.request(`/api/user-files/${encodeURIComponent(String(fileId || ''))}/content?${params.toString()}`, {
            token,
            method: 'GET'
        });
    }

    async listDeploymentFiles(token, siteId, deploymentId = null) {
        const params = new URLSearchParams({ site_id: String(siteId || '') });
        if (deploymentId) params.set('deployment_id', String(deploymentId));
        const payload = await this.request(`/api/deploy/files?${params.toString()}`, { token, method: 'GET' });
        return Array.isArray(payload?.files) ? payload.files : [];
    }

    async getDeploymentFileContent(token, siteId, path, deploymentId = null) {
        const params = new URLSearchParams({
            site_id: String(siteId || ''),
            path: String(path || '')
        });
        if (deploymentId) params.set('deployment_id', String(deploymentId));
        return this.request(`/api/deploy/file-content?${params.toString()}`, { token, method: 'GET' });
    }

    async listWorkspaceFiles(token, conversationId, path = '/home/sandboxuser/workspace') {
        return this.request('/api/project/workspace/tree', {
            token,
            method: 'POST',
            body: {
                conversation_id: conversationId,
                path
            }
        });
    }

    async getWorkspaceFileContent(token, conversationId, path) {
        return this.request('/api/project/workspace/file-content', {
            token,
            method: 'POST',
            body: {
                conversation_id: conversationId,
                path
            }
        });
    }
}
