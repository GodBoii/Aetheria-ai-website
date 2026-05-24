export class AssistantOverlay {
    constructor() {
        this.overlay = document.getElementById('assist-overlay');
        this.statusText = document.getElementById('assist-status-text');
        this.responseText = document.getElementById('assist-response-text');
        this.orb = document.querySelector('.assist-glow-orb');
        this.expandBtn = document.getElementById('assist-expand-btn');
        this.isVisible = false;

        this.bindEvents();
    }

    bindEvents() {
        // Listen for native event
        window.addEventListener('assistantTriggered', (e) => {
            console.log('[Assistant] Triggered via Native Event', e.detail);
            this.show(e.detail);
        });

        // Close on backdrop click
        if (this.overlay) {
            this.overlay.querySelector('.assist-backdrop').addEventListener('click', () => {
                this.hide();
            });
        }

        if (this.expandBtn) {
            this.expandBtn.addEventListener('click', () => {
                this.expand();
            });
        }
    }

    show(data) {
        if (this.isVisible) return;
        this.isVisible = true;

        // If triggered as overlay, handle body transparency
        if (data && (data.isOverlay || data.triggered)) {
            document.body.classList.add('assistant-overlay-active');
            const app = document.querySelector('.app-container');
            if (app) app.style.display = 'none';
        }

        this.overlay.classList.remove('hidden');

        this.statusText.textContent = "Listening...";
        this.responseText.textContent = "How can I help you?";

        // Trigger voice input if available
        if (window.voiceInputHandler) {
            setTimeout(() => {
                this.startListening();
            }, 300);
        }
    }

    expand() {
        // For now, just show the app container in this transparent window
        // In a real app, you might want to launch the main Activity
        this.isVisible = false;
        this.overlay.classList.add('hidden');
        document.body.classList.remove('assistant-overlay-active');
        const app = document.querySelector('.app-container');
        if (app) app.style.display = 'flex';
    }

    hide() {
        this.isVisible = false;
        this.overlay.classList.add('hidden');

        document.body.classList.remove('assistant-overlay-active');
        const app = document.querySelector('.app-container');
        if (app) app.style.display = 'flex';

        if (window.voiceInputHandler && window.voiceInputHandler.isListening) {
            window.voiceInputHandler.stopListening();
        }
    }

    startListening() {
        const voiceBtn = document.getElementById('voice-input-btn');
        if (voiceBtn && !voiceBtn.classList.contains('listening')) {
            voiceBtn.click();
        }
    }
}

// Auto-initialize
document.addEventListener('DOMContentLoaded', () => {
    window.assistantOverlay = new AssistantOverlay();
});
