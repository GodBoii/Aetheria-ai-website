// js/message-actions.js
// Mobile-optimized message action buttons
import { pdfExportService } from './pdf-export-service.js';

/**
 * MessageActions - Handles action buttons below messages
 * Mobile-first with touch optimization and haptic feedback
 */
class MessageActions {
    constructor() {
        this.activeActions = new Map();
        this.observer = null;
        this.setupIntersectionObserver();
        this.bindEvents();
    }

    /**
     * Setup Intersection Observer to show actions when messages are in viewport
     */
    setupIntersectionObserver() {
        const options = {
            root: null,
            rootMargin: '0px',
            threshold: 0.1
        };

        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-viewport');
                } else {
                    entry.target.classList.remove('in-viewport');
                }
            });
        }, options);
    }

    /**
     * Add action buttons to a bot message (ONLY bot messages get actions)
     * @param {HTMLElement} messageElement - The bot message element
     * @param {string} messageId - Unique message identifier
     */
    addActionsToMessage(messageElement, messageId) {
        // Check if actions already exist
        if (messageElement.querySelector('.message-actions')) {
            return;
        }

        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'message-actions';
        actionsContainer.dataset.messageId = messageId;

        // Only Copy and Share for bot messages - minimalist icons
        const actions = [
            {
                id: 'copy',
                icon: 'fi fi-tr-copy',
                label: 'Copy',
                handler: () => this.handleCopy(messageId)
            },
            {
                id: 'share',
                icon: 'fi fi-tr-share-square',
                label: 'Share',
                handler: () => this.handleShare(messageId)
            }
        ];

        // Create action buttons
        actions.forEach(action => {
            const button = this.createActionButton(action);
            actionsContainer.appendChild(button);
        });

        // Append after message content
        messageElement.appendChild(actionsContainer);

        // Mark message as having actions
        messageElement.classList.add('has-actions');

        // Observe for viewport visibility
        this.observer.observe(messageElement);

        // Store reference
        this.activeActions.set(messageId, actionsContainer);
    }

    /**
     * Create an action button element
     */
    createActionButton(action) {
        const button = document.createElement('button');
        button.className = `action-btn ${action.id}-btn`;
        button.dataset.action = action.id;
        button.setAttribute('aria-label', action.label);
        
        button.innerHTML = `
            <i class="${action.icon}"></i>
            <span class="action-btn-text">${action.label}</span>
        `;

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.triggerHaptic('light');
            action.handler();
        });

        return button;
    }

    /**
     * Handle copy action
     */
    async handleCopy(messageId) {
        const messageElement = this.findMessageElement(messageId);
        if (!messageElement) return;

        // Get message text content
        const messageContent = messageElement.querySelector('.message-content') || messageElement;
        const textContent = messageContent.textContent.trim();

        try {
            // Try modern clipboard API first
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(textContent);
            } else {
                // Fallback for older browsers
                this.fallbackCopy(textContent);
            }

            // Success feedback
            this.showActionFeedback(messageId, 'copy', 'copied', 'Copied!');
            this.triggerHaptic('medium');
            
            // Show notification
            if (window.notificationService) {
                window.notificationService.show('Message copied', 'success', 2000);
            }
        } catch (err) {
            console.error('Failed to copy:', err);
            if (window.notificationService) {
                window.notificationService.show('Failed to copy', 'error', 2000);
            }
        }
    }

    /**
     * Fallback copy method for older browsers
     */
    fallbackCopy(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        try {
            document.execCommand('copy');
        } finally {
            document.body.removeChild(textArea);
        }
    }

    /**
     * Handle share action
     */
    async handleShare(messageId) {
        console.log('[MessageActions] Share tapped. Triggering full conversation PDF export.', {
            messageId,
            conversationId: window.chat?.getCurrentConversationId?.() || null,
            timestamp: new Date().toISOString(),
        });

        try {
            if (window.chat?.showNotification) {
                window.chat.showNotification('Preparing full conversation PDF...', 'info', 2200);
            }

            const result = await pdfExportService.exportEntireConversationPdf();
            console.log('[MessageActions] PDF export completed.', result);

            this.showActionFeedback(messageId, 'share', 'shared', 'Shared!');
            this.triggerHaptic('medium');

            if (window.chat?.showNotification) {
                if (result.action === 'shared' || result.action === 'saved-and-shared-native') {
                    window.chat.showNotification('Conversation PDF opened in share sheet.', 'success', 2800);
                } else if (result.action === 'saved' || result.action === 'saved-native') {
                    window.chat.showNotification(`Conversation PDF saved as ${result.filename}.`, 'success', 3200);
                } else {
                    window.chat.showNotification(
                        `PDF download triggered (${result.filename}). Check your Downloads / Files app.`,
                        'success',
                        4200
                    );
                }
            }
        } catch (err) {
            if (err?.name === 'AbortError') {
                console.log('[MessageActions] PDF share canceled by user.');
                return;
            }

            console.error('[MessageActions] PDF export failed.', err);
            if (window.chat?.showNotification) {
                window.chat.showNotification(
                    err?.message || 'Failed to share conversation PDF.',
                    'error',
                    4200
                );
            }
        }
    }



    /**
     * Show visual feedback for action
     */
    showActionFeedback(messageId, actionId, className, message) {
        const button = this.findActionButton(messageId, actionId);
        if (!button) return;

        // Add feedback class
        button.classList.add(className, 'success-feedback');

        // Change icon temporarily
        const icon = button.querySelector('i');
        const originalClass = icon.className;
        
        if (actionId === 'copy') {
            icon.className = 'fi fi-tr-check-circle';
        }

        // Remove after delay
        setTimeout(() => {
            button.classList.remove(className, 'success-feedback');
            icon.className = originalClass;
        }, 2000);
    }

    /**
     * Find message element by ID
     */
    findMessageElement(messageId) {
        return document.querySelector(`[data-message-id="${messageId}"]`) ||
               document.querySelector(`#${messageId}`);
    }

    /**
     * Find specific action button
     */
    findActionButton(messageId, actionId) {
        const actionsContainer = this.activeActions.get(messageId);
        if (!actionsContainer) return null;
        return actionsContainer.querySelector(`.${actionId}-btn`);
    }

    /**
     * Trigger haptic feedback (mobile only)
     */
    triggerHaptic(intensity = 'light') {
        if (!navigator.vibrate) return;

        const patterns = {
            light: 10,
            medium: 20,
            heavy: 30
        };

        navigator.vibrate(patterns[intensity] || 10);
    }

    /**
     * Bind global events
     */
    bindEvents() {
        // Clean up when messages are removed
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node.nodeType === 1 && node.dataset.messageId) {
                        this.activeActions.delete(node.dataset.messageId);
                    }
                });
            });
        });

        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            observer.observe(chatMessages, { childList: true, subtree: true });
        }
    }

    /**
     * Remove actions from a message
     */
    removeActions(messageId) {
        const actionsContainer = this.activeActions.get(messageId);
        if (actionsContainer) {
            actionsContainer.remove();
            this.activeActions.delete(messageId);
        }
    }

    /**
     * Update actions for a message
     */
    updateActions(messageId) {
        this.removeActions(messageId);
        const messageElement = this.findMessageElement(messageId);
        if (messageElement) {
            this.addActionsToMessage(messageElement, messageId);
        }
    }

    /**
     * Cleanup
     */
    destroy() {
        if (this.observer) {
            this.observer.disconnect();
        }
        this.activeActions.clear();
    }
}

// Create and export singleton instance
const messageActions = new MessageActions();

// Make it available globally
if (typeof window !== 'undefined') {
    window.messageActions = messageActions;
}

export default messageActions;
