const DOWNLOAD_REDIRECT_URL = 'https://aetheriaai.online/download';
const DISMISSED_KEY = 'aetheriaDesktopDownloadCardDismissed';

class DesktopDownloadCard {
  constructor() {
    this.root = null;
    this.boundKeyHandler = (event) => {
      if (event.key === 'Escape') {
        this.dismiss();
      }
    };
  }

  init() {
    window.addEventListener('auth-gate:authenticated', () => {
      window.setTimeout(() => this.show(), 680);
    });
  }

  show() {
    if (this.root || sessionStorage.getItem(DISMISSED_KEY) === 'true') {
      return;
    }

    this.root = document.createElement('div');
    this.root.className = 'desktop-download-card-root';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'desktop-download-card-title');
    this.root.innerHTML = `
      <div class="desktop-download-card-backdrop" data-dismiss-download-card></div>
      <article class="desktop-download-card" tabindex="-1">
        <button class="desktop-download-close" type="button" aria-label="Close download prompt" data-dismiss-download-card>
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
        <div class="desktop-download-media" aria-hidden="true">
          <img src="assets/aetheria-computer-use-card.png" alt="">
        </div>
        <div class="desktop-download-content">
          <div class="desktop-download-kicker">Desktop power unlocked</div>
          <h2 id="desktop-download-card-title">Use computer control in the desktop app</h2>
          <p>
            Computer use needs the native Aetheria desktop version so it can securely view and control your screen.
            Download it now to run desktop automation with the full workspace experience.
          </p>
          <a class="desktop-download-action" href="${DOWNLOAD_REDIRECT_URL}" target="_blank" rel="noopener noreferrer">
            <i class="fas fa-download" aria-hidden="true"></i>
            <span>Download Now</span>
          </a>
        </div>
      </article>
    `;

    document.body.appendChild(this.root);
    this.root.addEventListener('click', (event) => {
      if (event.target.closest('[data-dismiss-download-card]')) {
        this.dismiss();
      }
    });
    document.addEventListener('keydown', this.boundKeyHandler);

    requestAnimationFrame(() => {
      this.root?.classList.add('is-visible');
      this.root?.querySelector('.desktop-download-card')?.focus({ preventScroll: true });
    });
  }

  dismiss() {
    if (!this.root) return;

    sessionStorage.setItem(DISMISSED_KEY, 'true');
    document.removeEventListener('keydown', this.boundKeyHandler);
    this.root.classList.remove('is-visible');

    const rootToRemove = this.root;
    this.root = null;
    window.setTimeout(() => rootToRemove.remove(), 320);
  }
}

export const desktopDownloadCard = new DesktopDownloadCard();
