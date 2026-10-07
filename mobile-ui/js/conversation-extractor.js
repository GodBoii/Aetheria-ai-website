class ConversationExtractor {
    async extractConversation() {
        const messagesContainer = document.getElementById('chat-messages');
        if (!messagesContainer) {
            throw new Error('Chat messages container not found.');
        }

        const turns = this.extractTurns(messagesContainer);
        if (turns.length === 0) {
            throw new Error('No conversation messages are available to export.');
        }

        const title = this.resolveConversationTitle(turns, messagesContainer);
        const sessionContent = this.extractSessionContent(messagesContainer);
        console.log('[ConversationExtractor] Extracted conversation snapshot.', {
            conversationId: window.chat?.getCurrentConversationId?.() || window.currentConversationId || null,
            title,
            turnCount: turns.length,
            sessionFileCount: sessionContent.files.length,
            sessionExecutionCount: sessionContent.executions.length,
        });

        return {
            conversationId: window.chat?.getCurrentConversationId?.() || window.currentConversationId || null,
            title,
            exportedAt: new Date().toISOString(),
            turns,
            sessionContent,
        };
    }

    extractTurns(messagesContainer) {
        const turns = [];
        const messageNodes = Array.from(messagesContainer.querySelectorAll('.message'));

        messageNodes.forEach((messageNode, index) => {
            if (!(messageNode instanceof HTMLElement)) {
                return;
            }

            if (messageNode.classList.contains('message-error')) {
                return;
            }

            if (messageNode.classList.contains('user-message')) {
                const turn = this.extractUserTurn(messageNode, index);
                if (turn) {
                    turns.push(turn);
                }
                return;
            }

            if (messageNode.classList.contains('bot-message')) {
                const turn = this.extractAssistantTurn(messageNode, index);
                if (turn) {
                    turns.push(turn);
                }
            }
        });

        return turns;
    }

    extractUserTurn(messageNode, index) {
        const wrapper = messageNode.closest('.message-wrapper');
        const contextButton = wrapper?.querySelector('.user-message-context-button') || null;
        const contextId = contextButton?.dataset.contextId
            || messageNode.dataset.messageId
            || wrapper?.dataset.messageId
            || null;
        const contextData = window.chat?.getSentContext?.(contextId) || {};
        const files = Array.isArray(contextData.files) ? contextData.files : [];
        const sessions = Array.isArray(contextData.sessions) ? contextData.sessions : [];

        const text = this.normalizeWhitespace(
            messageNode.dataset.rawMessage || messageNode.innerText || messageNode.textContent || ''
        );

        if (!text && files.length === 0 && sessions.length === 0) {
            return null;
        }

        return {
            id: messageNode.dataset.messageId || wrapper?.dataset.messageId || `user_${index}`,
            role: 'user',
            text: text || '[Context attached]',
            html: messageNode.innerHTML || '',
            attachments: {
                files: files.map((file) => this.normalizeFileAttachment(file)),
                sessions: sessions.map((session, sessionIndex) => this.normalizeSessionAttachment(session, sessionIndex)),
            },
        };
    }

    extractAssistantTurn(messageNode, index) {
        const contentNode = messageNode.querySelector('.message-content');
        if (!contentNode) {
            return null;
        }

        const clone = contentNode.cloneNode(true);
        clone.querySelectorAll('button, .artifact-reference, .code-copy-btn, .inline-mermaid-toggle-group, .inline-mermaid-toggle')
            .forEach((element) => element.remove());

        const text = this.normalizeWhitespace(clone.innerText || clone.textContent || '');
        if (!text) {
            return null;
        }

        return {
            id: messageNode.dataset.messageId || `assistant_${index}`,
            role: 'assistant',
            text,
            html: clone.innerHTML || '',
            attachments: {
                files: [],
                sessions: [],
            },
        };
    }

    extractSessionContent(messagesContainer) {
        const files = Array.from(messagesContainer.querySelectorAll('.session-file-item')).map((item, index) => {
            const name = this.normalizeWhitespace(item.querySelector('.file-name')?.textContent || `File ${index + 1}`);
            const meta = this.normalizeWhitespace(item.querySelector('.file-meta')?.textContent || '');

            return {
                name: name || `File ${index + 1}`,
                meta,
            };
        });

        const executions = Array.from(messagesContainer.querySelectorAll('.session-exec-item')).map((item, index) => {
            const command = this.normalizeWhitespace(item.querySelector('.exec-command')?.textContent || `Command ${index + 1}`);
            const exit = this.normalizeWhitespace(item.querySelector('.exec-exit')?.textContent || '');

            return {
                command: command || `Command ${index + 1}`,
                exit,
            };
        });

        return { files, executions };
    }

    resolveConversationTitle(turns, messagesContainer) {
        const headerTitle = messagesContainer.querySelector('.past-session-title')?.textContent?.trim();
        if (headerTitle) {
            return headerTitle;
        }

        const currentTitle = window.chat?.getCurrentConversationTitle?.();
        if (currentTitle && currentTitle.trim()) {
            return currentTitle.trim();
        }

        const firstUserTurn = turns.find((turn) => turn.role === 'user' && turn.text);
        const derived = this.buildTitleFromMessage(firstUserTurn?.text || '');
        return derived || null;
    }

    buildTitleFromMessage(message) {
        if (window.contextHandler?.buildTitleFromMessage) {
            const derived = window.contextHandler.buildTitleFromMessage(message);
            if (derived) {
                return derived;
            }
        }

        const cleaned = this.normalizeWhitespace(message);
        if (!cleaned) {
            return null;
        }

        const firstLine = cleaned.split('\n')[0].trim();
        if (!firstLine) {
            return null;
        }

        return firstLine.length > 60 ? `${firstLine.slice(0, 57).trim()}...` : firstLine;
    }

    normalizeFileAttachment(file) {
        const previewUrl = typeof file?.previewUrl === 'string' && file.previewUrl.trim()
            ? file.previewUrl
            : null;
        const content = typeof file?.content === 'string' ? file.content : '';
        const normalizedName = (file?.name || 'Attachment').trim() || 'Attachment';
        const type = file?.type || file?.backendMimeType || 'application/octet-stream';

        return {
            kind: 'file',
            name: normalizedName,
            type,
            previewUrl,
            isText: file?.isText === true || content.length > 0,
            textExcerpt: this.buildTextExcerpt(content),
        };
    }

    normalizeSessionAttachment(session, index) {
        const runs = Array.isArray(session?.runs)
            ? session.runs
            : (Array.isArray(session?.memory?.runs) ? session.memory.runs : []);
        const topLevelRuns = runs.filter((run) => run && !run.parent_run_id);
        const firstRun = topLevelRuns[0];
        const firstMessage = firstRun?.input?.input_content || firstRun?.content || '';

        return {
            kind: 'session',
            title: session?.title || this.buildTitleFromMessage(firstMessage) || `Referenced Session ${index + 1}`,
            messageCount: topLevelRuns.length,
        };
    }

    buildTextExcerpt(content) {
        const normalized = this.normalizeWhitespace(content);
        if (!normalized) {
            return '';
        }

        return normalized.length > 260
            ? `${normalized.slice(0, 257).trim()}...`
            : normalized;
    }

    normalizeWhitespace(value) {
        return String(value || '')
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
    }
}

export const conversationExtractor = new ConversationExtractor();
