import { supabase } from './supabase-client.js';
import { DeployApiService } from './deploy-api-service.js';
import { WebFileVault } from './web-file-vault.js';

export class DeploySettingsManager {
    constructor({ apiService = new DeployApiService(), notify = () => {} } = {}) {
        this.apiService = apiService;
        this.notify = notify;
        this.vault = new WebFileVault({ notify });
        this.deploymentsCache = [];
        this.bound = false;
    }

    bindEvents() {
        if (this.bound) return;
        this.bound = true;
        document.getElementById('refresh-deployments-btn')?.addEventListener('click', () => this.loadDeployments(true));
        this.vault.bindEvents();
    }

    async loadDeployments(showNotification = false) {
        this.bindEvents();
        const empty = document.getElementById('deployments-empty');
        if (empty) { empty.textContent = 'Loading deployments...'; empty.classList.remove('hidden'); }
        try {
            const { data, error } = await supabase.auth.getSession();
            if (error || !data?.session?.access_token) throw new Error('Sign in to view deployments.');
            this.deploymentsCache = await this.apiService.listDeployments(data.session.access_token, 100);
            this.renderDeployments(this.deploymentsCache);
            if (showNotification) this.notify('Deployments refreshed', 'success');
        } catch (error) {
            this.renderDeployments([]);
            if (empty) { empty.textContent = error.message; empty.setAttribute('role', 'alert'); }
        }
    }

    loadFiles() { return this.vault.load(); }
    loadDatabases() { return this.loadFiles(); }
    reset() {
        this.deploymentsCache = [];
        this.renderDeployments([]);
        this.vault.reset();
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

}
