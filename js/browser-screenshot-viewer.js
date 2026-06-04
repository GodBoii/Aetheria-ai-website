// js/browser-screenshot-viewer.js
// ============================================================
// Self-contained module for displaying server-side browser
// screenshots to mobile users. Manages the floating "TV" button
// and the full-screen slider viewer.
// ============================================================

import { config } from './config.js';

/**
 * BrowserScreenshotViewer
 * 
 * Manages the lifecycle of browser screenshots received via Socket.IO:
 *   1. Stores screenshots per message ID
 *   2. Shows/updates a floating button with a count badge
 *   3. Opens a full-screen viewer with horizontal swipe/slider
 *   4. Handles cleanup on new conversations
 */
class BrowserScreenshotViewer {
    constructor() {
        /** @type {Map<string, Array<{url: string, action: string, page_url: string, timestamp: number}>>} */
        this.screenshots = new Map();

        /** Currently visible button's associated message ID */
        this.activeMessageId = null;

        /** Viewer DOM element (lazily created) */
        this._viewer = null;

        /** Button DOM element (lazily created) */
        this._button = null;

        /** Touch tracking for swipe gestures */
        this._touchStartX = 0;
        this._touchStartY = 0;
        this._isSwiping = false;
    }

    // ──────────────────────────────────────────────
    //  PUBLIC API (called from chat.js)
    // ──────────────────────────────────────────────

    /**
     * Handle an incoming browser_screenshot socket event.
     * @param {object} data - { screenshot_url, action, page_url, message_id, session_id, timestamp }
     */
    handleScreenshot(data = {}) {
        const { screenshot_url, action, page_url, message_id, session_id } = data;

        if (!screenshot_url || !message_id) {
            console.warn('[BrowserViewer] Invalid screenshot data:', data);
            return;
        }

        // Store the screenshot
        if (!this.screenshots.has(message_id)) {
            this.screenshots.set(message_id, []);
        }

        this.screenshots.get(message_id).push({
            url: screenshot_url,
            action: action || 'browser_action',
            page_url: page_url || '',
            timestamp: data.timestamp || Date.now()
        });

        console.log(`[BrowserViewer] Stored screenshot #${this.screenshots.get(message_id).length} for message ${message_id}`);

        // Show or update the floating button
        this._showButton(message_id);
    }

    /**
     * Clear all stored screenshots and hide the UI.
     * Called when starting a new conversation.
     */
    clear() {
        this.screenshots.clear();
        this.activeMessageId = null;
        this._hideButton();
        this._closeViewer();
    }

    // ──────────────────────────────────────────────
    //  FLOATING BUTTON
    // ──────────────────────────────────────────────

    /**
     * Show (or update) the floating TV button.
     * @param {string} messageId
     */
    _showButton(messageId) {
        const shots = this.screenshots.get(messageId);
        if (!shots || shots.length === 0) return;

        let btn = this._button;

        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'browser-view-btn';
            btn.className = 'browser-view-btn hidden'; // start hidden for animation
            btn.setAttribute('aria-label', 'View browser screenshots');
            btn.innerHTML = `
                <i class="fas fa-tv"></i>
                <span class="screenshot-count-badge">0</span>
            `;

            btn.addEventListener('click', () => {
                const mid = btn.dataset.messageId;
                if (mid) this._openViewer(mid);
            });

            document.body.appendChild(btn);
            this._button = btn;
        }

        // Update badge
        btn.dataset.messageId = messageId;
        this.activeMessageId = messageId;
        const badge = btn.querySelector('.screenshot-count-badge');
        if (badge) badge.textContent = shots.length;

        // Animate in (remove hidden class after a frame so the transition triggers)
        requestAnimationFrame(() => {
            btn.classList.remove('hidden');
        });
    }

    /** Hide the floating button. */
    _hideButton() {
        if (this._button) {
            this._button.classList.add('hidden');
        }
    }

    // ──────────────────────────────────────────────
    //  VIEWER (Full-screen slider overlay)
    // ──────────────────────────────────────────────

    /**
     * Build the Supabase public URL for a storage path.
     * The backend stores paths like `{user_id}/{session_id}/{uuid}.png`.
     * @param {string} storagePath
     * @returns {string}
     */
    _getImageUrl(storagePath) {
        // If the path is already a full URL, return as-is
        if (storagePath.startsWith('http://') || storagePath.startsWith('https://')) {
            return storagePath;
        }
        const baseUrl = config?.supabase?.url || 'https://gugmnnmjhqdtjwriaywa.supabase.co';
        return `${baseUrl}/storage/v1/object/public/media-uploads/${storagePath}`;
    }

    /**
     * Open the full-screen viewer for a given message's screenshots.
     * @param {string} messageId
     */
    _openViewer(messageId) {
        const shots = this.screenshots.get(messageId);
        if (!shots || shots.length === 0) {
            console.warn('[BrowserViewer] No screenshots for message:', messageId);
            return;
        }

        const viewer = this._ensureViewer();

        // Populate the slider
        const slider = viewer.querySelector('.screenshot-slider');
        slider.innerHTML = '';

        shots.forEach((shot, idx) => {
            const item = document.createElement('div');
            item.className = 'screenshot-item';
            item.dataset.index = idx;

            const img = document.createElement('img');
            img.src = this._getImageUrl(shot.url);
            img.alt = `${shot.action} screenshot`;
            img.loading = idx === 0 ? 'eager' : 'lazy';
            img.draggable = false;

            // Loading / error states
            img.addEventListener('error', () => {
                img.style.display = 'none';
                const fallback = item.querySelector('.screenshot-fallback');
                if (fallback) fallback.classList.remove('hidden');
            });

            const fallback = document.createElement('div');
            fallback.className = 'screenshot-fallback hidden';
            fallback.innerHTML = `
                <i class="fas fa-image"></i>
                <span>Failed to load screenshot</span>
            `;

            // Info box with inline navigation
            const infoWithNav = document.createElement('div');
            infoWithNav.className = 'screenshot-info-with-nav';

            // Previous button
            const prevBtn = document.createElement('button');
            prevBtn.className = 'nav-btn prev-btn';
            prevBtn.setAttribute('aria-label', 'Previous screenshot');
            prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
            prevBtn.addEventListener('click', () => this._navigate(-1));

            // Info content
            const info = document.createElement('div');
            info.className = 'screenshot-info';

            const actionLabel = document.createElement('span');
            actionLabel.className = 'screenshot-action';
            actionLabel.textContent = this._formatAction(shot.action);

            info.appendChild(actionLabel);

            if (shot.page_url) {
                const urlLabel = document.createElement('span');
                urlLabel.className = 'screenshot-url';
                urlLabel.textContent = this._truncateUrl(shot.page_url);
                urlLabel.title = shot.page_url;
                info.appendChild(urlLabel);
            }

            // Next button
            const nextBtn = document.createElement('button');
            nextBtn.className = 'nav-btn next-btn';
            nextBtn.setAttribute('aria-label', 'Next screenshot');
            nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
            nextBtn.addEventListener('click', () => this._navigate(1));

            // Assemble info with navigation
            infoWithNav.appendChild(prevBtn);
            infoWithNav.appendChild(info);
            infoWithNav.appendChild(nextBtn);

            item.appendChild(img);
            item.appendChild(fallback);
            item.appendChild(infoWithNav);
            slider.appendChild(item);
        });

        // Show viewer
        viewer.classList.remove('hidden');
        viewer.dataset.currentIndex = '0';
        viewer.dataset.messageId = messageId;

        this._updateIndicator(0, shots.length);

        // Scroll slider to start
        slider.scrollTo({ left: 0, behavior: 'instant' });

        // Bind keyboard
        this._keyHandler = (e) => this._handleKeyboard(e);
        document.addEventListener('keydown', this._keyHandler);
    }

    /** Close the viewer overlay. */
    _closeViewer() {
        const viewer = this._viewer;
        if (viewer) {
            viewer.classList.add('hidden');
        }
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
    }

    /**
     * Lazily create the viewer DOM structure.
     * @returns {HTMLElement}
     */
    _ensureViewer() {
        if (this._viewer) return this._viewer;

        const viewer = document.createElement('div');
        viewer.id = 'browser-screenshot-viewer';
        viewer.className = 'browser-screenshot-viewer hidden';

        viewer.innerHTML = `
            <div class="viewer-overlay"></div>
            <div class="viewer-container">
                <div class="viewer-header">
                    <div class="viewer-title">
                        <i class="fas fa-tv"></i>
                        <span>Aetheria Browser</span>
                    </div>
                    <button class="viewer-close-btn" aria-label="Close viewer">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="screenshot-slider-container">
                    <div class="screenshot-slider"></div>
                </div>
                <div class="slide-indicator-container">
                    <span class="slide-indicator">1 / 1</span>
                </div>
            </div>
        `;

        document.body.appendChild(viewer);
        this._viewer = viewer;

        // Event listeners
        viewer.querySelector('.viewer-close-btn').addEventListener('click', () => this._closeViewer());
        viewer.querySelector('.viewer-overlay').addEventListener('click', () => this._closeViewer());

        // Touch swipe on slider
        const sliderContainer = viewer.querySelector('.screenshot-slider-container');
        sliderContainer.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
        sliderContainer.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
        sliderContainer.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: true });

        return viewer;
    }

    // ──────────────────────────────────────────────
    //  NAVIGATION
    // ──────────────────────────────────────────────

    /**
     * Navigate to prev/next screenshot.
     * @param {number} direction  -1 for prev, +1 for next
     */
    _navigate(direction) {
        const viewer = this._viewer;
        if (!viewer) return;

        const slider = viewer.querySelector('.screenshot-slider');
        const items = slider.querySelectorAll('.screenshot-item');
        if (items.length === 0) return;

        const currentIdx = parseInt(viewer.dataset.currentIndex || '0', 10);
        const newIdx = Math.max(0, Math.min(items.length - 1, currentIdx + direction));

        if (newIdx !== currentIdx) {
            viewer.dataset.currentIndex = String(newIdx);
            items[newIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            this._updateIndicator(newIdx, items.length);
        }
    }

    /** Update the "1 / 3" indicator. */
    _updateIndicator(currentIdx, total) {
        const viewer = this._viewer;
        if (!viewer) return;
        const indicator = viewer.querySelector('.slide-indicator');
        if (indicator) {
            indicator.textContent = `${currentIdx + 1} / ${total}`;
        }
    }

    // ──────────────────────────────────────────────
    //  TOUCH / SWIPE
    // ──────────────────────────────────────────────

    _onTouchStart(e) {
        if (e.touches.length !== 1) return;
        this._touchStartX = e.touches[0].clientX;
        this._touchStartY = e.touches[0].clientY;
        this._isSwiping = false;
    }

    _onTouchMove(e) {
        if (e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - this._touchStartX;
        const dy = e.touches[0].clientY - this._touchStartY;

        // Determine if this is a horizontal swipe (vs vertical scroll)
        if (!this._isSwiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            this._isSwiping = true;
        }

        if (this._isSwiping) {
            e.preventDefault(); // prevent vertical scroll while swiping
        }
    }

    _onTouchEnd(e) {
        if (!this._isSwiping) return;
        const dx = e.changedTouches[0].clientX - this._touchStartX;
        const threshold = 50; // minimum swipe distance in px

        if (Math.abs(dx) >= threshold) {
            // Swipe left → next, swipe right → prev
            this._navigate(dx < 0 ? 1 : -1);
        }

        this._isSwiping = false;
    }

    // ──────────────────────────────────────────────
    //  KEYBOARD
    // ──────────────────────────────────────────────

    _handleKeyboard(e) {
        switch (e.key) {
            case 'Escape':
                this._closeViewer();
                break;
            case 'ArrowLeft':
                this._navigate(-1);
                break;
            case 'ArrowRight':
                this._navigate(1);
                break;
        }
    }

    // ──────────────────────────────────────────────
    //  HELPERS
    // ──────────────────────────────────────────────

    /**
     * Format a tool action name for display.
     * e.g. "navigate" → "Navigate", "get_current_view" → "Get Current View"
     */
    _formatAction(action) {
        if (!action) return 'Browser Action';
        return action
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    /**
     * Truncate a URL for display.
     * @param {string} url
     * @param {number} maxLen
     * @returns {string}
     */
    _truncateUrl(url, maxLen = 60) {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            const display = parsed.hostname + parsed.pathname;
            return display.length > maxLen ? display.substring(0, maxLen) + '…' : display;
        } catch {
            return url.length > maxLen ? url.substring(0, maxLen) + '…' : url;
        }
    }
}

// Singleton instance
const browserScreenshotViewer = new BrowserScreenshotViewer();

export default browserScreenshotViewer;
