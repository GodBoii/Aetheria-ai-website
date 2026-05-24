export class OfflineModelManager {
    constructor(notificationService) {
        this.notify = notificationService ? (msg, type) => notificationService.show(msg, type) : (msg, type) => console.log(type, msg);
        this.elements = {
            statusBadge: document.getElementById('offline-status-badge'),
            progressContainer: document.getElementById('offline-progress-container'),
            progressFill: document.getElementById('offline-progress-fill'),
            progressText: document.getElementById('offline-progress-text'),
            downloadBtn: document.getElementById('download-model-btn'),
            deleteBtn: document.getElementById('delete-model-btn'),
            inferenceWidget: document.getElementById('offline-inference-widget'),
            inputText: document.getElementById('offline-input-text'),
            sendBtn: document.getElementById('offline-send-btn'),
            chatOutput: document.getElementById('offline-chat-output')
        };

        this.isDownloading = false;
        this.isDownloaded = false;

        this.init();
    }

    async init() {
        this.OfflineModel = null;
        this.updateUIStoreUnavail("Offline model downloads are not available in the web app.");
    }

    bindEvents() {
        if (this.elements.downloadBtn) {
            this.elements.downloadBtn.addEventListener('click', () => this.downloadModel());
        }
        if (this.elements.deleteBtn) {
            this.elements.deleteBtn.addEventListener('click', () => this.deleteModel());
        }
        if (this.elements.sendBtn) {
            this.elements.sendBtn.addEventListener('click', () => this.processInput());
        }
        if (this.elements.inputText) {
            this.elements.inputText.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.processInput();
            });
        }
    }

    async refreshStatus() {
        if (!this.OfflineModel) return;
        try {
            const status = await this.OfflineModel.getStatus();
            this.updateUIWithStatus(status);
        } catch (err) {
            console.error("Failed to get model status:", err);
        }
    }

    async downloadModel() {
        if (!this.OfflineModel) return;

        const modelUrl = 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf';
        const mmprojUrl = 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf';

        try {
            this.isDownloading = true;
            this.updateUIForDownloading();

            this.notify("Downloading Aetheria model...", "info");
            await this.OfflineModel.downloadModel({
                url: modelUrl,
                fileName: 'qwen3.5-0.8b.gguf',
                role: 'model'
            });

            this.notify("Downloading Aetheria vision...", "info");
            this.updateUIForDownloading();
            await this.OfflineModel.downloadModel({
                url: mmprojUrl,
                fileName: 'qwen3.5-0.8b-mmproj.gguf',
                role: 'vision'
            });

            this.notify("Aetheria model and Aetheria vision downloaded successfully.", "success");
        } catch (err) {
            this.isDownloading = false;
            this.notify(err.message || "Failed to start download.", "error");
            this.refreshStatus();
        }
    }

    async deleteModel() {
        if (!this.OfflineModel) return;

        if (!confirm("Are you sure you want to delete the offline model?")) return;

        try {
            await this.OfflineModel.deleteModel({});
            this.notify("Model deleted.", "info");
            this.elements.chatOutput.innerHTML = "<em>Output will appear here...</em>";
            await this.refreshStatus();
        } catch (err) {
            this.notify("Failed to delete model: " + err.message, "error");
        }
    }

    async processInput() {
        const text = this.elements.inputText.value.trim();
        if (!text) return;

        if (!this.isDownloaded) {
            this.notify("Please download the Aetheria model first.", "warning");
            return;
        }

        this.appendMessage('User', text);
        this.elements.inputText.value = '';
        this.elements.sendBtn.disabled = true;

        if (!this.OfflineModel) {
            this.appendMessage('System', 'OfflineModel Plugin not available.');
            this.elements.sendBtn.disabled = false;
            return;
        }

        try {
            this.appendMessage('System', 'Loading model & generating response... (first load takes ~10s)', true);
            const res = await this.OfflineModel.generateText({ prompt: text });

            // Remove the loading message
            this.elements.chatOutput.lastElementChild?.remove();

            this.appendMessage('Aetheria model', res.response);
        } catch (err) {
            this.elements.chatOutput.lastElementChild?.remove();
            this.appendMessage('Error', err.message || JSON.stringify(err));
        } finally {
            this.elements.sendBtn.disabled = false;
        }
    }

    appendMessage(sender, text, isTemp = false) {
        if (!this.elements.chatOutput) return;

        if (this.elements.chatOutput.innerHTML.includes("<em>Output will appear here...</em>")) {
            this.elements.chatOutput.innerHTML = '';
        }

        const msgDiv = document.createElement('div');
        msgDiv.style.marginBottom = '8px';
        msgDiv.innerHTML = `<strong>${sender}:</strong> <span>` + text.replace(/\\n/g, '<br>') + `</span>`;
        if (isTemp) msgDiv.style.opacity = '0.7';

        this.elements.chatOutput.appendChild(msgDiv);
        this.elements.chatOutput.scrollTop = this.elements.chatOutput.scrollHeight;
    }

    updateUIStoreUnavail(reason) {
        if (!this.elements.downloadBtn) return;
        this.elements.downloadBtn.disabled = true;
        this.elements.statusBadge.textContent = "Unavailable";
        this.elements.statusBadge.style.backgroundColor = "var(--error-secondary)";
        this.elements.statusBadge.style.color = "var(--error-primary)";
        this.appendMessage('System', reason);
    }

    updateUIWithStatus(status) {
        if (!this.elements.downloadBtn) return;

        this.isDownloading = status.isDownloading;
        this.isDownloaded = status.isDownloaded;
        const visionReady = !!status.visionReady;

        if (this.isDownloading) {
            this.updateUIForDownloading(status.progress || 0);
        } else if (this.isDownloaded) {
            this.elements.downloadBtn.classList.add('hidden');
            this.elements.deleteBtn.classList.remove('hidden');
            this.elements.progressContainer.classList.add('hidden');
            this.elements.inferenceWidget.classList.remove('hidden');

            if (visionReady) {
                this.elements.statusBadge.textContent = "Ready (Aetheria model + vision)";
                this.elements.statusBadge.style.backgroundColor = "var(--success-secondary)";
                this.elements.statusBadge.style.color = "var(--success-primary)";
            } else {
                this.elements.statusBadge.textContent = "Ready (Aetheria model)";
                this.elements.statusBadge.style.backgroundColor = "var(--accent-secondary)";
                this.elements.statusBadge.style.color = "var(--accent-primary)";
            }
        } else {
            this.elements.downloadBtn.classList.remove('hidden');
            this.elements.downloadBtn.disabled = false;
            this.elements.deleteBtn.classList.add('hidden');
            this.elements.progressContainer.classList.add('hidden');
            this.elements.inferenceWidget.classList.add('hidden');

            this.elements.statusBadge.textContent = "Not Downloaded";
            this.elements.statusBadge.style.backgroundColor = "var(--bg-elevated)";
            this.elements.statusBadge.style.color = "var(--text-secondary)";
        }
    }

    updateUIForDownloading(progress = 0) {
        this.elements.downloadBtn.disabled = true;
        this.elements.downloadBtn.classList.remove('hidden');
        this.elements.deleteBtn.classList.add('hidden');
        this.elements.inferenceWidget.classList.add('hidden');

        this.elements.progressContainer.classList.remove('hidden');
        const percentage = Math.round(progress * 100);
        this.elements.progressFill.style.width = percentage + '%';
        this.elements.progressText.textContent = `Downloading... ${percentage}%`;

        this.elements.statusBadge.textContent = "Downloading";
        this.elements.statusBadge.style.backgroundColor = "var(--accent-secondary)";
        this.elements.statusBadge.style.color = "var(--accent-primary)";
    }
}
