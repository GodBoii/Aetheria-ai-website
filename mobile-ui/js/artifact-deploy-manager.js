import { supabase } from './supabase-client.js';
import {
    DeployApiService,
    inferContentTypeFromPath,
    isHtmlContent,
    normalizeDeployPath,
    slugify
} from './deploy-api-service.js';

export class ArtifactDeployManager {
    constructor({
        apiService = new DeployApiService(),
        notify = () => {},
        getConversationId = () => null,
        openExternal = (url) => window.open(url, '_blank', 'noopener,noreferrer')
    } = {}) {
        this.apiService = apiService;
        this.notify = notify;
        this.getConversationId = getConversationId;
        this.openExternal = openExternal;
        this.deployInProgress = false;
    }

    async deployCurrentArtifact(artifact) {
        if (this.deployInProgress) {
            this.notify('Deploy already in progress', 'info');
            return null;
        }
        if (!artifact) {
            this.notify('No active artifact selected', 'error');
            return null;
        }

        const language = String(artifact.language || artifact.type || '').toLowerCase();
        const html = String(artifact.content || '');
        if (!(language === 'html' || isHtmlContent(html))) {
            this.notify('Open the website entry HTML file (index.html) before deploying', 'error');
            return null;
        }

        const session = await supabase.auth.getSession();
        const accessToken = session?.data?.session?.access_token;
        if (!accessToken) {
            this.notify('Please sign in before deploying', 'error');
            return null;
        }

        const siteId = (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : `site-${Date.now()}`;
        const slug = slugify(artifact.title || artifact.filename || 'generated-site');

        this.deployInProgress = true;
        this.notify('Deploy started...', 'info');

        try {
            const sessionFiles = await this.collectSessionDeployFiles(accessToken);
            const draft = this.buildDeploymentDraft(sessionFiles, html);
            if (!draft.files.length) {
                throw new Error('No deployable files found in this session');
            }

            const editedFiles = await this.confirmDeployPreview({
                files: draft.files,
                rootPrefix: draft.rootPrefix,
                candidateCount: draft.candidateCount
            });
            if (!editedFiles) {
                this.notify('Deploy canceled', 'info');
                return null;
            }

            const hasIndexHtml = editedFiles.some((file) => String(file.path || '').toLowerCase() === 'index.html');
            if (!hasIndexHtml) {
                throw new Error('Deployment must include index.html');
            }

            const uploadPayload = await this.materializeDeployFiles(editedFiles);
            if (!uploadPayload.length) {
                throw new Error('No files were selected for deployment');
            }

            await this.apiService.request('/api/deploy/site/init', {
                token: accessToken,
                method: 'POST',
                body: {
                    site_id: siteId,
                    project_name: artifact.title || artifact.filename || 'Generated Site',
                    slug
                }
            });
            await this.apiService.request('/api/deploy/assign-subdomain', {
                token: accessToken,
                method: 'POST',
                body: { site_id: siteId }
            });
            const upload = await this.apiService.request('/api/deploy/upload-site', {
                token: accessToken,
                method: 'POST',
                body: {
                    site_id: siteId,
                    files: uploadPayload
                }
            });
            const activated = await this.apiService.request('/api/deploy/activate', {
                token: accessToken,
                method: 'POST',
                body: {
                    site_id: siteId,
                    deployment_id: upload?.deployment_id
                }
            });

            const liveUrl = activated?.url || '';
            if (!liveUrl) {
                throw new Error('Deployment activated but URL was not returned');
            }

            this.notify(`Deployed: ${liveUrl}`, 'success');
            this.openExternal(liveUrl);
            return liveUrl;
        } catch (error) {
            this.notify(`Deploy failed: ${error.message}`, 'error');
            return null;
        } finally {
            this.deployInProgress = false;
        }
    }

    async collectSessionDeployFiles(accessToken) {
        const sessionId = this.getConversationId();
        if (!sessionId) return [];

        const content = await this.apiService.getSessionContent(sessionId, accessToken);
        const artifacts = content.filter((item) => item?.content_type === 'artifact');
        if (!artifacts.length) return [];

        const latestByPath = new Map();
        for (const item of artifacts) {
            const metadata = item?.metadata || {};
            const path = normalizeDeployPath(metadata.file_path || metadata.path, metadata.filename);
            if (!path || !item?.download_url) continue;
            latestByPath.set(path, item);
        }

        const files = [];
        for (const [path, item] of latestByPath.entries()) {
            const metadata = item?.metadata || {};
            files.push({
                path,
                content_type: metadata.mime_type || inferContentTypeFromPath(path),
                download_url: item.download_url
            });
        }
        return files;
    }

    buildDeploymentDraft(files, htmlFallback) {
        const groups = new Map();
        const assetRefs = this.parseLocalAssetRefs(htmlFallback);

        for (const file of files) {
            const fullPath = String(file.path || '');
            const root = fullPath.includes('/') ? fullPath.split('/')[0] : '';
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(file);
        }

        const scoreGroup = (root, items) => {
            const rebased = items.map((file) => {
                const fullPath = String(file.path || '');
                const path = root && fullPath.startsWith(`${root}/`) ? fullPath.slice(root.length + 1) : fullPath;
                return { ...file, path, _root: root };
            });

            const pathSet = new Set(rebased.map((f) => String(f.path || '').toLowerCase()));
            const hasIndex = pathSet.has('index.html');
            let matchedRefs = 0;
            for (const ref of assetRefs) {
                if (pathSet.has(String(ref).toLowerCase())) matchedRefs += 1;
            }
            const score = (hasIndex ? 100 : 0) + (matchedRefs * 25) + Math.min(rebased.length, 30);
            return { root, rebased, score, hasIndex };
        };

        const candidates = Array.from(groups.entries()).map(([root, items]) => scoreGroup(root, items));
        candidates.sort((a, b) => b.score - a.score);
        const selected = candidates[0] || { root: '', rebased: [], hasIndex: false };

        const draftFiles = [...selected.rebased];
        if (!selected.hasIndex) {
            draftFiles.push({
                path: 'index.html',
                content: String(htmlFallback || ''),
                content_type: 'text/html',
                _root: 'fallback'
            });
        }

        return {
            rootPrefix: selected.root || null,
            candidateCount: candidates.length || 1,
            files: draftFiles
        };
    }

    parseLocalAssetRefs(html) {
        const text = String(html || '');
        const refs = new Set();
        const patterns = [
            /<link[^>]+href=["']([^"']+)["']/gi,
            /<script[^>]+src=["']([^"']+)["']/gi,
            /<img[^>]+src=["']([^"']+)["']/gi
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const raw = String(match[1] || '').trim();
                if (!raw) continue;
                if (
                    raw.startsWith('http://') ||
                    raw.startsWith('https://') ||
                    raw.startsWith('//') ||
                    raw.startsWith('data:') ||
                    raw.startsWith('#')
                ) {
                    continue;
                }
                refs.add(raw.replace(/^\.\/+/, ''));
            }
        }
        return refs;
    }

    async materializeDeployFiles(files) {
        const deployFiles = [];
        for (const file of files) {
            if (file.content !== undefined) {
                deployFiles.push({
                    path: file.path,
                    content: file.content,
                    content_type: file.content_type || inferContentTypeFromPath(file.path)
                });
                continue;
            }
            if (!file.download_url) continue;

            const response = await fetch(file.download_url);
            if (!response.ok) {
                throw new Error(`Failed to fetch '${file.path}' (HTTP ${response.status})`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const contentBase64 = await this.arrayBufferToBase64(arrayBuffer);
            deployFiles.push({
                path: file.path,
                content_base64: contentBase64,
                content_type: file.content_type || inferContentTypeFromPath(file.path)
            });
        }
        return deployFiles;
    }

    async arrayBufferToBase64(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
    }

    async confirmDeployPreview({ files, rootPrefix, candidateCount }) {
        const modal = this.ensureDeployPreviewModal();
        const metaEl = modal.querySelector('.deploy-preview-meta');
        const treeEl = modal.querySelector('.deploy-preview-tree');
        const confirmBtn = modal.querySelector('.deploy-preview-confirm');
        const cancelBtn = modal.querySelector('.deploy-preview-cancel');
        const closeBtn = modal.querySelector('.deploy-preview-close');

        const fileCount = files.length;
        const rootInfo = rootPrefix
            ? `Selected project root: ${this.escapeHtml(rootPrefix)}`
            : 'Deploying from current root paths';
        const candidateInfo = candidateCount > 1
            ? `Detected ${candidateCount} project-root candidates; best match selected automatically.`
            : 'Single project-root candidate detected.';

        metaEl.innerHTML = `
            <div><strong>${fileCount}</strong> file${fileCount === 1 ? '' : 's'} will be deployed.</div>
            <div>${rootInfo}</div>
            <div>${candidateInfo}</div>
        `;

        treeEl.innerHTML = `
            <div class="deploy-editor-list">
                ${files.map((file, index) => `
                    <div class="deploy-editor-row" data-row-index="${index}">
                        <input class="deploy-editor-include" type="checkbox" checked />
                        <input class="deploy-editor-path" type="text" value="${this.escapeHtml(file.path)}" />
                        <span class="deploy-editor-type">${this.escapeHtml(file.content_type || inferContentTypeFromPath(file.path))}</span>
                    </div>
                `).join('')}
            </div>
            <div class="deploy-editor-tree"></div>
        `;

        const rebuildTree = () => {
            const rows = Array.from(treeEl.querySelectorAll('.deploy-editor-row'));
            const selectedPaths = rows
                .filter((row) => row.querySelector('.deploy-editor-include')?.checked)
                .map((row) => (row.querySelector('.deploy-editor-path')?.value || '').trim())
                .filter(Boolean);
            const treeContainer = treeEl.querySelector('.deploy-editor-tree');
            if (treeContainer) {
                treeContainer.innerHTML = this.buildFileTreeMarkup(selectedPaths);
            }
        };

        treeEl.querySelectorAll('.deploy-editor-include, .deploy-editor-path').forEach((el) => {
            el.addEventListener('change', rebuildTree);
            el.addEventListener('input', rebuildTree);
        });
        rebuildTree();
        modal.classList.remove('hidden');

        return new Promise((resolve) => {
            const cleanup = () => {
                modal.classList.add('hidden');
                confirmBtn.removeEventListener('click', onConfirm);
                cancelBtn.removeEventListener('click', onCancel);
                closeBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onBackdrop);
            };

            const onConfirm = () => {
                const rows = Array.from(treeEl.querySelectorAll('.deploy-editor-row'));
                const selected = rows
                    .filter((row) => row.querySelector('.deploy-editor-include')?.checked)
                    .map((row) => {
                        const index = Number(row.dataset.rowIndex);
                        const editedPath = normalizeDeployPath(row.querySelector('.deploy-editor-path')?.value || '');
                        if (!editedPath) return null;
                        return { ...files[index], path: editedPath };
                    })
                    .filter(Boolean);
                cleanup();
                resolve(selected);
            };

            const onCancel = () => {
                cleanup();
                resolve(null);
            };

            const onBackdrop = (event) => {
                if (event.target === modal) onCancel();
            };

            confirmBtn.addEventListener('click', onConfirm);
            cancelBtn.addEventListener('click', onCancel);
            closeBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onBackdrop);
        });
    }

    ensureDeployPreviewModal() {
        const existing = document.getElementById('deploy-preview-modal');
        if (existing) return existing;

        const modal = document.createElement('div');
        modal.id = 'deploy-preview-modal';
        modal.className = 'deploy-preview-modal hidden';
        modal.innerHTML = `
            <div class="deploy-preview-dialog" role="dialog" aria-modal="true" aria-label="Deploy Preview">
                <div class="deploy-preview-header">
                    <div class="deploy-preview-header-content">
                        <i class="fas fa-rocket deploy-preview-icon"></i>
                        <div class="deploy-preview-title-group">
                            <div class="deploy-preview-title">Deployment Preview</div>
                            <div class="deploy-preview-subtitle">Review files before deploying to production</div>
                        </div>
                    </div>
                    <button type="button" class="deploy-preview-close" aria-label="Close">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="deploy-preview-meta"></div>
                <div class="deploy-preview-tree"></div>
                <div class="deploy-preview-actions">
                    <button type="button" class="deploy-preview-cancel">
                        <i class="fas fa-times-circle"></i>
                        <span>Cancel</span>
                    </button>
                    <button type="button" class="deploy-preview-confirm">
                        <i class="fas fa-rocket"></i>
                        <span>Deploy Now</span>
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    buildFileTreeMarkup(paths) {
        const root = {};
        for (const rawPath of paths) {
            const path = String(rawPath || '').trim();
            if (!path) continue;
            const parts = path.split('/');
            let node = root;
            for (let i = 0; i < parts.length; i += 1) {
                const part = parts[i];
                if (!part) continue;
                if (!node[part]) {
                    node[part] = { __children: {}, __file: i === parts.length - 1 };
                } else if (i === parts.length - 1) {
                    node[part].__file = true;
                }
                node = node[part].__children;
            }
        }

        const renderNode = (obj) => {
            const keys = Object.keys(obj).sort((a, b) => {
                const aFile = obj[a].__file;
                const bFile = obj[b].__file;
                if (aFile !== bFile) return aFile ? 1 : -1;
                return a.localeCompare(b);
            });

            return `<ul class="deploy-tree-list">${keys.map((key) => {
                const entry = obj[key];
                const safeName = this.escapeHtml(key);
                if (entry.__file) {
                    return `<li class="deploy-tree-file"><i class="fas fa-file-code"></i><span>${safeName}</span></li>`;
                }
                return `<li class="deploy-tree-dir"><i class="fas fa-folder"></i><span>${safeName}</span>${renderNode(entry.__children)}</li>`;
            }).join('')}</ul>`;
        };

        return renderNode(root);
    }

    escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
