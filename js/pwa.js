if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('/sw.js').then(registration => {
        // Updates apply on the next navigation. Let users keep unfinished work.
        registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            worker?.addEventListener('statechange', () => {
                if (worker.state !== 'installed' || !navigator.serviceWorker.controller || document.querySelector('.pwa-update-banner')) return;
                const banner = document.createElement('div');
                banner.className = 'pwa-update-banner';
                banner.setAttribute('role', 'status');
                banner.textContent = 'An update is ready. ';
                const reload = document.createElement('button');
                reload.type = 'button';
                reload.textContent = 'Reload';
                reload.addEventListener('click', () => window.location.reload());
                banner.appendChild(reload);
                document.body.appendChild(banner);
            });
        });
    }).catch(error => console.warn('[PWA] Registration failed:', error.message));
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
}

let deferredPrompt;
const banner = document.getElementById('install-prompt-banner');
window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    banner?.classList.add('show');
});
document.getElementById('install-prompt-install-btn')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    banner.classList.remove('show');
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
});
document.getElementById('install-prompt-dismiss-btn')?.addEventListener('click', () => banner.classList.remove('show'));
window.addEventListener('appinstalled', () => { banner?.classList.remove('show'); deferredPrompt = null; });
