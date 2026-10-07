import { authGate } from './auth-gate.js';
import { authService } from './auth-service.js';
import './pwa.js';

const app = document.querySelector('.app-container');
app.inert = true;
let starting = null;

async function startWorkspace() {
    if (starting) return starting;
    starting = (async () => {
        const startup = document.createElement('div');
        startup.className = 'workspace-startup';
        startup.setAttribute('role', 'status');
        startup.innerHTML = '<div class="auth-spinner" aria-hidden="true"></div><p>Loading your workspace...</p>';
        document.body.appendChild(startup);
        try {
            const { loadWorkspaceAssets } = await import('./workspace-assets.js');
            await loadWorkspaceAssets();
            const { initializeWorkspace } = await import('./app-workspace.js');
            await initializeWorkspace();
            app.inert = false;
            startup.remove();
        } catch (error) {
            console.error('[Workspace] Startup failed:', error);
            startup.replaceChildren();
            const message = document.createElement('p');
            message.textContent = error.message || 'Could not load your workspace.';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = 'Retry loading';
            retry.addEventListener('click', () => window.location.reload());
            startup.append(message, retry);
        }
    })();
    return starting;
}

window.addEventListener('auth-gate:authenticated', startWorkspace);
await authGate.init();
if (authService.isAuthenticated()) await startWorkspace();
