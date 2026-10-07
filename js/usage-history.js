import { backendRequest } from './backend-api.js';
import { supabase } from './supabase-client.js';

const number = value => Math.max(0, Number(value) || 0);

export function dailyUsageSeries(rows, days, now = new Date()) {
    const totals = new Map();
    for (const row of rows) {
        const key = String(row.day_key || row.day || '').replace(/^"|"$/g, '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        const input = number(row.input_tokens);
        const output = number(row.output_tokens);
        const previous = totals.get(key) || { input: 0, output: 0, total: 0 };
        totals.set(key, { input: previous.input + input, output: previous.output + output,
            total: previous.total + (number(row.total_tokens) || input + output) });
    }
    return Array.from({ length: days }, (_, index) => {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + index + 1));
        const day = date.toISOString().slice(0, 10);
        return { day, ...(totals.get(day) || { input: 0, output: 0, total: 0 }) };
    });
}

export class UsageHistory {
    constructor() {
        this.days = 7;
        this.controller = null;
    }

    init() {
        const panel = document.querySelector('#usage-panel .panel-content');
        if (!panel) return;
        this.root = document.createElement('section');
        this.root.className = 'web-usage-history';
        this.root.innerHTML = `
            <div class="web-usage-heading"><h3>Daily usage</h3>
                <label>Period <select aria-label="Usage history period"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
                <button type="button" data-refresh-usage>Refresh</button>
            </div>
            <p class="web-usage-status" role="status"></p>
            <div class="web-usage-chart" role="img" aria-label="Daily token usage"></div>
            <p class="web-usage-summary"></p>
            <details><summary>View daily numbers</summary><div class="web-usage-table-wrap"><table><caption>Token usage by UTC day</caption><thead><tr><th scope="col">Date</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Total</th></tr></thead><tbody></tbody></table></div></details>`;
        panel.appendChild(this.root);
        this.root.querySelector('select').addEventListener('change', event => {
            this.days = Number(event.target.value);
            this.load();
        });
        this.root.querySelector('[data-refresh-usage]').addEventListener('click', () => this.load());
        supabase.auth.onAuthStateChange(event => {
            if (event !== 'SIGNED_OUT' && event !== 'SIGNED_IN') return;
            this.controller?.abort();
            this.root.querySelector('.web-usage-chart').replaceChildren();
            this.root.querySelector('tbody').replaceChildren();
            this.root.querySelector('.web-usage-summary').textContent = '';
        });
    }

    async load() {
        if (!this.root) return;
        this.controller?.abort();
        this.controller = new AbortController();
        const status = this.root.querySelector('.web-usage-status');
        status.textContent = 'Loading daily usage...';
        try {
            const result = await backendRequest(`/usage/daily?limit=${this.days}`, { signal: this.controller.signal });
            if (!Array.isArray(result.rows)) throw new Error('Usage history is unavailable.');
            const series = dailyUsageSeries(result.rows, this.days);
            this.render(series);
            status.textContent = result.rows.length ? 'Daily totals use UTC.' : 'No usage recorded in this period.';
        } catch (error) {
            if (error.name !== 'AbortError') status.textContent = error.message;
        }
    }

    render(series) {
        const chart = this.root.querySelector('.web-usage-chart');
        const body = this.root.querySelector('tbody');
        chart.replaceChildren();
        body.replaceChildren();
        const peak = Math.max(1, ...series.map(day => day.total));
        let total = 0;
        for (const day of series) {
            total += day.total;
            const bar = document.createElement('span');
            bar.className = 'web-usage-bar';
            bar.style.setProperty('--usage-height', `${Math.max(1, day.total / peak * 100)}%`);
            bar.title = `${day.day}: ${day.total.toLocaleString()} tokens`;
            chart.appendChild(bar);
            const row = document.createElement('tr');
            for (const [index, value] of [day.day, day.input.toLocaleString(), day.output.toLocaleString(), day.total.toLocaleString()].entries()) {
                const cell = document.createElement(index ? 'td' : 'th');
                if (!index) cell.scope = 'row';
                cell.textContent = value;
                row.appendChild(cell);
            }
            body.appendChild(row);
        }
        const summary = `${total.toLocaleString()} tokens over ${series.length} days. Daily average ${Math.round(total / series.length).toLocaleString()}. Peak ${Math.max(0, ...series.map(day => day.total)).toLocaleString()}.`;
        chart.setAttribute('aria-label', summary);
        this.root.querySelector('.web-usage-summary').textContent = summary;
    }
}
