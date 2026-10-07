export class AIOSUsageRenderer {
    constructor() {
        this.loadingEl = document.getElementById('usage-loading');
        this.emptyEl = document.getElementById('usage-empty');
        this.errorEl = document.getElementById('usage-error');
        this.cardsEl = document.getElementById('usage-cards');

        this.totalEl = document.getElementById('usage-total-tokens');
        this.inputEl = document.getElementById('usage-input-tokens');
        this.outputEl = document.getElementById('usage-output-tokens');
        this.updatedEl = document.getElementById('usage-last-updated');

        this.planSummaryEl = document.getElementById('usage-plan-summary');
        this.planNameEl = document.getElementById('usage-plan-name');
        this.planStatusEl = document.getElementById('usage-plan-status');
        this.planLimitEl = document.getElementById('usage-plan-limit');
        this.planPeriodEl = document.getElementById('usage-plan-period');
        this.planMeterFillEl = document.getElementById('usage-plan-meter-fill');
        this.planUsedEl = document.getElementById('usage-plan-used');
        this.planRemainingEl = document.getElementById('usage-plan-remaining');
        this.sourceNoteEl = document.getElementById('usage-source-note');
        this.managePlansBtn = document.getElementById('usage-manage-plans-btn');
    }

    setState(state) {
        this.loadingEl?.classList.add('hidden');
        this.emptyEl?.classList.add('hidden');
        this.errorEl?.classList.add('hidden');
        this.cardsEl?.classList.add('hidden');

        if (state === 'loading') this.loadingEl?.classList.remove('hidden');
        if (state === 'empty') this.emptyEl?.classList.remove('hidden');
        if (state === 'error') this.errorEl?.classList.remove('hidden');
        if (state === 'ready') this.cardsEl?.classList.remove('hidden');
    }

    setManagePlansEnabled(enabled) {
        if (this.managePlansBtn) {
            this.managePlansBtn.disabled = !enabled;
        }
    }

    renderLoggedOut() {
        this._renderValues(0, 0, 0, null);
        this._renderPlanSummary({
            plan_name: 'Core',
            status_label: 'Free',
            limit_label: '50,000 tokens/day',
            period_label: 'Current day',
            usage_percent: 0,
            usage: { total_tokens: 0 },
            remaining_tokens: 50000,
        });
        this._renderSourceNote({ usage_source: null, is_enforceable: true });
        this.setManagePlansEnabled(false);
        this.setState('empty');
    }

    renderError() {
        this._renderValues(0, 0, 0, null);
        this._renderSourceNote({ usage_source: null, is_enforceable: true });
        this.setState('error');
    }

    renderSummary(summary) {
        const usage = summary?.usage || {};
        const lifetimeUsage = summary?.lifetime_usage || {};

        this._renderValues(
            lifetimeUsage?.input_tokens ?? usage?.input_tokens ?? 0,
            lifetimeUsage?.output_tokens ?? usage?.output_tokens ?? 0,
            lifetimeUsage?.total_tokens ?? usage?.total_tokens ?? 0,
            lifetimeUsage?.created_at ?? usage?.created_at ?? null
        );
        this._renderPlanSummary(summary || {});
        this._renderSourceNote(summary || {});
        this.setManagePlansEnabled(true);
        this.setState('ready');
    }

    _renderValues(inputTokens, outputTokens, totalTokens, createdAt) {
        if (this.inputEl) this.inputEl.textContent = this._formatNumber(inputTokens);
        if (this.outputEl) this.outputEl.textContent = this._formatNumber(outputTokens);
        if (this.totalEl) this.totalEl.textContent = this._formatNumber(totalTokens);
        if (this.updatedEl) this.updatedEl.textContent = this._formatLastUpdated(createdAt);
    }

    _renderPlanSummary(summary) {
        if (!this.planSummaryEl) return;

        const usage = summary?.usage || {};
        const usagePercent = Number(summary?.usage_percent) || 0;
        const used = Number(usage?.total_tokens) || 0;
        const remaining = Number(summary?.remaining_tokens) || 0;

        if (this.planNameEl) this.planNameEl.textContent = summary?.plan_name || 'Core';
        if (this.planStatusEl) this.planStatusEl.textContent = summary?.status_label || 'Free';
        if (this.planLimitEl) this.planLimitEl.textContent = summary?.limit_label || '50,000 tokens/day';
        if (this.planPeriodEl) {
            this.planPeriodEl.textContent = summary?.period_label || 'Current day';
        }
        if (this.planMeterFillEl) {
            this.planMeterFillEl.style.width = `${Math.max(0, Math.min(usagePercent, 100))}%`;
        }
        if (this.planUsedEl) this.planUsedEl.textContent = `Used: ${this._formatNumber(used)}`;
        if (this.planRemainingEl) this.planRemainingEl.textContent = `Remaining: ${this._formatNumber(remaining)}`;
    }

    _renderSourceNote(summary) {
        if (!this.sourceNoteEl) return;
        const usageSource = String(summary?.usage_source || '').trim();
        const isEnforceable = summary?.is_enforceable !== false;
        if (isEnforceable) {
            this.sourceNoteEl.classList.add('hidden');
            this.sourceNoteEl.textContent = '';
            return;
        }

        const sourceText = usageSource || 'unknown_source';
        this.sourceNoteEl.textContent = `Usage source: ${sourceText}. Limits may be temporarily unenforceable.`;
        this.sourceNoteEl.classList.remove('hidden');
    }

    _formatNumber(value) {
        return new Intl.NumberFormat().format(Number(value) || 0);
    }

    _formatLastUpdated(createdAt) {
        if (!createdAt) return 'Last updated: -';
        const timestamp = typeof createdAt === 'number' ? createdAt : Date.parse(String(createdAt));
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return 'Last updated: -';
        return `Last updated: ${date.toLocaleString()}`;
    }
}
