// js/chat.js (PWA/Mobile Version - Adapted from Desktop Logic)

import { messageFormatter } from './message-formatter.js';
import { socketService } from './socket-service.js';
import ConversationStateManager from './conversation-state-manager.js';
import FloatingWindowManager from './floating-window-manager.js';
import NotificationService from './notification-service.js';
import WelcomeDisplay from './welcome-display.js';
import UnifiedPreviewHandler from './unified-preview-handler.js';
import ContextHandler from './context-handler.js';
import FileAttachmentHandler from './add-files.js';
import { artifactHandler } from './artifact-handler.js';
import messageActions from './message-actions.js';
import { supabase } from './supabase-client.js';
import { config } from './config.js';
import { artifactCache } from './artifact-cache.js';
import { sessionContentViewer } from './session-content-viewer.js';
import browserScreenshotViewer from './browser-screenshot-viewer.js';
import backgroundRunManager from './background-run-manager.js';
import { contentSecurity } from './security-utils.js';

let sessionActive = false;
let currentConversationId = null;
let isSocketConnected = false;
let sendSubmissionLocked = false;

let contextHandler = null;
let fileAttachmentHandler = null;
let contextViewer = null;
let conversationStateManager = null;
let floatingWindowManager = null;
let welcomeDisplay = null;
let notificationService = null;
// ShuffleMenuController removed - not needed for PWA (Electron-only feature)
let unifiedPreviewHandler = null;

const defaultToolsConfig = {
    internet_search: true,
    coding_assistant: true,
    enable_browser: true,
    enable_computer_control: false,
    enable_github: true,
    enable_google_email: true,
    enable_google_drive: true,
    enable_google_sheets: true,
    enable_supabase: true,
    enable_vercel: true,
};

if (typeof window !== 'undefined') {
    window.renderTurnFromEvents = renderTurnFromEvents;
}

const chatConfig = {
    memory: true,
    tasks: false,
    tools: { ...defaultToolsConfig },
    debug_mode: true,
    deepsearch: false,
};

let selectedAgentType = 'aios';
let shouldResendWithHistory = false;
let offlineNotificationId = null;
let statusNotificationId = null;
let connectionHasBeenLost = false;
let socketListenersBound = false;
let activeRunRequest = null;
let stopRequested = false;
let planModeActive = false;
let activePlanRequest = null;
let planGenerationActive = false;
const pendingSendQueue = [];

const GENERIC_FAILURE_MESSAGE = 'something gone wrong';

// This map now stores the DOM element for each message stream
const ongoingStreams = new Map();
const sentContexts = new Map();

function buildOutgoingAgentConfig(overrides = {}) {
    const outgoing = {
        ...chatConfig.tools,
        ...overrides,
        use_memory: chatConfig.memory,
    };

    if (Object.prototype.hasOwnProperty.call(outgoing, 'computer_control') &&
        !Object.prototype.hasOwnProperty.call(outgoing, 'enable_computer_control')) {
        outgoing.enable_computer_control = !!outgoing.computer_control;
    }

    delete outgoing.computer_control;
    delete outgoing.Planner_Agent;
    delete outgoing.World_Agent;

    return outgoing;
}

// Prevents the same catch-up response being rendered more than once
// (guards against duplicate join_conversation → run_catchup events)
const _renderedCatchups = new Set();
const _renderedSheetsPreviews = new Set();
const _openedSheetsArtifacts = new Set();

function normalizeReasoningContent(value = '') {
    return String(value)
        .replace(/<\/?(?:reasoning|think)>/gi, '')
        .replace(/\r\n?/g, '\n');
}

function getReasoningChunk(data = {}) {
    return data.step ?? data.reasoning_content ?? data.content ?? '';
}

function setCurrentConversationId(nextId) {
    const prevId = currentConversationId;
    currentConversationId = nextId;
    if (typeof window !== 'undefined') {
        window.currentConversationId = nextId;
    }
    // Join the new conversation's socket room
    if (nextId && nextId !== prevId) {
        socketService.joinConversation(nextId);
    }
}

function dispatchChatEvent(eventName, detail = {}) {
    document.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function cloneAttachedFiles(files = []) {
    return Array.isArray(files) ? files.map((file) => ({ ...file })) : [];
}

function cloneSelectedSessions(sessions = []) {
    return Array.isArray(sessions) ? sessions.map((session) => ({ ...session })) : [];
}

function updateSendButtonState() {
    const sendBtn = document.getElementById('send-message');
    const sendIcon = sendBtn?.querySelector('i');
    const planButton = document.getElementById('plan-mode-btn');
    if (!sendBtn || !sendIcon) return;

    if (planButton) {
        planButton.classList.toggle('active', planModeActive);
        planButton.setAttribute('aria-pressed', String(planModeActive));
        planButton.disabled = sessionActive || planGenerationActive;
        planButton.title = planModeActive ? 'Plan Mode on' : 'Plan Mode';
    }

    if (planGenerationActive) {
        sendIcon.classList.remove('fa-paper-plane', 'fa-arrow-up', 'fa-play');
        sendIcon.classList.add('fa-hourglass-half');
        sendBtn.classList.add('sending');
        sendBtn.disabled = true;
        sendBtn.setAttribute('aria-label', 'Generating plan');
        sendBtn.setAttribute('title', 'Generating plan');
        return;
    }

    if (sessionActive) {
        sendIcon.classList.remove('fa-paper-plane', 'fa-arrow-up', 'fa-hourglass-half');
        sendIcon.classList.add('fa-play');
        sendBtn.classList.add('sending');
        sendBtn.disabled = false;
        sendBtn.setAttribute('aria-label', stopRequested ? 'Stopping response' : 'Stop response');
        sendBtn.setAttribute('title', stopRequested ? 'Stopping response' : 'Stop response');
        return;
    }

    sendIcon.classList.remove('fa-play', 'fa-hourglass-half');
    sendIcon.classList.add('fa-paper-plane');
    sendBtn.classList.remove('sending');
    sendBtn.disabled = false;
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.setAttribute('title', 'Send message');
}

function getBotMessageElement(messageId) {
    if (!messageId) return null;
    return ongoingStreams.get(messageId) || document.querySelector(`.bot-message[data-message-id="${messageId}"]`);
}

function clearActiveRunState() {
    activeRunRequest = null;
    stopRequested = false;
    sessionActive = false;
    updateSendButtonState();
    flushQueuedMessages();
}

function queuePendingMessageForSend({ isMemoryEnabled, agentType, message, attachedFiles, selectedSessions }) {
    pendingSendQueue.push({
        isMemoryEnabled,
        agentType,
        options: {
            messageOverride: message,
            attachedFilesOverride: cloneAttachedFiles(attachedFiles),
            selectedSessionsOverride: cloneSelectedSessions(selectedSessions),
            includeAttachedFiles: false,
            includeSelectedSessions: false,
            skipUserMessage: true,
        },
    });
}

function flushQueuedMessages() {
    if (!isSocketConnected || sessionActive || pendingSendQueue.length === 0) {
        return;
    }

    const queued = pendingSendQueue.shift();
    if (!queued) return;

    chatModule.handleSendMessage(
        queued.isMemoryEnabled,
        queued.agentType,
        queued.options
    ).catch((error) => {
        console.error('[Chat] Failed to flush queued message:', error);
    });
}

function getFallbackRetryRequest() {
    const lastUserMessage = Array.from(document.querySelectorAll('.user-message'))
        .map((node) => node.dataset.rawMessage || node.textContent || '')
        .map((value) => value.trim())
        .filter(Boolean)
        .at(-1);

    if (!lastUserMessage || !currentConversationId) {
        return null;
    }

    return {
        conversationId: currentConversationId,
        message: lastUserMessage,
        attachedFiles: [],
        selectedSessions: [],
    };
}

function renderMessageFailure(messageId, retryRequest = null) {
    const messageDiv = getBotMessageElement(messageId)
        || createBotMessagePlaceholder(messageId || `error_${Date.now()}`);
    if (!messageDiv) return;

    messageFormatter.finishStreaming(messageId);
    ongoingStreams.delete(messageId);

    messageDiv.classList.add('message-error');
    messageDiv.classList.remove('expanded');
    messageDiv.innerHTML = `
        <div class="message-error-card">
            <p class="message-error-text">${GENERIC_FAILURE_MESSAGE}</p>
            ${retryRequest ? '<button type="button" class="message-error-retry">Retry</button>' : ''}
        </div>
    `;

    const retryButton = messageDiv.querySelector('.message-error-retry');
    if (retryButton && retryRequest) {
        retryButton.addEventListener('click', async () => {
            const targetMessage = getBotMessageElement(messageId);
            targetMessage?.remove();
            shouldResendWithHistory = false;
            await chatModule.handleSendMessage(
                undefined,
                undefined,
                {
                    messageOverride: retryRequest.message,
                    attachedFilesOverride: cloneAttachedFiles(retryRequest.attachedFiles),
                    selectedSessionsOverride: cloneSelectedSessions(retryRequest.selectedSessions),
                    includeAttachedFiles: false,
                    includeSelectedSessions: false,
                    skipUserMessage: true,
                }
            );
        });
    }
}

function handleRunFailure(messageId, retryRequest = null) {
    const nextRetryRequest = retryRequest || activeRunRequest || getFallbackRetryRequest();
    renderMessageFailure(messageId || activeRunRequest?.messageId, nextRetryRequest);
    try {
        backgroundRunManager.markRunFailed(currentConversationId, GENERIC_FAILURE_MESSAGE);
    } catch (_) { }
    shouldResendWithHistory = false;
    clearActiveRunState();
    resetUserInputState();
    notificationService?.show(GENERIC_FAILURE_MESSAGE, 'error');
    dispatchChatEvent('chatStateChanged', { status: 'error', conversationId: currentConversationId });
}

function closeAllDropdowns() {
    document.querySelectorAll('[aria-expanded="true"]').forEach((trigger) => {
        trigger.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.top-bar-dropdown, .input-action-menu').forEach((menu) => {
        menu.classList.add('hidden');
    });
}

function renderTurnFromEvents(events = [], { messageId = `replay_${Date.now()}`, autoScroll = false, container = null } = {}) {
    if (!Array.isArray(events) || events.length === 0) return null;

    let botMessage = ongoingStreams.get(messageId);
    if (!botMessage) {
        botMessage = createBotMessagePlaceholder(messageId, container);
    }
    if (!botMessage) return null;

    events.forEach((event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'response') {
            populateBotMessage({
                id: messageId,
                content: event.content,
                streaming: false,
                agent_name: event.agent_name,
                team_name: event.team_name,
                is_log: event.is_log,
            });
        } else if (event.type === 'agent_step') {
            handleAgentStep({
                id: messageId,
                type: event.step_type || event.step,
                name: event.name,
                agent_name: event.agent_name,
                team_name: event.team_name,
                tool: event.tool,
            });
        } else if (event.type === 'reasoning_step') {
            handleReasoningStep({
                id: messageId,
                agent_name: event.agent_name,
                step: event.step,
                reasoning_content: event.reasoning_content,
                delegated_agent: event.delegated_agent,
                team_name: event.team_name,
            });
        } else if (event.type === 'sandbox') {
            appendSandboxMessage({
                messageId,
                payload: event.payload,
                level: event.level,
            });
        }
    });

    handleDone({ id: messageId });

    if (autoScroll) {
        const messagesContainer = container || document.getElementById('chat-messages');
        messagesContainer?.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
    }

    return botMessage;
}

function appendSandboxMessage({ messageId, payload, level = 'info' }) {
    if (!messageId || !payload) return;
    let messageDiv = ongoingStreams.get(messageId);
    if (!messageDiv) {
        createBotMessagePlaceholder(messageId);
        messageDiv = ongoingStreams.get(messageId);
    }
    if (!messageDiv) return;

    const sandboxLogId = `sandbox-log-${messageId}`;
    let sandboxSection = messageDiv.querySelector(`#${sandboxLogId}`);
    if (!sandboxSection) {
        sandboxSection = document.createElement('div');
        sandboxSection.id = sandboxLogId;
        sandboxSection.className = 'sandbox-log';
        sandboxSection.innerHTML = `
            <div class="content-block log-block">
                <div class="content-block-header">Sandbox</div>
                <div class="inner-content"></div>
            </div>
        `;
        const detailedLogs = messageDiv.querySelector('.detailed-logs');
        detailedLogs?.appendChild(sandboxSection);
    }

    const inner = sandboxSection.querySelector('.inner-content');
    if (!inner) return;
    const entry = document.createElement('div');
    entry.className = `sandbox-log-entry sandbox-log-${level}`;
    entry.textContent = payload;
    inner.appendChild(entry);
    messageDiv.classList.add('expanded');
}

function resetUserInputState() {
    const input = document.getElementById('floating-input');
    if (input) {
        input.disabled = false;
        input.value = '';
        input.style.height = 'auto';
    }
    updateSendButtonState();
}

function mapStatusLevelToType(level) {
    const normalized = (level || '').toLowerCase();
    if (['error', 'danger', 'fail', 'failed'].includes(normalized)) return 'error';
    if (['warn', 'warning'].includes(normalized)) return 'warning';
    if (['success', 'ok', 'ready'].includes(normalized)) return 'success';
    return 'info';
}

function dismissOfflineNotification() {
    if (offlineNotificationId && notificationService?.remove) {
        notificationService.remove(offlineNotificationId);
        offlineNotificationId = null;
    }
}

function dismissStatusNotification() {
    if (statusNotificationId && notificationService?.remove) {
        notificationService.remove(statusNotificationId);
        statusNotificationId = null;
    }
}

function handleSocketConnect() {
    isSocketConnected = true;
    console.log('Socket connected successfully.');
    dismissOfflineNotification();
    dispatchChatEvent('chatConnectionChanged', { connected: true });
    dispatchChatEvent('chatStateChanged', { status: 'connected', conversationId: currentConversationId });

    if (connectionHasBeenLost && notificationService) {
        notificationService.show('Connection restored.', 'success', 3000);
    }

    connectionHasBeenLost = false;

    // Join the current room + all rooms with running queued tasks.
    // BackgroundRunManager._joinRoom() deduplicates via its _joinedRooms Set
    // so no conversation is ever joined twice even if it appears in both lists.
    try {
        // Treat the active conversation as a room to (re-)join on every connect
        if (currentConversationId) {
            backgroundRunManager._joinRoom(currentConversationId);
        }
        // Re-attach to any conversation that has a run in progress in the background
        backgroundRunManager.rejoinAllRunning();
    } catch (_) { }

    flushQueuedMessages();
}

function handleSocketDisconnect() {
    console.warn('Socket disconnected.');

    if (sessionActive) {
        sessionActive = false;
        shouldResendWithHistory = true;
        resetUserInputState();
    }

    isSocketConnected = false;
    connectionHasBeenLost = true;

    // Reset room join tracking so that on the next connect we re-join cleanly.
    // (Server drops all room memberships when socket disconnects.)
    try { backgroundRunManager.resetRoomTracking(); } catch (_) { }
    dispatchChatEvent('chatConnectionChanged', { connected: false });
    dispatchChatEvent('chatStateChanged', { status: 'disconnected', conversationId: currentConversationId });

    if (!offlineNotificationId && notificationService) {
        offlineNotificationId = notificationService.show('Connection lost. Attempting to reconnect…', 'warning', 0);
    }
}

function handleStatusEvent(data = {}) {
    if (!notificationService) return;

    const message = data.message || data.status || '';
    if (!message.trim()) return;

    const type = mapStatusLevelToType(data.level || data.type);
    const persistent = data.persistent === true;
    const duration = typeof data.duration === 'number'
        ? data.duration
        : (persistent ? 0 : 4000);

    if (persistent) {
        dismissStatusNotification();
        statusNotificationId = notificationService.show(message, type, duration);
        return;
    }

    const notificationId = notificationService.show(message, type, duration);
    if (statusNotificationId === notificationId) {
        statusNotificationId = null;
    }
}

function updateReasoningSummary(messageId) {
    const messageDiv = ongoingStreams.get(messageId);
    if (!messageDiv) return;

    const summary = messageDiv.querySelector('.reasoning-summary');
    if (!summary) return;

    const summaryText = summary.querySelector('.summary-text');
    if (!summaryText) return;

    const reasoningBlocks = messageDiv.querySelectorAll('.reasoning-thought-block').length;
    const agentBlocks = messageDiv.querySelectorAll('.detailed-logs > .log-block:not(.reasoning-thought-block)').length;
    const toolLogs = messageDiv.querySelectorAll('.tool-log-entry:not(.reasoning-log-entry)').length;

    if (reasoningBlocks === 0 && agentBlocks === 0 && toolLogs === 0) {
        summaryText.textContent = 'Reasoning: 0 thoughts, 0 tools, 0 agents';
        summary.classList.add('hidden');
        return;
    }

    const parts = [];
    if (reasoningBlocks > 0) parts.push(`${reasoningBlocks} thought${reasoningBlocks > 1 ? 's' : ''}`);
    if (toolLogs > 0) parts.push(`${toolLogs} tool${toolLogs > 1 ? 's' : ''}`);
    if (agentBlocks > 0) parts.push(`${agentBlocks} agent${agentBlocks > 1 ? 's' : ''}`);
    summaryText.textContent = `Reasoning: ${parts.join(', ')}`;
    summary.classList.remove('hidden');
}

function addUserMessage(message, files = [], sessions = []) {
    const messagesContainer = document.getElementById('chat-messages');
    if (!messagesContainer) return;

    const messageId = `user_msg_${Date.now()}`;
    const wrapperDiv = document.createElement('div');
    wrapperDiv.className = 'message-wrapper user-message-wrapper';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message user-message';
    const hasContext = files.length > 0 || sessions.length > 0;
    const displayText = message || (hasContext ? '[Context Attached]' : '');
    messageDiv.dataset.rawMessage = displayText;
    messageDiv.innerHTML = messageFormatter.format(displayText);

    wrapperDiv.appendChild(messageDiv);

    if (files.length > 0 || sessions.length > 0) {
        sentContexts.set(messageId, { files, sessions });
        const contextButton = document.createElement('button');
        contextButton.className = 'user-message-context-button';
        const fileCount = files.length;
        const sessionCount = sessions.length;
        let buttonText = 'Context';
        if (sessionCount > 0 && fileCount > 0) buttonText = `Context: ${sessionCount} session(s) & ${fileCount} file(s)`;
        else if (sessionCount > 0) buttonText = `Context: ${sessionCount} session(s)`;
        else if (fileCount > 0) buttonText = `Context: ${fileCount} file(s)`;
        contextButton.innerHTML = `<i class="fas fa-paperclip"></i> ${buttonText}`;
        contextButton.dataset.contextId = messageId;
        contextButton.addEventListener('click', () => {
            const contextData = sentContexts.get(messageId);
            if (contextViewer && contextData) contextViewer.show(contextData);
        });
        wrapperDiv.appendChild(contextButton);
    }

    messagesContainer.appendChild(wrapperDiv);
    wrapperDiv.dataset.messageId = messageId;
    messageDiv.dataset.messageId = messageId;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // No actions for user messages - they don't need to copy their own input

    dispatchChatEvent('messageAdded', { role: 'user', messageId });
}

function createBotMessagePlaceholder(messageId, container = null) {
    const messagesContainer = container || document.getElementById('chat-messages');
    if (!messagesContainer) return null;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message message-bot';
    messageDiv.dataset.messageId = messageId;

    const thinkingIndicator = document.createElement('div');
    thinkingIndicator.className = 'thinking-indicator';
    thinkingIndicator.innerHTML = `
        <div class="reasoning-summary hidden" role="button" tabindex="0">
            <span class="summary-text">Reasoning: 0 thoughts, 0 tools, 0 agents</span>
            <i class="fas fa-chevron-down summary-chevron"></i>
        </div>
    `;

    const detailedLogs = document.createElement('div');
    detailedLogs.className = 'detailed-logs';
    detailedLogs.id = `logs-${messageId}`;

    const mainContent = document.createElement('div');
    mainContent.className = 'message-content';
    mainContent.id = `main-content-${messageId}`;

    messageDiv.appendChild(thinkingIndicator);
    messageDiv.appendChild(detailedLogs);
    messageDiv.appendChild(mainContent);

    messagesContainer.appendChild(messageDiv);
    ongoingStreams.set(messageId, messageDiv);

    // Auto-scroll is now handled by the caller (e.g., renderTurnFromEvents)

    const summary = thinkingIndicator.querySelector('.reasoning-summary');
    summary?.addEventListener('click', () => {
        messageDiv.classList.toggle('expanded');
    });
    summary?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            messageDiv.classList.toggle('expanded');
        }
    });
    return messageDiv;
}

function setPlanModeActive(enabled) {
    planModeActive = Boolean(enabled);
    updateSendButtonState();
    dispatchChatEvent('planModeChanged', { active: planModeActive });
}

function setupPlanModeControls() {
    const planButton = document.getElementById('plan-mode-btn');
    if (!planButton || planButton.dataset.bound === 'true') return;

    planButton.dataset.bound = 'true';
    planButton.addEventListener('click', () => {
        if (sessionActive || planGenerationActive) {
            notificationService?.show('Plan Mode can be changed after the current response finishes.', 'warning');
            return;
        }
        setPlanModeActive(!planModeActive);
    });
    updateSendButtonState();
}

function getPlanChunk(data = {}) {
    return data.content ?? data.chunk ?? data.delta ?? data.text ?? '';
}

function getPlanDoneText(data = {}) {
    return data.plan ?? data.final_plan ?? data.finalPlan ?? data.content ?? '';
}

function sanitizePlanHtml(markdown = '') {
    const formatted = messageFormatter.format(markdown || '', { inlineArtifacts: true });
    return contentSecurity.sanitizeHTML(formatted, {
        ALLOWED_TAGS: [
            'p', 'br', 'strong', 'em', 'b', 'i', 'code', 'pre', 'a', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'thead', 'tbody',
            'tr', 'th', 'td', 'span', 'div'
        ],
        ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel', 'title'],
        ALLOW_DATA_ATTR: true
    });
}

function ensurePlanCard(messageId) {
    const messageDiv = ongoingStreams.get(messageId) || getBotMessageElement(messageId);
    if (!messageDiv) return null;

    const mainContent = messageDiv.querySelector(`#main-content-${messageId}`) || messageDiv.querySelector('.message-content');
    if (!mainContent) return null;

    let card = mainContent.querySelector('.plan-mode-card');
    if (card) return card;

    const block = document.createElement('div');
    block.className = 'content-block plan-mode-content-block';
    block.innerHTML = `
        <div class="inner-content">
            <div class="plan-mode-card is-streaming">
                <div class="plan-mode-card-header">
                    <div class="plan-mode-title">
                        <i class="fas fa-route" aria-hidden="true"></i>
                        <span>Plan Mode</span>
                    </div>
                    <span class="plan-mode-status">Planning</span>
                </div>
                <div class="plan-mode-rendered"></div>
                <textarea class="plan-mode-editor hidden" aria-label="Edit plan"></textarea>
                <div class="plan-mode-actions hidden">
                    <button type="button" class="plan-mode-action plan-mode-edit">
                        <i class="fas fa-pen" aria-hidden="true"></i>
                        <span>Edit</span>
                    </button>
                    <button type="button" class="plan-mode-action plan-mode-cancel">
                        <i class="fas fa-times" aria-hidden="true"></i>
                        <span>Cancel</span>
                    </button>
                    <button type="button" class="plan-mode-action plan-mode-submit primary">
                        <i class="fas fa-arrow-up" aria-hidden="true"></i>
                        <span>Submit</span>
                    </button>
                </div>
            </div>
        </div>
    `;
    mainContent.appendChild(block);

    card = block.querySelector('.plan-mode-card');
    card.querySelector('.plan-mode-edit')?.addEventListener('click', () => setPlanEditorMode(messageId, true));
    card.querySelector('.plan-mode-cancel')?.addEventListener('click', () => cancelPlanRequest(messageId));
    card.querySelector('.plan-mode-submit')?.addEventListener('click', () => submitApprovedPlan(messageId));
    return card;
}

function renderPlanCard(messageId, { done = false } = {}) {
    if (!activePlanRequest || activePlanRequest.messageId !== messageId) return;

    const card = ensurePlanCard(messageId);
    if (!card) return;

    const rendered = card.querySelector('.plan-mode-rendered');
    const editor = card.querySelector('.plan-mode-editor');
    const status = card.querySelector('.plan-mode-status');
    const actions = card.querySelector('.plan-mode-actions');
    const planText = activePlanRequest.planBuffer || 'Preparing your plan...';

    if (rendered && !card.classList.contains('is-editing')) {
        rendered.innerHTML = sanitizePlanHtml(planText);
        messageFormatter.applyInlineEnhancements?.(rendered);
    }
    if (editor && !card.classList.contains('is-editing')) {
        editor.value = activePlanRequest.planBuffer || '';
    }
    if (status) {
        status.textContent = done ? 'Ready' : 'Planning';
    }
    card.classList.toggle('is-streaming', !done);
    actions?.classList.toggle('hidden', !done);
}

function setPlanEditorMode(messageId, editing) {
    if (!activePlanRequest || activePlanRequest.messageId !== messageId) return;

    const card = ensurePlanCard(messageId);
    if (!card) return;

    const rendered = card.querySelector('.plan-mode-rendered');
    const editor = card.querySelector('.plan-mode-editor');
    const editButton = card.querySelector('.plan-mode-edit span');
    const isEditing = Boolean(editing);

    if (editor && isEditing) {
        editor.value = activePlanRequest.planBuffer || '';
        requestAnimationFrame(() => editor.focus());
    } else if (editor) {
        activePlanRequest.planBuffer = editor.value.trim() || activePlanRequest.planBuffer;
        renderPlanCard(messageId, { done: true });
    }

    card.classList.toggle('is-editing', isEditing);
    rendered?.classList.toggle('hidden', isEditing);
    editor?.classList.toggle('hidden', !isEditing);
    if (editButton) {
        editButton.textContent = isEditing ? 'Preview' : 'Edit';
    }
}

function finishPlanRequest(messageId) {
    const messageDiv = ongoingStreams.get(messageId);
    if (messageDiv) {
        const thinkingIndicator = messageDiv.querySelector('.thinking-indicator');
        const summary = thinkingIndicator?.querySelector('.reasoning-summary');
        thinkingIndicator?.classList.add('steps-done');
        if (summary && messageDiv.querySelector('.log-block, .tool-log-entry, .reasoning-thought-block')) {
            summary.classList.remove('hidden');
        } else {
            thinkingIndicator?.remove();
        }
        ongoingStreams.delete(messageId);
    }
    planGenerationActive = false;
    updateSendButtonState();
}

function cancelPlanRequest(messageId) {
    if (!activePlanRequest || activePlanRequest.messageId !== messageId) return;

    const messageDiv = getBotMessageElement(messageId);
    messageDiv?.remove();
    activePlanRequest = null;
    planGenerationActive = false;
    updateSendButtonState();
    notificationService?.show('Plan discarded.', 'info', 2500);
}

async function submitApprovedPlan(messageId) {
    if (!activePlanRequest || activePlanRequest.messageId !== messageId) return;

    const card = ensurePlanCard(messageId);
    const editor = card?.querySelector('.plan-mode-editor');
    const approvedPlan = (card?.classList.contains('is-editing') && editor)
        ? editor.value.trim()
        : (activePlanRequest.planBuffer || '').trim();

    if (!approvedPlan) {
        notificationService?.show('The plan is empty. Add details before submitting.', 'warning');
        return;
    }

    const capturedFiles = cloneAttachedFiles(activePlanRequest.attachedFiles || []);
    const capturedSessions = cloneSelectedSessions(activePlanRequest.selectedSessions || []);
    activePlanRequest = null;
    setPlanModeActive(false);

    addUserMessage('Plan approved. Starting the improved request.', capturedFiles, capturedSessions);
    await chatModule.handleSendMessage(undefined, undefined, {
        messageOverride: approvedPlan,
        attachedFilesOverride: capturedFiles,
        selectedSessionsOverride: capturedSessions,
        includeAttachedFiles: false,
        includeSelectedSessions: false,
        skipUserMessage: true,
    });

    fileAttachmentHandler?.clearAttachedFiles?.();
    contextHandler?.clearSelectedContext?.();
}

async function startPlanRequest({ message, attachedFiles, selectedSessions }) {
    if (planGenerationActive || sessionActive) {
        notificationService?.show('Please wait for the current response to finish.', 'warning');
        return;
    }

    if (!isSocketConnected) {
        notificationService?.show('Plan Mode needs a server connection. Please wait or refresh.', 'warning');
        return;
    }

    planGenerationActive = true;
    updateSendButtonState();

    addUserMessage(message || 'Attached context', attachedFiles, selectedSessions);

    const input = document.getElementById('floating-input');
    if (input) {
        input.value = '';
        requestAnimationFrame(() => {
            input.style.height = 'auto';
        });
        input.focus();
    }

    const messageId = `plan_${Date.now()}`;
    createBotMessagePlaceholder(messageId);

    activePlanRequest = {
        messageId,
        conversationId: currentConversationId,
        originalMessage: message,
        attachedFiles: cloneAttachedFiles(attachedFiles),
        selectedSessions: cloneSelectedSessions(selectedSessions),
        planBuffer: '',
    };
    renderPlanCard(messageId);

    const payload = {
        id: messageId,
        conversationId: currentConversationId,
        message,
        config: buildOutgoingAgentConfig(),
        files: cloneAttachedFiles(attachedFiles),
        selected_sessions: cloneSelectedSessions(selectedSessions),
        context_session_ids: selectedSessions.map(session => session.session_id).filter(Boolean),
    };

    if (window.projectWorkspace?.isActive?.()) {
        payload.agent_mode = 'coder';
        payload.config.agent_mode = 'coder';
        payload.workspace_context = window.projectWorkspace.getWorkspaceContextPayload?.() || window.projectContext || null;
    }

    try {
        await socketService.sendPlanRequest(payload);
    } catch (error) {
        console.error('[PlanMode] Failed to send plan request:', error);
        renderMessageFailure(messageId, null);
        activePlanRequest = null;
        planGenerationActive = false;
        updateSendButtonState();
        notificationService?.show(error.message || 'Plan Mode request failed.', 'error');
    }
}

function handlePlanResponse(data = {}) {
    const messageId = data.id || data.messageId || activePlanRequest?.messageId;
    if (!messageId || !activePlanRequest || activePlanRequest.messageId !== messageId) return;

    const eventType = String(data.type || data.event || '').toLowerCase();
    const isReasoningEvent = eventType === 'reasoning' || Boolean(data.reasoning_content || data.step);
    const isToolEvent = eventType === 'tool_start' || eventType === 'tool_end';

    if (eventType === 'error' || data.status === 'error' || data.error) {
        renderMessageFailure(messageId, null);
        activePlanRequest = null;
        planGenerationActive = false;
        updateSendButtonState();
        notificationService?.show(data.message || data.error || 'Plan Mode failed.', 'error');
        return;
    }

    if (eventType === 'reasoning' || data.reasoning_content || data.step) {
        appendReasoningContent({
            id: messageId,
            agent_name: data.agent_name || 'plan_agent',
            reasoning_content: data.reasoning_content || data.content || data.step,
        });
    } else if (isToolEvent) {
        handleAgentStep({
            id: messageId,
            type: eventType,
            name: data.name || data.tool?.tool_name || data.tool?.name || 'tool',
            agent_name: data.agent_name || 'plan_agent',
            tool: data.tool,
        });
    }

    if (!isReasoningEvent && !isToolEvent && (eventType === 'content' || data.content || data.chunk || data.delta || data.text)) {
        const chunk = getPlanChunk(data);
        if (chunk) {
            activePlanRequest.planBuffer += String(chunk);
            renderPlanCard(messageId);
        }
    }

    if (eventType === 'done' || data.done || data.status === 'done' || data.status === 'complete') {
        const finalText = getPlanDoneText(data);
        if (finalText && finalText.length >= activePlanRequest.planBuffer.length) {
            activePlanRequest.planBuffer = String(finalText);
        }
        renderPlanCard(messageId, { done: true });
        finishPlanRequest(messageId);
    }
}

// Helper to normalize content from backend (handles objects, strings, etc.)
function normalizeBackendContent(content) {
    console.log('[Chat] normalizeBackendContent called:', {
        contentType: typeof content,
        isNull: content === null,
        isUndefined: content === undefined,
        contentPreview: typeof content === 'string' ? content.substring(0, 100) : content
    });

    // If it's already a string, return as-is
    if (typeof content === 'string') {
        console.log('[Chat] Content is already a string, returning as-is');
        return content;
    }

    // If it's null or undefined, return empty string
    if (content == null) {
        console.log('[Chat] Content is null/undefined, returning empty string');
        return '';
    }

    // If it's an object, extract the actual content
    if (typeof content === 'object') {
        console.log('[Chat] Content is an object, extracting...');

        // Check for common content keys
        const potentialKeys = ['raw', 'code', 'content', 'text', 'output', 'data'];

        for (const key of potentialKeys) {
            if (Object.prototype.hasOwnProperty.call(content, key)) {
                const value = content[key];
                console.log(`[Chat] Found key "${key}" with value type:`, typeof value);

                // If the value is a string, check if it's already markdown
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    // If it's already a code block, return as-is
                    if (trimmed.startsWith('```')) {
                        console.log('[Chat] Value is already markdown code block');
                        return trimmed;
                    }
                    // If it has language info, wrap it
                    const lang = content.lang || content.language || content.format || '';
                    if (lang && trimmed) {
                        console.log('[Chat] Wrapping in code block with language:', lang);
                        return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
                    }
                    // Otherwise return the raw string
                    console.log('[Chat] Returning raw string value');
                    return trimmed;
                }

                // If the value is an object, stringify it as JSON
                if (typeof value === 'object' && value !== null) {
                    console.log('[Chat] Value is object, stringifying as JSON');
                    const jsonString = JSON.stringify(value, null, 2);
                    return `\`\`\`json\n${jsonString}\n\`\`\``;
                }

                // For other types, convert to string
                console.log('[Chat] Converting value to string');
                return String(value);
            }
        }

        // If no content key found, stringify the entire object
        console.log('[Chat] No content key found, stringifying entire object');
        try {
            const jsonString = JSON.stringify(content, null, 2);
            return `\`\`\`json\n${jsonString}\n\`\`\``;
        } catch (e) {
            console.error('[Chat] Failed to stringify object:', e);
            return '[Complex object - unable to display]';
        }
    }

    // For any other type, convert to string
    console.log('[Chat] Converting to string (fallback)');
    return String(content);
}

function populateBotMessage(data) {
    console.log('[Chat] populateBotMessage called:', {
        messageId: data.id,
        contentType: typeof data.content,
        streaming: data.streaming,
        agent_name: data.agent_name,
        team_name: data.team_name,
        is_log: data.is_log
    });

    let { content, id: messageId, streaming = false, agent_name, team_name, is_log } = data;
    const messageDiv = ongoingStreams.get(messageId);
    if (!messageDiv) {
        console.warn('[Chat] Message div not found for:', messageId);
        return;
    }

    // Normalize content from backend (handles objects, strings, etc.)
    const originalContent = content;
    content = normalizeBackendContent(content);

    console.log('[Chat] Content after normalization:', {
        originalType: typeof originalContent,
        normalizedType: typeof content,
        normalizedLength: content?.length,
        normalizedPreview: typeof content === 'string' ? content.substring(0, 100) : content
    });

    const ownerName = agent_name || team_name;
    if (!ownerName || !content) {
        console.warn('[Chat] Missing ownerName or content:', { ownerName, hasContent: !!content });
        return;
    }

    const targetContainer = is_log
        ? messageDiv.querySelector(`#logs-${messageId}`)
        : messageDiv.querySelector(`#main-content-${messageId}`);

    if (!targetContainer) return;

    const contentBlockId = `content-block-${messageId}-${ownerName}`;
    let contentBlock = document.getElementById(contentBlockId);

    if (!contentBlock) {
        contentBlock = document.createElement('div');
        contentBlock.id = contentBlockId;
        contentBlock.className = is_log ? 'content-block log-block' : 'content-block';

        // Only add header for log blocks, not for main content
        if (is_log) {
            const header = document.createElement('div');
            header.className = 'content-block-header';
            header.textContent = ownerName.replace(/_/g, ' ');
            contentBlock.appendChild(header);
        }

        const innerContent = document.createElement('div');
        innerContent.className = 'inner-content';
        contentBlock.appendChild(innerContent);

        targetContainer.appendChild(contentBlock);
    }

    const innerContentDiv = contentBlock.querySelector('.inner-content');
    if (innerContentDiv) {
        const streamId = `${messageId}-${ownerName}`;

        // Use inline mode for main content, button mode for logs
        const useInlineMode = !is_log;

        const formattedContent = streaming
            ? messageFormatter.formatStreaming(content, streamId)
            : messageFormatter.format(content, { inlineArtifacts: true });

        innerContentDiv.innerHTML = contentSecurity.sanitizeHTML(formattedContent, {
            ALLOWED_TAGS: [
                'p', 'br', 'strong', 'em', 'b', 'i', 'code', 'pre', 'a', 'ul', 'ol', 'li',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'thead', 'tbody',
                'tr', 'th', 'td', 'span', 'div', 'button'
            ],
            ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel', 'type', 'aria-label', 'title'],
            ALLOW_DATA_ATTR: true
        });

        if (!streaming) {
            messageFormatter.applyInlineEnhancements?.(innerContentDiv);
        }

        if (typeof hljs !== 'undefined') {
            innerContentDiv.querySelectorAll('pre code').forEach((block) => {
                if (!block.dataset.highlighted) {
                    hljs.highlightElement(block);
                    block.dataset.highlighted = 'true';
                }
            });
        }
    }

    if (is_log) {
        updateReasoningSummary(messageId);
    }
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function extractSheetsMetadataFromAgentStep(data = {}) {
    const toolPayload = data?.tool;
    if (!toolPayload || typeof toolPayload !== 'object') return null;

    const toolOutput = toolPayload.tool_output;
    let metadata = toolOutput && typeof toolOutput === 'object'
        ? toolOutput.metadata
        : null;

    if (!metadata && typeof toolPayload.metadata === 'object') {
        metadata = toolPayload.metadata;
    }
    if (!metadata || typeof metadata !== 'object') return null;
    if (metadata.kind !== 'google_sheets_tool_output') return null;
    return metadata;
}

function buildSheetsTableHtml(metadata = {}) {
    const inline = metadata.inline || {};
    const columns = Array.isArray(inline.columns) ? inline.columns : [];
    const rows = Array.isArray(inline.rows) ? inline.rows : [];
    if (columns.length === 0 && rows.length === 0) {
        return '<p class="sheets-preview-empty">No table preview data available.</p>';
    }

    const headerHtml = columns.length > 0
        ? `<thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead>`
        : '';
    const bodyHtml = rows.length > 0
        ? `<tbody>${rows.map((row) => `<tr>${(Array.isArray(row) ? row : [row]).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';

    const rowCount = Number.isFinite(inline.row_count) ? Number(inline.row_count) : null;
    const columnCount = Number.isFinite(inline.column_count) ? Number(inline.column_count) : null;
    const summary = [
        rowCount !== null ? `${rowCount} row${rowCount === 1 ? '' : 's'}` : null,
        columnCount !== null ? `${columnCount} column${columnCount === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' • ');

    return `
        <div class="sheets-preview-table-wrap">
            ${summary ? `<div class="sheets-preview-meta">${escapeHtml(summary)}</div>` : ''}
            <table class="sheets-preview-table">
                ${headerHtml}
                ${bodyHtml}
            </table>
        </div>
    `;
}

function buildSheetsListHtml(metadata = {}) {
    const inline = metadata.inline || {};
    const items = Array.isArray(inline.items) ? inline.items : [];
    if (items.length === 0) {
        return '<p class="sheets-preview-empty">No items found.</p>';
    }

    const listItems = items.slice(0, 12).map((item) => {
        if (item && typeof item === 'object') {
            const label = item.title || item.name || item.id || 'Item';
            const detail = item.url || item.range || item.modified_time || item.sheet_id || '';
            return `
                <li class="sheets-preview-list-item">
                    <span class="sheets-preview-list-label">${escapeHtml(label)}</span>
                    ${detail ? `<span class="sheets-preview-list-detail">${escapeHtml(detail)}</span>` : ''}
                </li>
            `;
        }
        return `<li class="sheets-preview-list-item">${escapeHtml(item)}</li>`;
    }).join('');

    return `<ul class="sheets-preview-list">${listItems}</ul>`;
}

function buildSheetsInfoHtml(metadata = {}) {
    const inline = metadata.inline || {};
    const fields = Object.entries(inline)
        .filter(([key, value]) => !Array.isArray(value) && value !== null && typeof value !== 'object' && String(value).trim() !== '')
        .slice(0, 8);

    if (fields.length === 0) {
        return '<p class="sheets-preview-empty">No additional details available.</p>';
    }

    return `
        <dl class="sheets-preview-info-list">
            ${fields.map(([key, value]) => `
                <div class="sheets-preview-info-row">
                    <dt>${escapeHtml(key.replace(/_/g, ' '))}</dt>
                    <dd>${escapeHtml(value)}</dd>
                </div>
            `).join('')}
        </dl>
    `;
}

function buildSheetsPreviewHtml(metadata = {}) {
    const previewType = String(metadata.preview_type || '').toLowerCase();
    const title = escapeHtml(metadata.title || 'Google Sheets result');
    const summary = escapeHtml(metadata.summary || '');

    let bodyHtml = '<p class="sheets-preview-empty">Preview unavailable for this operation.</p>';
    if (previewType === 'sheet_table') {
        bodyHtml = buildSheetsTableHtml(metadata);
    } else if (previewType === 'sheet_list') {
        bodyHtml = buildSheetsListHtml(metadata);
    } else if (previewType === 'sheet_info') {
        bodyHtml = buildSheetsInfoHtml(metadata);
    }

    return `
        <div class="sheets-preview-card">
            <div class="sheets-preview-header">
                <span class="sheets-preview-badge">Google Sheets</span>
                <strong>${title}</strong>
            </div>
            ${summary ? `<p class="sheets-preview-summary">${summary}</p>` : ''}
            <div class="sheets-preview-body">${bodyHtml}</div>
        </div>
    `;
}

function maybeOpenSheetsArtifact(metadata = {}) {
    const outputId = String(metadata.output_id || '').trim();
    if (!outputId || _openedSheetsArtifacts.has(outputId)) return;

    const operation = String(metadata.operation || '').toLowerCase();
    const shouldAutoOpen = ['write', 'append', 'batch_write', 'clear'].includes(operation);
    if (!shouldAutoOpen) return;

    _openedSheetsArtifacts.add(outputId);
    const artifactHtml = buildSheetsPreviewHtml(metadata);
    artifactHandler.showArtifact(
        artifactHtml,
        'html',
        `sheets-${outputId}`,
        metadata.title || 'Google Sheets Preview',
    );
}

function renderSheetsPreviewInLog(logEntry, messageId, metadata = {}) {
    if (!logEntry || !metadata || typeof metadata !== 'object') return;
    const outputId = String(metadata.output_id || '').trim();
    if (!outputId) return;

    const previewKey = `${messageId}:${outputId}`;
    if (_renderedSheetsPreviews.has(previewKey)) {
        maybeOpenSheetsArtifact(metadata);
        return;
    }
    _renderedSheetsPreviews.add(previewKey);

    let previewContainer = logEntry.querySelector('.tool-preview-container');
    if (!previewContainer) {
        previewContainer = document.createElement('div');
        previewContainer.className = 'tool-preview-container';
        logEntry.appendChild(previewContainer);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'tool-preview-entry';
    wrapper.dataset.outputId = outputId;
    wrapper.innerHTML = buildSheetsPreviewHtml(metadata);
    previewContainer.appendChild(wrapper);

    maybeOpenSheetsArtifact(metadata);
}

function handleAgentStep(data) {
    const { id: messageId, type, name, agent_name, team_name } = data;
    const messageDiv = ongoingStreams.get(messageId);
    if (!messageDiv) return;

    const safeName = (name || 'tool').toString();
    const toolName = safeName.replace(/_/g, ' ');
    const ownerName = agent_name || team_name || 'Assistant';
    const stepId = `step-${messageId}-${ownerName}-${safeName}`;

    const logsContainer = messageDiv.querySelector('.detailed-logs');
    const logEntryId = `log-entry-${stepId}`;
    let logEntry = logsContainer.querySelector(`#${logEntryId}`);

    if (type === 'tool_start') {
        if (!logEntry) {
            logEntry = document.createElement('div');
            logEntry.id = logEntryId;
            logEntry.className = 'tool-log-entry';
            logEntry.innerHTML = `
                <i class="fi fi-tr-wisdom tool-log-icon"></i>
                <div class="tool-log-details">
                    <span class="tool-log-action">Used tool: <strong>${toolName}</strong></span>
                </div>
                <span class="tool-log-status in-progress" title="In progress"></span>
            `;
            logsContainer.appendChild(logEntry);
        }
    } else if (type === 'tool_end') {
        if (!logEntry) {
            logEntry = document.createElement('div');
            logEntry.id = logEntryId;
            logEntry.className = 'tool-log-entry';
            logEntry.innerHTML = `
                <i class="fi fi-tr-wisdom tool-log-icon"></i>
                <div class="tool-log-details">
                    <span class="tool-log-action">Used tool: <strong>${toolName}</strong></span>
                </div>
                <span class="tool-log-status completed" title="Completed"></span>
            `;
            logsContainer.appendChild(logEntry);
        } else {
            const statusEl = logEntry.querySelector('.tool-log-status');
            if (statusEl) {
                statusEl.classList.remove('in-progress');
                statusEl.classList.add('completed');
                statusEl.setAttribute('title', 'Completed');
            }
        }

        const metadata = extractSheetsMetadataFromAgentStep(data);
        if (metadata) {
            renderSheetsPreviewInLog(logEntry, messageId, metadata);
        }
    }

    // Remove the live steps display during running state - no spinning icon or text above reasoning title
    updateReasoningSummary(messageId);
}

function appendReasoningContent(data = {}) {
    const messageId = data.id || data.messageId;
    const chunk = normalizeReasoningContent(getReasoningChunk(data));
    if (!messageId || !chunk) return;

    let messageDiv = ongoingStreams.get(messageId);
    if (!messageDiv) {
        createBotMessagePlaceholder(messageId);
        messageDiv = ongoingStreams.get(messageId);
    }
    if (!messageDiv) return;

    const ownerName = (data.agent_name || data.delegated_agent || data.team_name || 'Aetheria AI').replace(/_/g, ' ');
    const ownerKey = ownerName.replace(/[^a-zA-Z0-9_-]/g, '-');
    const logsContainer = messageDiv.querySelector('.detailed-logs');
    if (!logsContainer) return;

    if (!messageDiv._reasoningSignatures) {
        messageDiv._reasoningSignatures = new Set();
    }
    const chunkSignature = `${ownerKey}:${chunk}`;
    if (messageDiv._reasoningSignatures.has(chunkSignature)) {
        return;
    }
    messageDiv._reasoningSignatures.add(chunkSignature);

    const sectionId = `reasoning-log-${messageId}-${ownerKey}`;
    let section = logsContainer.querySelector(`#${sectionId}`);
    if (!section) {
        section = document.createElement('div');
        section.id = sectionId;
        section.className = 'content-block log-block reasoning-thought-block';
        section.innerHTML = `
            <div class="reasoning-thought-header">
                <i class="fi fi-tr-brain reasoning-thought-icon"></i>
                <span>Deep reasoning</span>
            </div>
            <div class="inner-content reasoning-thought-content"></div>
        `;
        logsContainer.appendChild(section);
    }

    const inner = section.querySelector('.reasoning-thought-content');
    if (!inner) return;
    inner.textContent += chunk;
    inner.scrollTop = inner.scrollHeight;

    updateReasoningSummary(messageId);
}

function handleReasoningStep(data = {}) {
    appendReasoningContent(data);
}

function handleDone(data) {
    const { id: messageId } = data;
    if (!messageId || !ongoingStreams.has(messageId)) return;

    const messageDiv = ongoingStreams.get(messageId);
    const thinkingIndicator = messageDiv.querySelector('.thinking-indicator');
    const summary = thinkingIndicator?.querySelector('.reasoning-summary');
    const summaryTextEl = summary?.querySelector('.summary-text');

    const hasLogs = messageDiv.querySelector('.log-block, .tool-log-entry, .reasoning-thought-block');
    if (thinkingIndicator && hasLogs) {
        thinkingIndicator.classList.add('steps-done');
        const reasoningCount = messageDiv.querySelectorAll('.reasoning-thought-block').length;
        const logCount = messageDiv.querySelectorAll('.detailed-logs > .log-block:not(.reasoning-thought-block)').length;
        const toolLogCount = messageDiv.querySelectorAll('.tool-log-entry:not(.reasoning-log-entry)').length;

        let summaryText = "Reasoning: 0 thoughts, 0 tools, 0 agents";
        const parts = [];
        if (reasoningCount > 0) parts.push(`${reasoningCount} thought${reasoningCount > 1 ? 's' : ''}`);
        if (toolLogCount > 0) parts.push(`${toolLogCount} tool${toolLogCount > 1 ? 's' : ''}`);
        if (logCount > 0) parts.push(`${logCount} agent${logCount > 1 ? 's' : ''}`);
        if (parts.length > 0) {
            summaryText = `Reasoning: ${parts.join(', ')}`;
        }

        if (summary && summaryTextEl) {
            summaryTextEl.textContent = summaryText;
            summary.classList.remove('hidden');
        }
    } else if (thinkingIndicator) {
        thinkingIndicator.remove();
    }

    messageFormatter.finishStreaming(messageId);

    // Apply inline enhancements (Mermaid, syntax highlighting, etc.) after streaming completes
    const mainContent = messageDiv.querySelector('.message-content');
    if (mainContent && messageFormatter.applyInlineEnhancements) {
        console.log('[Chat] Applying inline enhancements after streaming complete');
        messageFormatter.applyInlineEnhancements(mainContent);
    }

    ongoingStreams.delete(messageId);
    activeRunRequest = null;
    stopRequested = false;
    sessionActive = false;

    // Mark run as completed so BackgroundRunManager doesn't trigger a notification
    // (user was online and saw the response live)
    try { backgroundRunManager.markRunCompleted(currentConversationId); } catch (_) { }

    // Restore send button to ready state (triangle → plane)
    updateSendButtonState();

    // Add message actions to bot message (Copy and Share only)
    if (window.messageActions && messageDiv) {
        window.messageActions.addActionsToMessage(messageDiv, messageId);
    }

    dispatchChatEvent('messageAdded', { role: 'assistant', messageId });
}

function extractConversationHistory() {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return '';

    const messageNodes = chatMessages.querySelectorAll('.message');
    let history = '';

    messageNodes.forEach(node => {
        if (node.classList.contains('message-error')) return;

        if (node.classList.contains('user-message')) {
            const raw = node.dataset.rawMessage || node.textContent || '';
            const trimmed = raw.trim();
            if (trimmed) {
                history += `User: ${trimmed}\n\n`;
            }
        } else if (node.classList.contains('bot-message')) {
            const mainContent = node.querySelector('.message-content');
            if (mainContent) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = mainContent.innerHTML;
                const text = tempDiv.textContent.trim();
                if (text) {
                    history += `Assistant: ${text}\n\n`;
                }
            }
        }
    });

    return history.trim();
}

function _extractLatestUserPrompt(rawText = '') {
    let value = (rawText || '').trim();
    if (!value) return '';

    const markers = [
        'CURRENT QUESTION:',
        'CURRENT MESSAGE:',
        'Current question:',
        'Current message:',
    ];
    for (const marker of markers) {
        const markerIndex = value.lastIndexOf(marker);
        if (markerIndex !== -1) {
            value = value.slice(markerIndex + marker.length).trim();
        }
    }
    return value;
}

function _parseSessionRuns(runs) {
    if (!Array.isArray(runs)) return [];
    return runs.filter((run) => run && !run.parent_run_id);
}

async function restoreConversationHistory(conversationId) {
    if (!conversationId) return false;

    try {
        const { data: sessionRow, error } = await supabase
            .from('agno_sessions')
            .select('runs')
            .eq('session_id', conversationId)
            .maybeSingle();

        if (error) {
            console.warn('[Chat] Failed to load session history for catch-up restore:', error);
            return false;
        }

        let runs = sessionRow?.runs || [];
        if (typeof runs === 'string') {
            try {
                runs = JSON.parse(runs);
            } catch (_) {
                runs = [];
            }
        }

        const topLevelRuns = _parseSessionRuns(runs);
        if (topLevelRuns.length === 0) {
            return false;
        }

        const messagesContainer = document.getElementById('chat-messages');
        if (!messagesContainer) return false;

        messagesContainer.replaceChildren();
        sentContexts.clear();
        ongoingStreams.clear();
        messageFormatter.pendingContent.clear();
        sessionActive = false;
        shouldResendWithHistory = false;

        topLevelRuns.forEach((run, index) => {
            const runRole = (run?.role || '').toLowerCase();
            const rawUserInput = run?.input?.input_content || (runRole === 'user' ? run?.content : '');
            const userInput = _extractLatestUserPrompt(rawUserInput || '');
            const assistantOutput = runRole === 'assistant' || !runRole
                ? (run?.content || '')
                : '';

            if (userInput) {
                addUserMessage(userInput);
            }

            if (assistantOutput && assistantOutput.trim()) {
                const historyMessageId = `history_${conversationId}_${index}_${Date.now()}`;
                createBotMessagePlaceholder(historyMessageId);
                populateBotMessage({
                    id: historyMessageId,
                    content: assistantOutput,
                    streaming: false,
                    agent_name: 'Aetheria_AI',
                    is_log: false,
                });
                handleDone({ id: historyMessageId });
            }
        });

        // Ensure per-session content badge state is refreshed for restored chat
        try { await chatModule.checkAndShowContentButton(); } catch (_) { }
        return true;
    } catch (e) {
        console.warn('[Chat] restoreConversationHistory failed:', e);
        return false;
    }
}

// ShuffleMenuController class removed - Electron-only feature, not needed for PWA

function setupSocketListeners() {
    if (socketListenersBound) return;
    socketListenersBound = true;

    socketService.on('connect', handleSocketConnect);
    socketService.on('disconnect', handleSocketDisconnect);

    socketService.on('response', (data) => {
        if (data.reasoning_content) {
            appendReasoningContent(data);
        }
        if (data.done) {
            handleDone(data);
        }
        if (data.content) {
            populateBotMessage(data);
        }
    });

    socketService.on('agent_step', handleAgentStep);
    socketService.on('reasoning_step', handleReasoningStep);
    socketService.on('status', handleStatusEvent);
    socketService.on('plan_response', handlePlanResponse);

    // --- Queued-Run System Handlers ---

    // run_status: server tells us whether a run is active, failed, or cancelled
    socketService.on('run_status', (data) => {
        const { status, messageId, conversationId } = data || {};
        if (conversationId && conversationId !== currentConversationId) {
            if (status === 'failed') {
                try { backgroundRunManager.markRunFailed(conversationId, GENERIC_FAILURE_MESSAGE); } catch (_) { }
            }
            return;
        }

        if (status === 'running') {
            if (messageId && !ongoingStreams.has(messageId)) {
                createBotMessagePlaceholder(messageId);
            }
            sessionActive = true;
            stopRequested = false;
            updateSendButtonState();
            console.log('[Chat] run_status: still running', conversationId, messageId);
            return;
        }

        if (status === 'failed') {
            handleRunFailure(messageId, activeRunRequest || getFallbackRetryRequest());
            return;
        }

        if (status === 'cancelled') {
            const messageDiv = getBotMessageElement(messageId);
            const visibleContent = messageDiv?.querySelector('.message-content')?.textContent?.trim()
                || messageDiv?.querySelector('.detailed-logs')?.textContent?.trim();

            if (visibleContent && messageId && ongoingStreams.has(messageId)) {
                handleDone({ id: messageId });
            } else if (messageDiv) {
                ongoingStreams.delete(messageId);
                messageDiv.remove();
            }

            try { backgroundRunManager.clearRun(conversationId || currentConversationId); } catch (_) { }
            shouldResendWithHistory = false;
            clearActiveRunState();
            resetUserInputState();
            dispatchChatEvent('chatStateChanged', { status: 'idle', conversationId: currentConversationId });
        }
    });

    // run_catchup: backend sends the completed response after we reconnect
    socketService.on('run_catchup', async (data) => {
        const { conversationId, messageId, content, events, title } = data || {};
        const replayEvents = Array.isArray(events) ? events : [];
        const hasContent = typeof content === 'string' ? content.length > 0 : !!content;
        if (!messageId || !conversationId || (!hasContent && replayEvents.length === 0)) return;

        // ── Deduplication ─────────────────────────────────────────────────
        // The same client can receive multiple run_catchup events if it
        // sends join_conversation more than once (reconnect race conditions).
        const dedupKey = `${conversationId}:${messageId}`;
        if (_renderedCatchups.has(dedupKey)) {
            console.log('[Chat] Catch-up already rendered, skipping duplicate', dedupKey);
            return;
        }
        _renderedCatchups.add(dedupKey);
        // Auto-expire after 30 s so re-opened fresh sessions work normally
        setTimeout(() => _renderedCatchups.delete(dedupKey), 30_000);

        // ── Cold-start / wrong conversation ───────────────────────────────
        // If the app was fully killed and a new conversation was started,
        // currentConversationId won't match.  We switch to the old conversation
        // so the user lands on the right chat instead of discarding the response.
        if (conversationId !== currentConversationId) {
            console.log('[Chat] Catch-up for a different conversation — switching to it:', conversationId);
            // Tell BackgroundRunManager the user missed this one → native notification
            try { backgroundRunManager.onBackgroundCatchupReceived(conversationId, title); } catch (_) { }
            // Switch current conversation (loads history via setCurrentConversationId)
            setCurrentConversationId(conversationId);
            await restoreConversationHistory(conversationId);
        }

        // ── Render the catch-up response ──────────────────────────────────
        if (replayEvents.length > 0) {
            renderTurnFromEvents(replayEvents, { messageId, autoScroll: true });
        } else {
            if (!ongoingStreams.has(messageId)) {
                createBotMessagePlaceholder(messageId);
            }
            populateBotMessage({
                id: messageId,
                content,
                streaming: false,
                agent_name: 'Aetheria_AI',
                is_log: false,
            });
            handleDone({ id: messageId });
        }

        // Tell BackgroundRunManager the user saw it (suppresses duplicate notification)
        try { backgroundRunManager.onCatchupRendered(conversationId, title); } catch (_) { }

        console.log('[Chat] Catch-up response rendered for', conversationId);
    });

    socketService.on('sandbox-command-finished', (data = {}) => {
        // Create terminal artifact button instead of inline terminal output
        if (data.execution_id) {
            const messageId = data.id || data.messageId;
            const messageDiv = messageId ? ongoingStreams.get(messageId) : null;

            if (!messageDiv) {
                console.warn('[Chat] Could not find message div for terminal artifact');
                return;
            }

            const logsContainer = messageDiv.querySelector('.detailed-logs');
            if (!logsContainer) return;

            // Create terminal artifact button
            const terminalBtn = document.createElement('div');
            terminalBtn.className = 'terminal-artifact-button';
            terminalBtn.dataset.executionId = data.execution_id;

            const exitCodeClass = data.exit_code === 0 ? 'success' : 'error';
            const commandPreview = (data.command || 'sandbox command').substring(0, 60);
            const commandDisplay = commandPreview.length < (data.command || '').length ? commandPreview + '...' : commandPreview;

            terminalBtn.innerHTML = `
                <div class="terminal-artifact-header">
                    <i class="fas fa-terminal terminal-artifact-icon"></i>
                    <span class="terminal-artifact-command">${commandDisplay}</span>
                    <span class="terminal-artifact-exit-code ${exitCodeClass}">
                        Exit: ${data.exit_code}
                    </span>
                </div>
            `;

            // Click handler to show terminal output
            terminalBtn.addEventListener('click', () => {
                const execution = socketService.getTerminalExecution(data.execution_id);
                if (!execution) {
                    console.warn('[Chat] No execution data found for:', data.execution_id);
                    return;
                }

                // Format terminal output
                let terminalContent = `$ ${execution.command}\n\n`;

                if (execution.stdout) {
                    terminalContent += execution.stdout;
                }

                if (execution.stderr) {
                    terminalContent += `\n\n--- STDERR ---\n${execution.stderr}`;
                }

                terminalContent += `\n\n--- Exit Code: ${execution.exitCode} ---`;

                // Show in artifact viewer
                artifactHandler.showArtifact(terminalContent, 'bash', null, `Terminal: ${execution.command.substring(0, 30)}`);
            });

            logsContainer.appendChild(terminalBtn);
            updateReasoningSummary(messageId);

            // Update content button after terminal command
            chatModule.checkAndShowContentButton();
        }
    });

    // NEW: Handle artifacts created event (comes after command finishes)
    socketService.on('sandbox-artifacts-created', (data = {}) => {
        console.log('[Chat] Received sandbox-artifacts-created event:', data);

        if (!data.artifacts || !Array.isArray(data.artifacts) || data.artifacts.length === 0) {
            console.log('[Chat] No artifacts in event');
            return;
        }

        const messageId = data.id || data.messageId;

        // Try to find the message div - it might be in ongoingStreams or already in DOM
        let messageDiv = messageId ? ongoingStreams.get(messageId) : null;

        // If not in ongoingStreams, search in DOM by message ID
        if (!messageDiv && messageId) {
            messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
        }

        if (!messageDiv) {
            console.warn('[Chat] Could not find message div for artifacts, messageId:', messageId);
            return;
        }

        const mainContent = messageDiv.querySelector('.message-content');
        if (!mainContent) {
            console.warn('[Chat] Could not find message-content in message div');
            return;
        }

        // Check if artifacts container already exists (avoid duplicates)
        let artifactsContainer = mainContent.querySelector('.sandbox-artifacts-container');
        if (!artifactsContainer) {
            artifactsContainer = document.createElement('div');
            artifactsContainer.className = 'sandbox-artifacts-container';
            artifactsContainer.style.cssText = 'margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px;';
            mainContent.appendChild(artifactsContainer);
        }

        // Create button for each artifact
        data.artifacts.forEach(artifact => {
            const artifactBtn = document.createElement('button');
            artifactBtn.className = 'artifact-file-button';
            artifactBtn.style.cssText = `
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-color);
                transition: all 0.2s;
            `;

            // Format file size
            const formatSize = (bytes) => {
                if (bytes < 1024) return bytes + ' B';
                if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
                return (bytes / 1024 / 1024).toFixed(1) + ' MB';
            };

            artifactBtn.innerHTML = `
                <i class="fas fa-file" style="color: var(--accent-color);"></i>
                <span>${artifact.filename}</span>
                <span style="color: var(--text-secondary); font-size: 12px;">${formatSize(artifact.size_bytes)}</span>
            `;

            // Add hover effect
            artifactBtn.addEventListener('mouseenter', () => {
                artifactBtn.style.background = 'var(--hover-bg)';
                artifactBtn.style.borderColor = 'var(--accent-color)';
            });
            artifactBtn.addEventListener('mouseleave', () => {
                artifactBtn.style.background = 'var(--card-bg)';
                artifactBtn.style.borderColor = 'var(--border-color)';
            });

            // Click handler to view/download artifact
            artifactBtn.addEventListener('click', async () => {
                try {
                    console.log('[Chat] Fetching artifact:', artifact.artifact_id);

                    // Check cache first
                    const cachedMetadata = await artifactCache.getMetadata(artifact.artifact_id);
                    const cachedContent = await artifactCache.getContent(artifact.artifact_id);

                    let artifactData;
                    let contentText;

                    if (cachedMetadata && cachedContent) {
                        console.log('[Chat] Using cached artifact data');
                        artifactData = cachedMetadata;
                        contentText = cachedContent;
                    } else {
                        console.log('[Chat] Fetching artifact from server');

                        // Get auth token
                        const { data: { session } } = await supabase.auth.getSession();
                        if (!session) {
                            throw new Error('Not authenticated');
                        }

                        // Fetch artifact details with download URL
                        const response = await fetch(`${config.backend.url}/api/sandbox/artifacts/${artifact.artifact_id}`, {
                            headers: {
                                'Authorization': `Bearer ${session.access_token}`
                            }
                        });

                        if (!response.ok) {
                            throw new Error('Failed to fetch artifact');
                        }

                        const result = await response.json();
                        artifactData = result.artifact;

                        console.log('[Chat] Artifact data:', artifactData);

                        // Fetch file content
                        const contentResponse = await fetch(artifactData.download_url);
                        contentText = await contentResponse.text();

                        // Cache metadata and content
                        await artifactCache.setMetadata(artifact.artifact_id, artifactData);
                        await artifactCache.setContent(artifact.artifact_id, contentText);
                        console.log('[Chat] Artifact cached successfully');
                    }

                    // Determine language from mime type or filename
                    let language = 'plaintext';
                    const ext = artifact.filename.split('.').pop().toLowerCase();
                    const langMap = {
                        'py': 'python', 'js': 'javascript', 'ts': 'typescript',
                        'html': 'html', 'css': 'css', 'json': 'json',
                        'md': 'markdown', 'sh': 'bash', 'txt': 'plaintext',
                        'java': 'java', 'cpp': 'cpp', 'c': 'c', 'go': 'go',
                        'rs': 'rust', 'rb': 'ruby', 'php': 'php'
                    };
                    language = langMap[ext] || 'plaintext';

                    console.log('[Chat] Showing artifact in viewer, language:', language, 'filename:', artifact.filename);

                    // Show in artifact viewer with filename
                    artifactHandler.showArtifact(contentText, language, null, artifact.filename);

                } catch (error) {
                    console.error('[Chat] Error loading artifact:', error);
                    chatModule.showNotification('Failed to load file', 'error');
                }
            });

            artifactsContainer.appendChild(artifactBtn);
        });

        console.log('[Chat] Created', data.artifacts.length, 'artifact buttons');

        // Update content button after artifacts are created
        chatModule.checkAndShowContentButton();
    });

    socketService.on('image_generated', handleImageGenerated);

    // Browser screenshot events -> delegated to dedicated module
    socketService.on('browser_screenshot', (data) => browserScreenshotViewer.handleScreenshot(data));

    socketService.on('error', (err) => {
        console.error('Socket error:', err);
        if (err?.code === 'subscription_limit_exceeded') {
            chatModule.showNotification(err.message || 'Usage limit reached. Upgrade to continue.', 'warning', 5000);
            shouldResendWithHistory = false;
            clearActiveRunState();
            resetUserInputState();
            dispatchChatEvent('subscriptionLimitExceeded', {
                message: err.message || '',
                limitInfo: err.limit_info || null,
            });
            dispatchChatEvent('chatStateChanged', { status: 'error', conversationId: currentConversationId });
            return;
        }

        if (stopRequested) {
            return;
        }

        handleRunFailure(err?.messageId || activeRunRequest?.messageId, activeRunRequest || getFallbackRetryRequest());
    });
}

function handleImageGenerated(data = {}) {
    const messageId = data.id || data.messageId;
    const imageBase64 = data.image_base64 || data.base64;
    if (!imageBase64) {
        return;
    }

    const mimeType = data.mime_type || 'image/png';
    const dataUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:${mimeType};base64,${imageBase64}`;
    const artifactId = artifactHandler.createArtifact(dataUrl, 'image', data.artifactId);

    const messageDiv = messageId ? ongoingStreams.get(messageId) : null;
    if (messageDiv) {
        const mainContent = messageDiv.querySelector('.message-content');
        if (mainContent && !mainContent.querySelector(`[data-artifact-ref="${artifactId}"]`)) {
            const artifactBlock = document.createElement('div');
            artifactBlock.className = 'content-block artifact-block';
            artifactBlock.dataset.artifactRef = artifactId;
            artifactBlock.innerHTML = `
                <div class="content-block-header">
                    <i class="fas fa-image"></i>
                    <span>Generated Image</span>
                </div>
                <div class="inner-content">
                    <img src="${dataUrl}" alt="Generated artifact" class="generated-image-preview" loading="lazy" />
                    <div class="artifact-actions">
                        <button class="artifact-reference" data-artifact-id="${artifactId}">
                            <i class="fas fa-up-right-from-square"></i>
                            View full size
                        </button>
                    </div>
                </div>
            `;
            mainContent.appendChild(artifactBlock);
        }

        const logsContainer = messageDiv.querySelector('.detailed-logs');
        if (logsContainer && !logsContainer.querySelector(`[data-artifact-ref="${artifactId}"]`)) {
            const logEntry = document.createElement('div');
            logEntry.className = 'tool-log-entry image-artifact-log';
            logEntry.dataset.artifactRef = artifactId;
            logEntry.innerHTML = `
                <i class="fas fa-palette tool-log-icon"></i>
                <div class="tool-log-details">
                    <span class="tool-log-action"><strong>Generated an image artifact</strong></span>
                </div>
                <button class="artifact-reference compact" data-artifact-id="${artifactId}" title="Open image artifact">
                    <i class="fas fa-up-right-from-square"></i>
                    Open
                </button>
            `;
            logsContainer.appendChild(logEntry);
            updateReasoningSummary(messageId);
        }

        messageDiv.classList.add('expanded');
    } else {
        notificationService?.show('Generated image is ready in the artifact viewer.', 'info', 6000);
    }
}

// Browser screenshot functions moved to js/browser-screenshot-viewer.js

export const chatModule = {
    init(contextHandlerInstance, fileAttachmentHandlerInstance, contextViewerInstance) {
        contextHandler = contextHandlerInstance || contextHandler;
        if (!contextHandler) {
            throw new Error('chatModule.init requires a contextHandler instance');
        }
        contextViewer = contextViewerInstance || contextViewer || null;

        if (fileAttachmentHandlerInstance) {
            fileAttachmentHandler = fileAttachmentHandlerInstance;
        } else if (!fileAttachmentHandler) {
            fileAttachmentHandler = new FileAttachmentHandler();
        }

        const inputContainer = document.getElementById('floating-input-container') || document.querySelector('.floating-input-container');
        const chatContainer = document.getElementById('chat-messages') || document.querySelector('.chat-messages');
        const welcomeContainer = document.querySelector('.welcome-container');

        notificationService = new NotificationService();

        welcomeDisplay = new WelcomeDisplay({
            element: welcomeContainer,
            messageContainer: chatContainer,
        });
        welcomeDisplay.initialize();

        if (!conversationStateManager) {
            conversationStateManager = new ConversationStateManager({ inputContainer });
        } else {
            conversationStateManager.updateInputContainer?.(inputContainer);
        }
        conversationStateManager.init?.();

        if (!floatingWindowManager) {
            floatingWindowManager = new FloatingWindowManager(welcomeDisplay);
        } else {
            floatingWindowManager.setWelcomeDisplay?.(welcomeDisplay);
        }
        window.floatingWindowManager = floatingWindowManager;

        if (contextHandler?.elements?.contextWindow) {
            floatingWindowManager.registerWindow('context', contextHandler.elements.contextWindow);
        }

        const toDoListContainer = document.getElementById('to-do-list-container');
        if (toDoListContainer) {
            floatingWindowManager.registerWindow('tasks', toDoListContainer);
        }
        const aiosSettings = document.getElementById('aios-settings-window') || document.getElementById('floating-window');
        if (aiosSettings) {
            floatingWindowManager.registerWindow('aios-settings', aiosSettings);
        }

        window.conversationStateManager = conversationStateManager;

        // ShuffleMenuController initialization removed - Electron-only feature

        socketService.init();
        setupSocketListeners();
        setupPlanModeControls();

        // Initialize BackgroundRunManager — lifecycle tracking + native notifications
        // Rendering is done exclusively inside the run_catchup socket handler above.
        try {
            backgroundRunManager.init(
                // onCompleted: optional hook (run_catchup socket event does the actual render)
                (conversationId) => {
                    console.log('[Chat] BRM onCompleted:', conversationId);
                },
                // onFailed: optional hook — native notification is already sent by BRM
                (conversationId, error) => {
                    console.warn('[Chat] BRM onFailed:', conversationId, error);
                }
            );
        } catch (e) {
            console.warn('[Chat] BackgroundRunManager init error (non-critical):', e);
        }

        console.log('Chat module initialized for PWA.');


        unifiedPreviewHandler = new UnifiedPreviewHandler(contextHandler, fileAttachmentHandler);
        window.unifiedPreviewHandler = unifiedPreviewHandler;

        this.startNewConversation();

        // Preload sessions in background for instant context window display
        if (contextHandler && typeof contextHandler.preloadSessions === 'function') {
            contextHandler.preloadSessions();
        }

        // Periodic cleanup of expired cache entries (every 10 minutes)
        setInterval(() => {
            artifactCache.clearExpired().catch(err => {
                console.error('[Chat] Failed to clear expired cache:', err);
            });
        }, 10 * 60 * 1000);

        // Log cache stats on init
        artifactCache.getStats().then(stats => {
            console.log('[Chat] Artifact cache initialized:', stats);
        });

        // Setup view content button
        this.setupViewContentButton();
    },

    setupViewContentButton() {
        const viewContentBtn = document.getElementById('view-content-btn');
        if (!viewContentBtn) return;

        viewContentBtn.addEventListener('click', () => {
            if (currentConversationId) {
                sessionContentViewer.show(currentConversationId);
            }
        });
    },

    async checkAndShowContentButton() {
        // Check if current conversation has any content
        if (!currentConversationId) {
            console.log('[Chat] No current conversation ID, hiding content button');
            return;
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                console.log('[Chat] No auth session, hiding content button');
                return;
            }

            const url = `${config.backend.url}/api/sessions/${currentConversationId}/content`;
            console.log('[Chat] Checking content at:', url);

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const count = data.count || 0;

                console.log('[Chat] Content count:', count);

                const viewContentBtn = document.getElementById('view-content-btn');
                const contentBadge = document.getElementById('content-count-badge');

                if (count > 0) {
                    console.log('[Chat] Showing content button with count:', count);
                    viewContentBtn?.classList.remove('hidden');
                    if (contentBadge) {
                        contentBadge.textContent = count;
                        contentBadge.classList.remove('hidden');
                    }
                } else {
                    console.log('[Chat] No content, hiding button');
                    viewContentBtn?.classList.add('hidden');
                    contentBadge?.classList.add('hidden');
                }
            } else {
                console.error('[Chat] Failed to check content:', response.status, response.statusText);
            }
        } catch (error) {
            console.error('[Chat] Error checking content:', error);
        }
    },

    startNewConversation({ preserveAgentType = true } = {}) {
        const messagesContainer = document.getElementById('chat-messages');
        messagesContainer?.replaceChildren();

        const nextConversationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `conv_${Date.now()}`;
        setCurrentConversationId(nextConversationId);

        sentContexts.clear();
        ongoingStreams.clear();
        pendingSendQueue.length = 0;
        activeRunRequest = null;
        activePlanRequest = null;
        stopRequested = false;
        sessionActive = false;
        planGenerationActive = false;
        shouldResendWithHistory = false;
        messageFormatter.pendingContent.clear();
        _renderedSheetsPreviews.clear();
        _openedSheetsArtifacts.clear();

        contextHandler?.clearSelectedContext?.();
        contextHandler?.invalidateCache?.(); // Invalidate session cache for fresh data
        fileAttachmentHandler?.clearAttachedFiles?.();
        window.todo?.toggleWindow(false);

        // Clear artifact cache on new conversation
        artifactCache.clearAll().catch(err => {
            console.error('[Chat] Failed to clear artifact cache:', err);
        });

        // Clear terminal execution data
        socketService.clearTerminalExecutions();

        // Clear browser screenshots (delegated to module)
        browserScreenshotViewer.clear();

        // Hide content button for new conversation
        const viewContentBtn = document.getElementById('view-content-btn');
        const contentBadge = document.getElementById('content-count-badge');
        viewContentBtn?.classList.add('hidden');
        contentBadge?.classList.add('hidden');

        resetUserInputState();

        if (!preserveAgentType) {
            this.setAgentType('aios');
        }

        this.setMemoryEnabled(true);
        this.setTasksVisibility(false);

        conversationStateManager?.onConversationCleared();
        welcomeDisplay?.show();

        const bottomNavBtns = document.querySelectorAll('.bottom-nav-btn');
        bottomNavBtns.forEach(btn => btn.classList.remove('active'));

        dispatchChatEvent('conversationCleared', { conversationId: currentConversationId });
        dispatchChatEvent('chatStateChanged', { status: 'idle', conversationId: currentConversationId });
    },

    async handleSendMessage(isMemoryEnabled = undefined, agentType = undefined, options = {}) {
        const input = document.getElementById('floating-input');
        const messageOverride = typeof options?.messageOverride === 'string' ? options.messageOverride.trim() : '';
        const isProgrammaticSend = messageOverride.length > 0;
        const message = isProgrammaticSend ? messageOverride : input.value.trim();
        const includeAttachedFiles = options?.includeAttachedFiles !== false;
        const includeSelectedSessions = options?.includeSelectedSessions !== false;
        const attachedFiles = Array.isArray(options?.attachedFilesOverride)
            ? cloneAttachedFiles(options.attachedFilesOverride)
            : (includeAttachedFiles ? cloneAttachedFiles(fileAttachmentHandler.getAttachedFiles()) : []);
        const selectedSessions = Array.isArray(options?.selectedSessionsOverride)
            ? cloneSelectedSessions(options.selectedSessionsOverride)
            : (includeSelectedSessions ? cloneSelectedSessions(contextHandler.getSelectedSessions()) : []);
        const skipUserMessage = options?.skipUserMessage === true;
        const hasMessagePayload = message.length > 0 || attachedFiles.length > 0 || selectedSessions.length > 0;
        const shouldLockSend = !isProgrammaticSend && !skipUserMessage;

        if (shouldLockSend) {
            if (sendSubmissionLocked) return;
            sendSubmissionLocked = true;
        }

        try {
            if (typeof isMemoryEnabled === 'boolean') {
                this.setMemoryEnabled(isMemoryEnabled);
            }
            if (typeof agentType === 'string') {
                this.setAgentType(agentType);
            }
            if (!hasMessagePayload || sessionActive) {
                if (sessionActive && notificationService) {
                    notificationService.show('Please wait for the current response to finish.', 'warning');
                }
                return;
            }

            if (planGenerationActive) {
                notificationService?.show('Plan Mode is already preparing a plan.', 'warning');
                return;
            }

            if (planModeActive && !isProgrammaticSend && !skipUserMessage) {
                await startPlanRequest({ message, attachedFiles, selectedSessions });
                return;
            }

            if (!isSocketConnected) {
                if (!skipUserMessage && hasMessagePayload) {
                    addUserMessage(message || 'Attached context', attachedFiles, selectedSessions);
                }

                if (!isProgrammaticSend) {
                    input.value = '';
                    requestAnimationFrame(() => {
                        input.style.height = 'auto';
                    });
                    input.focus();
                }

                queuePendingMessageForSend({
                    isMemoryEnabled: typeof isMemoryEnabled === 'boolean' ? isMemoryEnabled : undefined,
                    agentType: typeof agentType === 'string' ? agentType : undefined,
                    message,
                    attachedFiles,
                    selectedSessions,
                });

                if (!Array.isArray(options?.attachedFilesOverride) && includeAttachedFiles) {
                    fileAttachmentHandler.clearAttachedFiles();
                }
                if (!Array.isArray(options?.selectedSessionsOverride) && includeSelectedSessions) {
                    contextHandler.clearSelectedContext();
                }

                notificationService?.show('Message queued. It will send automatically when connection is restored.', 'info', 3500);
                return;
            }
        } finally {
            if (shouldLockSend) {
                setTimeout(() => {
                    sendSubmissionLocked = false;
                }, 400);
            }
        }

        try {
            await backgroundRunManager.ensureNotificationPermission({ forcePrompt: true });
        } catch (_) { }

        sessionActive = true;
        stopRequested = false;
        updateSendButtonState();

        if (!skipUserMessage && hasMessagePayload) {
            addUserMessage(message || 'Attached context', attachedFiles, selectedSessions);
        }

        if (!isProgrammaticSend) {
            input.value = '';
            requestAnimationFrame(() => {
                input.style.height = 'auto';
            });
            input.focus();
        }

        const messageId = `msg_${Date.now()}`;
        createBotMessagePlaceholder(messageId);

        activeRunRequest = {
            messageId,
            conversationId: currentConversationId,
            message,
            attachedFiles: cloneAttachedFiles(attachedFiles),
            selectedSessions: cloneSelectedSessions(selectedSessions),
        };

        const payload = {
            id: messageId,
            conversationId: currentConversationId,
            message,
            config: buildOutgoingAgentConfig(),
            is_deepsearch: selectedAgentType === 'deepsearch',
        };

        if (window.projectWorkspace?.isActive?.()) {
            payload.agent_mode = 'coder';
            payload.config.agent_mode = 'coder';
        }

        if (shouldResendWithHistory) {
            const history = extractConversationHistory();
            if (history) {
                payload.message = `PREVIOUS CONVERSATION (Recovered after error):
---
${history}
---

CURRENT MESSAGE:
${message}`;
            }
            shouldResendWithHistory = false;
        }

        if (selectedSessions.length > 0) {
            payload.context_session_ids = selectedSessions.map(session => session.session_id);
        }

        if (attachedFiles.length > 0) {
            const backendSupportedFiles = [];
            const unsupportedTextFiles = [];
            const binaryDocumentFiles = [];

            attachedFiles.forEach(f => {
                const isBinaryDoc = f.type.includes('word') || f.type.includes('excel') ||
                    f.type.includes('powerpoint') || f.type.includes('document') ||
                    f.type.includes('spreadsheet') || f.type.includes('presentation') ||
                    f.type.includes('msword') || f.type.includes('ms-excel') ||
                    f.type.includes('ms-powerpoint') || f.type.includes('officedocument');

                const isMediaFile = f.type.startsWith('image/') || f.type.startsWith('audio/') || f.type.startsWith('video/');

                if (isBinaryDoc && f.path) {
                    binaryDocumentFiles.push({
                        name: f.name,
                        type: f.type,
                        path: f.path,
                        isText: false
                    });
                } else if (isMediaFile && f.path) {
                    backendSupportedFiles.push({
                        name: f.name,
                        type: f.type,
                        path: f.path,
                        isText: false
                    });
                } else if (f.isBackendSupported && (f.path || f.content)) {
                    backendSupportedFiles.push({
                        name: f.name,
                        type: f.backendMimeType || f.type,
                        path: f.path,
                        content: f.content,
                        isText: f.isText
                    });
                } else if (f.isText && f.content) {
                    unsupportedTextFiles.push({
                        name: f.name,
                        content: f.content
                    });
                }
            });

            const allBackendFiles = [...backendSupportedFiles, ...binaryDocumentFiles];
            if (allBackendFiles.length > 0) {
                payload.files = allBackendFiles;
            }

            if (unsupportedTextFiles.length > 0) {
                let fileContentsText = '\n\n--- Attached Files ---\n';
                unsupportedTextFiles.forEach(file => {
                    fileContentsText += `\n### File: ${file.name}\n\`\`\`\n${file.content}\n\`\`\`\n`;
                });
                payload.message = (payload.message || '') + fileContentsText;
            }
        }

        try {
            await socketService.sendMessage(payload);
            try { backgroundRunManager.markRunStarted(currentConversationId, messageId, null); } catch (_) { }
            if (!Array.isArray(options?.attachedFilesOverride) && includeAttachedFiles) {
                fileAttachmentHandler.clearAttachedFiles();
            }
            if (!Array.isArray(options?.selectedSessionsOverride) && includeSelectedSessions) {
                contextHandler.clearSelectedContext();
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            handleRunFailure(messageId, activeRunRequest);
        }
    },

    async stopCurrentResponse() {
        if (!sessionActive || stopRequested || !currentConversationId) {
            return;
        }

        stopRequested = true;
        updateSendButtonState();

        try {
            await socketService.terminateConversation(currentConversationId, activeRunRequest?.messageId || null);
        } catch (error) {
            console.error('[Chat] Failed to stop current response:', error);
            stopRequested = false;
            handleRunFailure(activeRunRequest?.messageId, activeRunRequest || getFallbackRetryRequest());
        }
    },

    isSessionActive() {
        return sessionActive;
    },

    clearChat() {
        if (sessionActive) {
            socketService.terminateConversation(currentConversationId, activeRunRequest?.messageId || null)
                .catch((e) => {
                    console.warn('Could not send terminate message, socket may be disconnected.', e.message);
                });
        }

        this.startNewConversation();
    },

    showNotification(message, type = 'info', duration = 3000) {
        if (notificationService) {
            notificationService.show(message, type, duration);
            return;
        }
        const container = document.querySelector('.notification-container');
        if (!container) return;
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        container.appendChild(notification);
        notificationService.removeNotification(notification);
    },

    getFloatingWindowManager() {
        return floatingWindowManager;
    },

    registerFloatingWindow(windowId, element, options = {}) {
        if (!floatingWindowManager || !windowId || !element) return false;
        return floatingWindowManager.registerWindow(windowId, element, options);
    },

    setMemoryEnabled(enabled) {
        const next = !!enabled;
        if (chatConfig.memory === next) {
            return;
        }

        chatConfig.memory = next;
        dispatchChatEvent('memoryToggle', { enabled: next });
        if (notificationService) {
            notificationService.show(`Memory is now ${next ? 'ON' : 'OFF'}.`, 'info');
        }
    },

    setAgentType(type) {
        const previousType = selectedAgentType;
        selectedAgentType = type === 'deepsearch' ? 'deepsearch' : 'aios';
        if (previousType === selectedAgentType) {
            return;
        }

        chatConfig.deepsearch = selectedAgentType === 'deepsearch';
        if (selectedAgentType === 'deepsearch') {
            Object.keys(chatConfig.tools).forEach(key => {
                chatConfig.tools[key] = false;
            });
        } else {
            Object.assign(chatConfig.tools, defaultToolsConfig);
        }
        dispatchChatEvent('agentTypeChanged', { agentType: selectedAgentType });
        if (notificationService) {
            notificationService.show(`Agent switched to ${selectedAgentType.toUpperCase()}.`, 'info');
        }
        chatModule.startNewConversation({ preserveAgentType: true });
    },

    setTasksVisibility(isOpen, options = {}) {
        const next = !!isOpen;
        chatConfig.tasks = next;
        dispatchChatEvent('tasksToggle', { open: next });

        if (options.source === 'shuffle') {
            window.todo?.toggleWindow(next);
        }
    },

    getConfig() {
        return {
            ...chatConfig,
            selectedAgentType,
        };
    },
    getSentContext(contextId) {
        if (!contextId || !sentContexts.has(contextId)) {
            return null;
        }

        const context = sentContexts.get(contextId) || {};
        return {
            files: cloneAttachedFiles(context.files || []),
            sessions: cloneSelectedSessions(context.sessions || []),
        };
    },
    getCurrentConversationTitle() {
        const pastSessionTitle = document.querySelector('#chat-messages .past-session-title')?.textContent?.trim();
        if (pastSessionTitle) {
            return pastSessionTitle;
        }

        if (!currentConversationId) {
            return null;
        }

        const cachedTitle = contextHandler?.getSessionTitleById?.(currentConversationId);
        if (cachedTitle && typeof cachedTitle === 'string' && cachedTitle.trim()) {
            return cachedTitle.trim();
        }

        return null;
    },
    getCurrentConversationId() {
        return currentConversationId;
    },
    async sendProjectWorkspaceCommand(message) {
        if (!message || !String(message).trim()) {
            throw new Error('A workspace command is required.');
        }
        return this.handleSendMessage(undefined, undefined, {
            messageOverride: String(message),
            includeAttachedFiles: false,
            includeSelectedSessions: false,
        });
    },
    renderTurnFromEvents,
};
