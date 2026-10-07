import { backendRequest } from './backend-api.js';
import { QuestionCards } from './question-cards.js';
// js/chat.js (PWA/Mobile Version - Adapted from Desktop Logic)

import { messageFormatter } from './message-formatter.js';
import { socketService } from './socket-service.js';
import ConversationStateManager from './conversation-state-manager.js';
import FloatingWindowManager from './floating-window-manager.js';
import NotificationService from './notification-service.js';
import WelcomeDisplay from './welcome-display.js';
import UnifiedPreviewHandler from './unified-preview-handler.js';
import ContextHandler from './context-handler.js';
import FileAttachmentHandler, { isVideoAttachment } from './add-files.js';
import { artifactHandler } from './artifact-handler.js';
import messageActions from './message-actions.js';
import { supabase } from './supabase-client.js';
import { config } from './config.js';
import { artifactCache } from './artifact-cache.js';
import { sessionContentViewer } from './session-content-viewer.js';
import browserScreenshotViewer from './browser-screenshot-viewer.js';
import backgroundRunManager from './background-run-manager.js';
import { contentSecurity } from './security-utils.js';
import {
    destroyThinkingOrbs,
    mountThinkingOrbs,
    setThinkingOrbsPaused,
} from './thinking-orb.js';
import {
    getSelectedPresentationTemplate,
    clearSelectedPresentationTemplate,
    isPresentationRequest,
    buildPresentationTemplateInstruction
} from './presentation-templates.js';

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
    enable_composio_whatsapp: true,
    enable_composio_facebook: true,
    enable_composio_instagram: true,
    enable_composio_youtube: true,
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
const pendingSendQueue = [];
const pendingAnswerSubmissions = new Map();
const questionsByConversation = new Map();
const questionCards = new QuestionCards({
    submit: async payload => {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingAnswerSubmissions.delete(payload.requestId);
                reject(new Error('No confirmation received. You can retry safely.'));
            }, 15000);
            pendingAnswerSubmissions.set(payload.requestId, { resolve, reject, timer });
            socketService.submitUserAnswers(payload).catch(error => {
                clearTimeout(timer);
                pendingAnswerSubmissions.delete(payload.requestId);
                reject(error);
            });
        });
    },
    cancel: request => socketService.terminateConversation(request.conversationId, request.id),
    onTerminal: request => {
        questionsByConversation.delete(request.conversationId);
        if (request.conversationId !== currentConversationId) return;
        welcomeDisplay?.hide();
        conversationStateManager?.onMessageAdded();
        if (request.channel === 'plan') {
            setPlanGenerating(false);
            pendingPlanRequestId = null;
            pendingPlanMessageId = null;
        }
        handleDone({ id: request.id });
    },
});

let planModeEnabled = false;
const THINKING_MODE_STANDARD = 'standard';
const THINKING_MODE_ULTRA = 'ultra';
const CONVERSATION_ROUTE_VIDEO = 'video';
const CONVERSATION_ROUTE_ULTRA = 'ultra';
const conversationModelRoutes = new Map();
let thinkingMode = THINKING_MODE_STANDARD;
let planGenerationInProgress = false;
let pendingPlanRequestId = null;
let pendingPlanMessageId = null;
let submittingApprovedPlan = false;
let pendingPlanSubmitDisplayMessage = null;
const planStreamBuffers = new Map();
const planRenderStates = new Map();
const planReasoningBuffers = new Map();
const planReasoningRenderStates = new Map();

const GENERIC_FAILURE_MESSAGE = 'The request failed. Please try again.';

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
    const knownRoute = conversationModelRoutes.get(nextId);
    thinkingMode = knownRoute === CONVERSATION_ROUTE_ULTRA
        ? THINKING_MODE_ULTRA
        : THINKING_MODE_STANDARD;
    syncUltraThinkControl();
    syncComposerModeVisual();
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

function getCurrentConversationRoute() {
    return conversationModelRoutes.get(currentConversationId) || null;
}

function getEffectiveThinkingMode(requestedMode = thinkingMode) {
    const route = getCurrentConversationRoute();
    if (route === CONVERSATION_ROUTE_ULTRA) return THINKING_MODE_ULTRA;
    if (route === CONVERSATION_ROUTE_VIDEO) return THINKING_MODE_STANDARD;
    return requestedMode === THINKING_MODE_ULTRA ? THINKING_MODE_ULTRA : THINKING_MODE_STANDARD;
}

function attachmentsIncludeVideo(files = []) {
    return Array.isArray(files) && files.some(isVideoAttachment);
}

function getComposerVisualMode() {
    const ultraEnabled = getEffectiveThinkingMode() === THINKING_MODE_ULTRA;
    if (planModeEnabled && ultraEnabled) return 'plan-ultra';
    if (planModeEnabled) return 'plan';
    if (ultraEnabled) return 'ultra';
    return 'standard';
}

function syncComposerModeVisual() {
    const inputContainer = document.getElementById('floating-input-container');
    if (!inputContainer) return;
    inputContainer.dataset.composerMode = getComposerVisualMode();
}

function syncUltraThinkControl() {
    const button = document.getElementById('ultra-think-btn');
    if (!button) return;

    const route = getCurrentConversationRoute();
    const hasVideo = Boolean(fileAttachmentHandler?.hasAttachedVideo?.());
    const routeLocked = route === CONVERSATION_ROUTE_ULTRA || route === CONVERSATION_ROUTE_VIDEO;
    const unavailable = route === CONVERSATION_ROUTE_VIDEO || (!routeLocked && hasVideo);
    const active = getEffectiveThinkingMode() === THINKING_MODE_ULTRA;

    button.classList.toggle('active', active);
    button.classList.toggle('is-locked', routeLocked);
    button.classList.toggle('is-unavailable', unavailable);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.setAttribute('aria-disabled', routeLocked || unavailable ? 'true' : 'false');

    if (route === CONVERSATION_ROUTE_ULTRA) {
        button.title = 'Ultra Think is locked for this conversation';
        button.setAttribute('aria-label', 'Ultra Think, active and locked for this conversation');
    } else if (route === CONVERSATION_ROUTE_VIDEO) {
        button.title = 'This conversation is locked to video input mode';
        button.setAttribute('aria-label', 'Ultra Think unavailable, conversation locked to video input mode');
    } else if (hasVideo) {
        button.title = 'Remove video attachments to use Ultra Think';
        button.setAttribute('aria-label', 'Ultra Think unavailable while a video is attached');
    } else {
        button.title = active ? 'Disable Ultra Think' : 'Enable Ultra Think';
        button.setAttribute('aria-label', active ? 'Disable Ultra Think' : 'Enable Ultra Think');
    }
}

function setThinkingMode(nextMode) {
    thinkingMode = nextMode === THINKING_MODE_ULTRA
        ? THINKING_MODE_ULTRA
        : THINKING_MODE_STANDARD;
    syncUltraThinkControl();
    syncComposerModeVisual();
}

function markConversationRouteForTurn(mode, files = []) {
    if (!currentConversationId || getCurrentConversationRoute()) return;
    if (mode === THINKING_MODE_ULTRA) {
        conversationModelRoutes.set(currentConversationId, CONVERSATION_ROUTE_ULTRA);
        thinkingMode = THINKING_MODE_ULTRA;
    } else if (attachmentsIncludeVideo(files)) {
        conversationModelRoutes.set(currentConversationId, CONVERSATION_ROUTE_VIDEO);
        thinkingMode = THINKING_MODE_STANDARD;
    }
    syncUltraThinkControl();
    syncComposerModeVisual();
}

function applyRoutingErrorState(code) {
    if (!currentConversationId) return;
    if (code === 'conversation_model_locked_to_video') {
        conversationModelRoutes.set(currentConversationId, CONVERSATION_ROUTE_VIDEO);
        thinkingMode = THINKING_MODE_STANDARD;
    } else if (code === 'conversation_model_locked_to_ultra') {
        conversationModelRoutes.set(currentConversationId, CONVERSATION_ROUTE_ULTRA);
        thinkingMode = THINKING_MODE_ULTRA;
    } else if (code === 'ultra_video_not_supported') {
        conversationModelRoutes.delete(currentConversationId);
    }
    syncUltraThinkControl();
    syncComposerModeVisual();
}

function validateAttachmentForCurrentMode(file) {
    if (!isVideoAttachment(file)) return { valid: true };
    if (getEffectiveThinkingMode() === THINKING_MODE_ULTRA) {
        return {
            valid: false,
            message: 'Video attachments are unavailable in Ultra Think mode.',
        };
    }
    return { valid: true };
}

function getComposerVoiceState() {
    return window.voiceInputHandler?.getState?.() || {};
}

function hasComposerPayload() {
    const input = document.getElementById('floating-input');
    const hasText = Boolean(input?.value?.trim());
    const hasFiles = Boolean(fileAttachmentHandler?.attachedFiles?.length);
    const hasContext = Boolean(contextHandler?.getSelectedSessions?.()?.length);
    return hasText || hasFiles || hasContext;
}

function updateSendButtonState() {
    const sendBtn = document.getElementById('send-message');
    const dictationBtn = document.getElementById('voice-input-btn');
    if (!sendBtn) return;

    const voiceState = getComposerVoiceState();
    const intelligentActive = Boolean(
        voiceState.intelligentListening ||
        voiceState.intelligentStopping ||
        voiceState.intelligentProcessing
    );
    const dictationActive = Boolean(voiceState.dictationListening || voiceState.dictationStopping);

    sendBtn.classList.remove(
        'smart-voice-ready',
        'smart-voice-listening',
        'smart-voice-processing',
        'smart-voice-unavailable',
        'send-ready',
        'sending',
        'plan-generating'
    );
    sendBtn.disabled = false;

    if (dictationBtn) {
        dictationBtn.disabled = voiceState.dictationSupported === false || planGenerationInProgress || intelligentActive || voiceState.dictationStopping;
    }

    if (planGenerationInProgress) {
        sendBtn.disabled = true;
        sendBtn.classList.add('plan-generating');
        sendBtn.dataset.action = 'none';
        sendBtn.setAttribute('aria-label', 'Generating plan');
        sendBtn.setAttribute('title', 'Generating plan');
        return;
    }

    if (sessionActive) {
        sendBtn.classList.add('sending');
        sendBtn.dataset.action = 'stop-response';
        sendBtn.disabled = false;
        sendBtn.setAttribute('aria-label', stopRequested ? 'Stopping response' : 'Stop response');
        sendBtn.setAttribute('title', stopRequested ? 'Stopping response' : 'Stop response');
        return;
    }

    if (voiceState.intelligentListening) {
        sendBtn.classList.add('smart-voice-listening');
        sendBtn.dataset.action = 'stop-smart-voice';
        sendBtn.setAttribute('aria-label', 'Stop intelligent voice');
        sendBtn.setAttribute('title', 'Stop intelligent voice');
        return;
    }

    if (voiceState.intelligentStopping || voiceState.intelligentProcessing) {
        sendBtn.classList.add('smart-voice-processing');
        sendBtn.dataset.action = 'none';
        sendBtn.disabled = true;
        sendBtn.setAttribute('aria-label', 'Processing intelligent voice');
        sendBtn.setAttribute('title', 'Processing intelligent voice');
        return;
    }

    if (dictationActive) {
        sendBtn.classList.add('smart-voice-ready');
        sendBtn.dataset.action = 'none';
        sendBtn.disabled = true;
        sendBtn.setAttribute('aria-label', 'Dictation in progress');
        sendBtn.setAttribute('title', 'Dictation in progress');
        return;
    }

    if (hasComposerPayload()) {
        sendBtn.classList.add('send-ready');
        sendBtn.dataset.action = 'send';
        sendBtn.setAttribute('aria-label', 'Send message');
        sendBtn.setAttribute('title', 'Send message');
        return;
    }

    if (voiceState.smartVoiceSupported === false) {
        sendBtn.classList.add('smart-voice-unavailable');
        sendBtn.dataset.action = 'none';
        sendBtn.disabled = true;
        sendBtn.setAttribute('aria-label', 'Intelligent voice is unavailable');
        sendBtn.setAttribute('title', 'Intelligent voice is unavailable');
        return;
    }

    sendBtn.classList.add('smart-voice-ready');
    sendBtn.dataset.action = 'smart-voice';
    sendBtn.setAttribute('aria-label', 'Start intelligent voice');
    sendBtn.setAttribute('title', 'Start intelligent voice');
}

document.addEventListener('composerStateChanged', () => {
    updateSendButtonState();
    syncUltraThinkControl();
});
document.addEventListener('input', (event) => {
    if (event.target?.id === 'floating-input') {
        updateSendButtonState();
    }
});

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

function queuePendingMessageForSend({ isMemoryEnabled, agentType, message, attachedFiles, selectedSessions, thinkingMode: queuedThinkingMode }) {
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
            thinkingModeOverride: queuedThinkingMode,
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
        thinkingMode: getEffectiveThinkingMode(),
    };
}

function renderMessageFailure(messageId, retryRequest = null) {
    const messageDiv = getBotMessageElement(messageId)
        || createBotMessagePlaceholder(messageId || `error_${Date.now()}`);
    if (!messageDiv) return;

    messageFormatter.finishStreaming(messageId);
    ongoingStreams.delete(messageId);
    destroyThinkingOrbs(messageDiv);

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
                    thinkingModeOverride: retryRequest.thinkingMode,
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
        messageDiv.classList.remove('expanded');
        summary.setAttribute('aria-expanded', 'false');
        return;
    }

    const parts = [];
    if (reasoningBlocks > 0) parts.push(`${reasoningBlocks} thought${reasoningBlocks > 1 ? 's' : ''}`);
    if (toolLogs > 0) parts.push(`${toolLogs} tool${toolLogs > 1 ? 's' : ''}`);
    if (agentBlocks > 0) parts.push(`${agentBlocks} agent${agentBlocks > 1 ? 's' : ''}`);
    const wasHidden = summary.classList.contains('hidden');
    summaryText.textContent = `Reasoning: ${parts.join(', ')}`;
    summary.classList.remove('hidden');
    if (wasHidden) {
        messageDiv.classList.add('expanded');
        summary.setAttribute('aria-expanded', 'true');
    }
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
    }

    const attachmentRail = renderSentAttachmentCards(files, messageId);
    if (attachmentRail) {
        wrapperDiv.classList.add('has-sent-attachments');
        wrapperDiv.appendChild(attachmentRail);
    }

    if (sessions.length > 0) {
        const contextButton = document.createElement('button');
        contextButton.className = 'user-message-context-button';
        const sessionCount = sessions.length;
        const buttonText = `Context: ${sessionCount} session${sessionCount === 1 ? '' : 's'}`;
        contextButton.innerHTML = `<i class="fas fa-layer-group"></i> ${buttonText}`;
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
        <button class="reasoning-summary hidden" type="button" aria-expanded="false" aria-controls="logs-${messageId}">
            <span class="reasoning-summary-main">
                <span class="thinking-orb-mount" data-thinking-orb></span>
                <span class="summary-text">Reasoning: 0 thoughts, 0 tools, 0 agents</span>
            </span>
            <i class="fas fa-chevron-down summary-chevron"></i>
        </button>
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
    mountThinkingOrbs(thinkingIndicator, {
        state: 'solving',
        size: 64,
        speed: 0.25,
    });

    // Auto-scroll is now handled by the caller (e.g., renderTurnFromEvents)

    const summary = thinkingIndicator.querySelector('.reasoning-summary');
    summary?.addEventListener('click', () => {
        const expanded = messageDiv.classList.toggle('expanded');
        summary.setAttribute('aria-expanded', String(expanded));
    });
    return messageDiv;
}

// Helper to normalize content from backend (handles objects, strings, etc.)
function normalizeBackendContent(content) {

    // If it's already a string, return as-is
    if (typeof content === 'string') {

        return content;
    }

    // If it's null or undefined, return empty string
    if (content == null) {

        return '';
    }

    // If it's an object, extract the actual content
    if (typeof content === 'object') {

        // Check for common content keys
        const potentialKeys = ['raw', 'code', 'content', 'text', 'output', 'data'];

        for (const key of potentialKeys) {
            if (Object.prototype.hasOwnProperty.call(content, key)) {
                const value = content[key];

                // If the value is a string, check if it's already markdown
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    // If it's already a code block, return as-is
                    if (trimmed.startsWith('```')) {

                        return trimmed;
                    }
                    // If it has language info, wrap it
                    const lang = content.lang || content.language || content.format || '';
                    if (lang && trimmed) {

                        return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
                    }
                    // Otherwise return the raw string

                    return trimmed;
                }

                // If the value is an object, stringify it as JSON
                if (typeof value === 'object' && value !== null) {

                    const jsonString = JSON.stringify(value, null, 2);
                    return `\`\`\`json\n${jsonString}\n\`\`\``;
                }

                // For other types, convert to string

                return String(value);
            }
        }

        // If no content key found, stringify the entire object

        try {
            const jsonString = JSON.stringify(content, null, 2);
            return `\`\`\`json\n${jsonString}\n\`\`\``;
        } catch (e) {
            console.error('[Chat] Failed to stringify object:', e);
            return '[Complex object - unable to display]';
        }
    }

    // For any other type, convert to string

    return String(content);
}

function populateBotMessage(data) {

    let { content, id: messageId, streaming = false, agent_name, team_name, is_log } = data;
    const messageDiv = ongoingStreams.get(messageId);
    if (!messageDiv) {
        console.warn('[Chat] Message div not found for:', messageId);
        return;
    }

    // Normalize content from backend (handles objects, strings, etc.)
    const originalContent = content;
    content = normalizeBackendContent(content);

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

function getAttachmentIconClass(file = {}) {
    const type = file.type || file.backendMimeType || '';
    const name = file.name || '';

    if (type.startsWith('image/')) return 'fa-file-image';
    if (type.startsWith('video/')) return 'fa-file-video';
    if (type.startsWith('audio/')) return 'fa-file-audio';
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'fa-file-pdf';
    if (type.includes('word') || type.includes('document')) return 'fa-file-word';
    if (type.includes('excel') || type.includes('spreadsheet') || name.match(/\.(csv|xls|xlsx)$/i)) return 'fa-file-excel';
    if (type.includes('powerpoint') || type.includes('presentation') || name.match(/\.(ppt|pptx)$/i)) return 'fa-file-powerpoint';
    if (type.includes('zip') || type.includes('archive') || name.match(/\.(zip|rar|7z|tar|gz)$/i)) return 'fa-file-archive';
    if (name.match(/\.(js|jsx|ts|tsx|py|java|cpp|c|cs|php|rb|go|rs|swift|kt|scala|html|css|json|xml|sql|sh|md)$/i)) return 'fa-file-code';
    return 'fa-file';
}

function getAttachmentPreviewUrl(file = {}) {
    return file.previewUrl || file.dataUrl || file.url || file.downloadUrl || '';
}

function canPreviewAttachment(file = {}) {
    const type = file.type || file.backendMimeType || '';
    return Boolean(getAttachmentPreviewUrl(file) || file.content || file.isText || type.startsWith('text/'));
}

function enableHorizontalRailScroll(rail) {
    if (!rail || rail.dataset.horizontalRailReady === 'true') return;
    rail.dataset.horizontalRailReady = 'true';

    let activePointerId = null;
    let startX = 0;
    let startScrollLeft = 0;
    let dragged = false;
    let suppressClick = false;

    const endDrag = () => {
        if (dragged) {
            suppressClick = true;
            window.setTimeout(() => {
                suppressClick = false;
            }, 0);
        }
        activePointerId = null;
        dragged = false;
        rail.classList.remove('is-dragging');
    };

    rail.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        activePointerId = event.pointerId;
        startX = event.clientX;
        startScrollLeft = rail.scrollLeft;
        dragged = false;
        try {
            rail.setPointerCapture(event.pointerId);
        } catch (_) { }
    });

    rail.addEventListener('pointermove', (event) => {
        if (activePointerId !== event.pointerId) return;
        const deltaX = event.clientX - startX;
        if (Math.abs(deltaX) < 4 && !dragged) return;
        dragged = true;
        rail.classList.add('is-dragging');
        rail.scrollLeft = startScrollLeft - deltaX;
        event.preventDefault();
    }, { passive: false });

    rail.addEventListener('pointerup', endDrag);
    rail.addEventListener('pointercancel', endDrag);
    rail.addEventListener('lostpointercapture', endDrag);

    rail.addEventListener('click', (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}

function createSentAttachmentCard(file = {}, index = 0) {
    const type = file.type || file.backendMimeType || '';
    const previewUrl = getAttachmentPreviewUrl(file);
    const safeName = escapeHtml(file.name || `File ${index + 1}`);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sent-attachment-card';
    card.dataset.fileIndex = String(index);
    card.disabled = !canPreviewAttachment(file);
    card.setAttribute('aria-label', `Preview ${file.name || `file ${index + 1}`}`);

    if (type.startsWith('image/') && previewUrl) {
        card.classList.add('image-file');
        card.innerHTML = `
            <img class="sent-attachment-thumb" src="${encodeURI(previewUrl)}" alt="${safeName}">
            <span class="sent-attachment-name">${safeName}</span>
        `;
    } else {
        card.innerHTML = `
            <span class="sent-attachment-icon"><i class="fas ${getAttachmentIconClass(file)}"></i></span>
            <span class="sent-attachment-name">${safeName}</span>
        `;
    }

    return card;
}

function renderSentAttachmentCards(files = [], messageId) {
    if (!Array.isArray(files) || files.length === 0) return null;

    const rail = document.createElement('div');
    rail.className = 'sent-attachments-rail';
    rail.setAttribute('role', 'list');
    rail.setAttribute('aria-label', 'Attached files');

    files.forEach((file, index) => {
        const card = createSentAttachmentCard(file, index);
        card.setAttribute('role', 'listitem');
        card.addEventListener('click', () => showSentAttachmentPreview(file, messageId));
        rail.appendChild(card);
    });

    enableHorizontalRailScroll(rail);
    return rail;
}

function showSentAttachmentPreview(file = {}, messageId = null) {
    if (!canPreviewAttachment(file)) return;

    const modal = document.getElementById('file-preview-modal');
    const previewArea = document.getElementById('preview-content-area');
    if (!modal || !previewArea) {
        const contextData = sentContexts.get(messageId);
        if (contextViewer && contextData) contextViewer.show(contextData);
        return;
    }

    const type = file.type || file.backendMimeType || '';
    const previewUrl = getAttachmentPreviewUrl(file);
    const safeName = escapeHtml(file.name || 'Attached file');
    const safePreviewUrl = previewUrl ? encodeURI(previewUrl) : '';

    if (type.startsWith('image/') && safePreviewUrl) {
        previewArea.innerHTML = `
            <div class="preview-header">
                <h3 class="preview-title">${safeName}</h3>
            </div>
            <img src="${safePreviewUrl}" alt="Preview of ${safeName}">
        `;
    } else if (type.startsWith('video/') && safePreviewUrl) {
        previewArea.innerHTML = `<video src="${safePreviewUrl}" controls autoplay></video>`;
    } else if (type.startsWith('audio/') && safePreviewUrl) {
        previewArea.innerHTML = `<audio src="${safePreviewUrl}" controls autoplay></audio>`;
    } else if ((type === 'application/pdf' || file.name?.endsWith?.('.pdf')) && safePreviewUrl) {
        previewArea.innerHTML = `<iframe class="pdf-preview" src="${safePreviewUrl}"></iframe>`;
    } else if (file.content || file.isText || type.startsWith('text/')) {
        previewArea.innerHTML = `
            <div class="preview-header">
                <h3 class="preview-title">${safeName}</h3>
            </div>
            <div class="text-file-preview"><pre><code>${escapeHtml(file.content || '')}</code></pre></div>
        `;
    } else {
        previewArea.innerHTML = `<p>Preview is not available for this file type.</p>`;
    }

    modal.classList.remove('hidden');
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
        // Shown in the ongoing notification while the app is in the background.
        try { backgroundRunManager.updateProgress(currentConversationId, `Using ${toolName}`); } catch (_) { }
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
        setThinkingOrbsPaused(thinkingIndicator, true);
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
        destroyThinkingOrbs(thinkingIndicator);
        thinkingIndicator.remove();
    }

    messageFormatter.finishStreaming(messageId);

    // Apply inline enhancements (Mermaid, syntax highlighting, etc.) after streaming completes
    const mainContent = messageDiv.querySelector('.message-content');
    if (mainContent && messageFormatter.applyInlineEnhancements) {

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

function setPlanModeEnabled(enabled) {
    planModeEnabled = Boolean(enabled);
    const button = document.getElementById('plan-mode-btn');
    if (button) {
        button.classList.toggle('active', planModeEnabled);
        button.setAttribute('aria-pressed', planModeEnabled ? 'true' : 'false');
    }
    syncComposerModeVisual();
}

function setPlanGenerating(generating) {
    planGenerationInProgress = Boolean(generating);
    const planButton = document.getElementById('plan-mode-btn');
    const input = document.getElementById('floating-input');

    if (planButton) {
        planButton.disabled = planGenerationInProgress;
    }
    if (input) {
        input.disabled = planGenerationInProgress;
    }

    updateSendButtonState();
}

function hidePlanReview() {
    pendingPlanRequestId = null;
    pendingPlanMessageId = null;
}

function clearPlanBuffers(messageId) {
    if (!messageId) return;
    const renderState = planRenderStates.get(messageId);
    if (renderState?.timer) clearTimeout(renderState.timer);
    const reasoningState = planReasoningRenderStates.get(messageId);
    if (reasoningState?.timer) clearTimeout(reasoningState.timer);
    planRenderStates.delete(messageId);
    planReasoningRenderStates.delete(messageId);
    planStreamBuffers.delete(messageId);
    planReasoningBuffers.delete(messageId);
}

function completePlanThinking(messageId) {
    const messageDiv = getBotMessageElement(messageId);
    if (!messageDiv) return;
    appendPlanModeToolLog(messageId, 'completed');
    const thinkingIndicator = messageDiv.querySelector('.thinking-indicator');
    const reasoningSummary = thinkingIndicator?.querySelector('.reasoning-summary');
    thinkingIndicator?.classList.add('steps-done');
    if (thinkingIndicator) setThinkingOrbsPaused(thinkingIndicator, true);
    reasoningSummary?.classList.remove('hidden');
    updateReasoningSummary(messageId);
}

function scrollPlanMessageIntoView(messageId) {
    const messageDiv = getBotMessageElement(messageId);
    const messagesContainer = document.getElementById('chat-messages');
    if (!messageDiv || !messagesContainer) return;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function updatePlanOutputCard(messageId, planText, done = false) {
    const messageDiv = getBotMessageElement(messageId);
    const targetContainer = messageDiv?.querySelector(`#main-content-${messageId}`);
    if (!messageDiv || !targetContainer) return;

    const formattedPlan = contentSecurity.sanitizeHTML(
        messageFormatter.format(planText || '', { inlineArtifacts: false }),
        {
            ALLOWED_TAGS: [
                'p', 'br', 'strong', 'em', 'b', 'i', 'code', 'pre', 'a', 'ul', 'ol', 'li',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'thead', 'tbody',
                'tr', 'th', 'td', 'span', 'div'
            ],
            ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel', 'title'],
            ALLOW_DATA_ATTR: true
        }
    );
    let card = targetContainer.querySelector('.plan-output-card');
    if (!card) {
        targetContainer.innerHTML = `
            <div class="plan-output-card streaming" data-plan-message-id="${escapeHtml(messageId)}">
                <div class="plan-output-header">
                    <div class="plan-output-title">
                        <i class="fi fi-tr-roadmap" aria-hidden="true"></i>
                        <span>Plan Mode Output</span>
                    </div>
                </div>
                <div class="plan-output-body">
                    <div class="plan-output-content">${formattedPlan}</div>
                    <textarea class="plan-output-editor hidden" aria-label="Edit generated plan">${escapeHtml(planText || '')}</textarea>
                </div>
                <div class="plan-output-actions">
                    <button type="button" class="plan-output-edit">Edit</button>
                    <button type="button" class="plan-output-submit">Submit</button>
                </div>
            </div>
        `;
        card = targetContainer.querySelector('.plan-output-card');
    } else {
        const content = card.querySelector('.plan-output-content');
        const editor = card.querySelector('.plan-output-editor');
        if (content && !content.classList.contains('hidden')) {
            content.innerHTML = formattedPlan;
        }
        if (editor && editor.classList.contains('hidden')) {
            editor.value = planText || '';
        }
    }

    if (done) {
        completePlanThinking(messageId);
        card?.classList.remove('streaming');
        if (messageFormatter.applyInlineEnhancements) {
            messageFormatter.applyInlineEnhancements(targetContainer);
        }
        targetContainer.querySelectorAll('pre code:not([data-highlighted])').forEach(codeBlock => {
            if (typeof hljs !== 'undefined') {
                hljs.highlightElement(codeBlock);
                codeBlock.dataset.highlighted = 'true';
            }
        });
    }

    scrollPlanMessageIntoView(messageId);
}

function schedulePlanOutputRender(messageId, done = false) {
    if (!messageId) return;
    const text = planStreamBuffers.get(messageId) || '';
    if (done) {
        const state = planRenderStates.get(messageId);
        if (state?.timer) clearTimeout(state.timer);
        planRenderStates.delete(messageId);
        updatePlanOutputCard(messageId, text, true);
        return;
    }

    const existingState = planRenderStates.get(messageId);
    if (existingState?.timer) return;

    const timer = setTimeout(() => {
        planRenderStates.delete(messageId);
        updatePlanOutputCard(messageId, planStreamBuffers.get(messageId) || '', false);
    }, 140);
    planRenderStates.set(messageId, { timer });
}

function appendPlanStreamContent(messageId, content) {
    if (!messageId || !content) {
        return planStreamBuffers.get(messageId) || '';
    }
    const previous = planStreamBuffers.get(messageId) || '';
    const incoming = String(content);
    let next = `${previous}${incoming}`;
    if (previous && incoming.startsWith(previous)) {
        next = incoming;
    } else if (previous && previous.endsWith(incoming)) {
        next = previous;
    }
    planStreamBuffers.set(messageId, next);
    return next;
}

function appendPlanReasoningContent(messageId, content, agentName = 'plan_agent') {
    if (!messageId || !content) return;
    const entry = planReasoningBuffers.get(messageId) || { content: '', agentName };
    entry.content += String(content);
    entry.agentName = agentName || entry.agentName || 'plan_agent';
    planReasoningBuffers.set(messageId, entry);

    const existingState = planReasoningRenderStates.get(messageId);
    if (existingState?.timer) return;

    const timer = setTimeout(() => {
        flushPlanReasoningContent(messageId);
    }, 140);
    planReasoningRenderStates.set(messageId, { timer });
}

function flushPlanReasoningContent(messageId) {
    const state = planReasoningRenderStates.get(messageId);
    if (state?.timer) clearTimeout(state.timer);
    planReasoningRenderStates.delete(messageId);

    const entry = planReasoningBuffers.get(messageId);
    if (!entry?.content) return;
    planReasoningBuffers.delete(messageId);
    appendReasoningContent({
        id: messageId,
        reasoning_content: entry.content,
        agent_name: entry.agentName || 'plan_agent',
    });
}

function appendPlanModeToolLog(messageId, status = 'in-progress', toolLabel = 'Plan Mode') {
    const messageDiv = getBotMessageElement(messageId);
    if (!messageDiv) return;
    const logsContainer = messageDiv.querySelector('.detailed-logs');
    if (!logsContainer) return;
    const logEntryId = `plan-mode-tool-${messageId}`;
    let logEntry = logsContainer.querySelector(`#${logEntryId}`);
    if (!logEntry) {
        logEntry = document.createElement('div');
        logEntry.id = logEntryId;
        logEntry.className = 'tool-log-entry';
        logEntry.innerHTML = `
            <i class="fi fi-tr-roadmap tool-log-icon"></i>
            <div class="tool-log-details">
                <span class="tool-log-action">Used tool: <strong>${escapeHtml(toolLabel || 'Plan Mode')}</strong></span>
            </div>
            <span class="tool-log-status ${status}" title="${status === 'completed' ? 'Completed' : 'In progress'}"></span>
        `;
        logsContainer.appendChild(logEntry);
    }
    const statusEl = logEntry.querySelector('.tool-log-status');
    if (statusEl) {
        statusEl.className = `tool-log-status ${status}`;
        statusEl.setAttribute('title', status === 'completed' ? 'Completed' : 'In progress');
    }
    updateReasoningSummary(messageId);
}

function handlePlanResponse(data = {}) {
    if (!data || !pendingPlanRequestId) return;
    if (data.requestId && data.requestId !== pendingPlanRequestId) return;

    const planMessageId = data.messageId || pendingPlanMessageId;
    if (data.reasoning_content && planMessageId) {
        appendPlanReasoningContent(planMessageId, data.reasoning_content, data.agent_name || 'plan_agent');
    }
    if (data.step_type && planMessageId) {
        const toolLabel = data.name ? String(data.name).replace(/_/g, ' ') : 'Plan Mode';
        appendPlanModeToolLog(
            planMessageId,
            data.step_type === 'tool_end' ? 'completed' : 'in-progress',
            toolLabel,
        );
    }
    if (data.streaming && data.content && planMessageId) {
        appendPlanStreamContent(planMessageId, data.content);
        schedulePlanOutputRender(planMessageId, false);
    }
    if (!data.success) {
        setPlanGenerating(false);
        if (planMessageId) {
            populateBotMessage({
                id: planMessageId,
                content: data.error || 'Plan generation failed.',
                agent_name: 'plan_agent',
            });
            completePlanThinking(planMessageId);
            clearPlanBuffers(planMessageId);
        }
        notificationService?.show(data.error || 'Plan generation failed.', 'error');
        pendingPlanRequestId = null;
        pendingPlanMessageId = null;
        return;
    }
    if (!data.done && !data.plan) {
        return;
    }

    const finalPlan = data.plan || planStreamBuffers.get(planMessageId) || '';
    setPlanGenerating(false);
    flushPlanReasoningContent(planMessageId);
    planStreamBuffers.set(planMessageId, finalPlan);
    pendingPlanRequestId = null;
    pendingPlanMessageId = null;
    schedulePlanOutputRender(planMessageId, true);
    planStreamBuffers.delete(planMessageId);
    notificationService?.show('Plan ready. Review, edit, then submit.', 'success', 3500);
}

async function requestPlanFromAgent() {
    const input = document.getElementById('floating-input');
    const message = input?.value.trim() || '';
    const attachedFiles = cloneAttachedFiles(fileAttachmentHandler?.getAttachedFiles?.() || []);
    const selectedSessions = cloneSelectedSessions(contextHandler?.getSelectedSessions?.() || []);

    if (!message && attachedFiles.length === 0 && selectedSessions.length === 0) return;
    if (planGenerationInProgress) return;

    if (!isSocketConnected) {
        notificationService?.show('Not connected to server. Please wait...', 'error');
        return;
    }

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
            notificationService?.show('You must be logged in to create a plan.', 'error');
            return;
        }
    } catch (error) {
        notificationService?.show('You must be logged in to create a plan.', 'error');
        return;
    }

    pendingPlanRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `plan_${Date.now()}`;
    const messageId = `plan_${Date.now()}`;
    pendingPlanMessageId = messageId;

    addUserMessage(message || 'Attached context', attachedFiles, selectedSessions);
    createBotMessagePlaceholder(messageId);
    appendReasoningContent({
        id: messageId,
        reasoning_content: 'Understanding the request, checking enabled capabilities, and preparing an execution plan for Aetheria.',
        agent_name: 'plan_agent',
    });
    appendPlanModeToolLog(messageId, 'in-progress');

    if (input) {
        input.value = '';
        input.style.height = 'auto';
        input.focus();
    }
    setPlanGenerating(true);

    try {
        await socketService.sendPlanRequest({
            requestId: pendingPlanRequestId,
            messageId,
            conversationId: currentConversationId,
            message,
            files: attachedFiles,
            selected_sessions: selectedSessions,
            config: buildOutgoingAgentConfig(),
        });
    } catch (error) {
        console.error('[Chat] Failed to request plan:', error);
        setPlanGenerating(false);
        populateBotMessage({
            id: messageId,
            content: error.message || 'Plan generation failed.',
            agent_name: 'plan_agent',
        });
        completePlanThinking(messageId);
        clearPlanBuffers(messageId);
        pendingPlanRequestId = null;
        pendingPlanMessageId = null;
        notificationService?.show(error.message || 'Plan generation failed.', 'error');
    }
}

function submitApprovedPlan(card = null) {
    const planInput = card
        ? card.querySelector('.plan-output-editor')
        : document.querySelector('.plan-output-card .plan-output-editor:not(.hidden), .plan-output-card .plan-output-editor');
    const planText = planInput?.value.trim() || '';
    if (!planText) {
        notificationService?.show('Plan is empty.', 'error');
        return;
    }

    submittingApprovedPlan = true;
    pendingPlanSubmitDisplayMessage = 'Aetheria is on it. Hold tight while the assistant works through the approved plan.';
    setPlanModeEnabled(false);
    hidePlanReview();

    chatModule.handleSendMessage(undefined, undefined, {
        messageOverride: planText,
        displayMessageOverride: pendingPlanSubmitDisplayMessage,
    }).finally(() => {
        submittingApprovedPlan = false;
        pendingPlanSubmitDisplayMessage = null;
    });
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
        const sessionRow = await backendRequest(`/sessions/${encodeURIComponent(conversationId)}/history`);
        let runs = sessionRow?.runs || [];
        if (typeof runs === 'string') {
            try {
                runs = JSON.parse(runs);
            } catch (_) {
                runs = [];
            }
        }

        const topLevelRuns = _parseSessionRuns(runs);

        const messagesContainer = document.getElementById('chat-messages');
        if (!messagesContainer) return false;

        destroyThinkingOrbs(messagesContainer);
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

        for (const request of sessionRow.input_requests || []) {
            let message = getBotMessageElement(request.id);
            if (!message) message = createBotMessagePlaceholder(request.id);
            questionCards.mount(request, message);
            if (request.status === 'pending') {
                questionsByConversation.set(conversationId, request);
                sessionActive = true;
                setThinkingOrbsPaused(message, true);
            }
        }
        updateSendButtonState();
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
    socketService.on('user_question', request => {
        if (!request?.conversationId || !request.id || !Array.isArray(request.questions)) return;
        questionsByConversation.set(request.conversationId, request);
        if (request.conversationId !== currentConversationId) return;
        welcomeDisplay?.hide();
        conversationStateManager?.onMessageAdded();
        if (request.channel === 'plan') {
            pendingPlanRequestId = request.planRequestId;
            pendingPlanMessageId = request.id;
            setPlanGenerating(true);
        } else {
            sessionActive = true;
        }
        let message = getBotMessageElement(request.id);
        if (!message) message = createBotMessagePlaceholder(request.id);
        questionCards.mount(request, message);
        setThinkingOrbsPaused(message, true);
        updateSendButtonState();
        dispatchChatEvent('chatStateChanged', { status: 'waiting_for_input', conversationId: request.conversationId });
    });
    socketService.on('user_question_ack', acknowledgement => {
        const pending = pendingAnswerSubmissions.get(acknowledgement?.requestId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingAnswerSubmissions.delete(acknowledgement.requestId);
            if (acknowledgement.success) pending.resolve();
            else pending.reject(new Error(acknowledgement.error || 'Could not submit answers.'));
        }
        if (!acknowledgement?.success) return;
        questionCards.update(acknowledgement);
        questionsByConversation.delete(acknowledgement.conversationId);
        if (acknowledgement.conversationId === currentConversationId) {
            const message = getBotMessageElement(acknowledgement.id);
            if (message) setThinkingOrbsPaused(message, acknowledgement.status !== 'resuming');
        }
    });

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

        if (status === 'waiting_for_input') {
            sessionActive = true;
            const message = getBotMessageElement(messageId);
            if (message) setThinkingOrbsPaused(message, true);
            updateSendButtonState();
            return;
        }

        if (status === 'running') {
            if (messageId && !ongoingStreams.has(messageId)) {
                createBotMessagePlaceholder(messageId);
            }
            sessionActive = true;
            stopRequested = false;
            updateSendButtonState();

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
                destroyThinkingOrbs(messageDiv);
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
        if (conversationId !== currentConversationId) {
            backgroundRunManager.onBackgroundCatchupReceived(conversationId, title);
            notificationService?.show('A background chat finished. Open it from Chats to view the result.', 'info', 5000);
            return;
        }

        // ── Deduplication ─────────────────────────────────────────────────
        // The same client can receive multiple run_catchup events if it
        // sends join_conversation more than once (reconnect race conditions).
        const dedupKey = `${conversationId}:${messageId}`;
        if (_renderedCatchups.has(dedupKey)) {

            return;
        }
        _renderedCatchups.add(dedupKey);
        // Auto-expire after 30 s so re-opened fresh sessions work normally
        setTimeout(() => _renderedCatchups.delete(dedupKey), 30_000);

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

        if (!data.artifacts || !Array.isArray(data.artifacts) || data.artifacts.length === 0) {

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
                transition: transform 0.2s, opacity 0.2s, background-color 0.2s, border-color 0.2s;
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

                    // Check cache first
                    const cachedMetadata = await artifactCache.getMetadata(artifact.artifact_id);
                    const cachedContent = await artifactCache.getContent(artifact.artifact_id);

                    let artifactData;
                    let contentText;

                    if (cachedMetadata && cachedContent) {

                        artifactData = cachedMetadata;
                        contentText = cachedContent;
                    } else {

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

                        // Fetch file content
                        const contentResponse = await fetch(artifactData.download_url);
                        contentText = await contentResponse.text();

                        // Cache metadata and content
                        await artifactCache.setMetadata(artifact.artifact_id, artifactData);
                        await artifactCache.setContent(artifact.artifact_id, contentText);

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

                    // Show in artifact viewer with filename
                    artifactHandler.showArtifact(contentText, language, null, artifact.filename);

                } catch (error) {
                    console.error('[Chat] Error loading artifact:', error);
                    chatModule.showNotification('Failed to load file', 'error');
                }
            });

            artifactsContainer.appendChild(artifactBtn);
        });

        // Update content button after artifacts are created
        chatModule.checkAndShowContentButton();
    });

    socketService.on('image_generated', handleImageGenerated);
    socketService.on('presentation_generated', handlePresentationGenerated);

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

        if (err?.recoverable) {
            const messageId = err?.messageId || activeRunRequest?.messageId;
            const messageDiv = getBotMessageElement(messageId);
            if (messageDiv) {
                messageFormatter.finishStreaming(messageId);
                ongoingStreams.delete(messageId);
                destroyThinkingOrbs(messageDiv);
                messageDiv.classList.add('message-error');
                messageDiv.classList.remove('expanded');
                messageDiv.innerHTML = `
                    <div class="message-error-card">
                        <p class="message-error-text">${escapeHtml(err.message || 'This request is unavailable in the current mode.')}</p>
                    </div>
                `;
            }
            applyRoutingErrorState(err?.code);
            notificationService?.show(err.message || 'This request is unavailable in the current mode.', 'warning', 5000);
            shouldResendWithHistory = false;
            clearActiveRunState();
            resetUserInputState();
            dispatchChatEvent('chatStateChanged', { status: 'idle', conversationId: currentConversationId });
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

function handlePresentationGenerated(data = {}) {

    const messageId = data.id || data.messageId;
    if (!messageId || !data.metadata) {
        return;
    }

    const messageDiv = ongoingStreams.get(messageId) || document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageDiv) {
        const mainContent = messageDiv.querySelector('.message-content');
        if (mainContent) {
            artifactHandler.renderPresentation(mainContent, data.metadata);
        }
        messageDiv.classList.add('expanded');
    }
}

function setupPlanModeInteractions() {
    const messagesContainer = document.getElementById('chat-messages');
    if (!messagesContainer || messagesContainer.dataset.planModeBound === 'true') return;
    messagesContainer.dataset.planModeBound = 'true';

    messagesContainer.addEventListener('click', (event) => {
        const planEditBtn = event.target.closest('.plan-output-edit');
        if (planEditBtn) {
            const card = planEditBtn.closest('.plan-output-card');
            const content = card?.querySelector('.plan-output-content');
            const editor = card?.querySelector('.plan-output-editor');
            if (content && editor) {
                content.classList.add('hidden');
                editor.classList.remove('hidden');
                editor.focus();
                editor.style.height = 'auto';
                editor.style.height = `${Math.max(editor.scrollHeight, 260)}px`;
                planEditBtn.disabled = true;
            }
            return;
        }

        const planSubmitBtn = event.target.closest('.plan-output-submit');
        if (planSubmitBtn) {
            const card = planSubmitBtn.closest('.plan-output-card');
            const editor = card?.querySelector('.plan-output-editor');
            const content = card?.querySelector('.plan-output-content');
            if (editor?.classList.contains('hidden') && content) {
                const temp = document.createElement('div');
                temp.innerHTML = content.innerHTML;
                editor.value = temp.textContent.trim();
            }
            submitApprovedPlan(card);
        }
    });
}

// Browser screenshot functions moved to js/browser-screenshot-viewer.js

export const chatModule = {
    resetForSignOut() {
        socketService.disconnect();
        backgroundRunManager.clearAll();
        questionCards.reset();
        questionsByConversation.clear();
        for (const pending of pendingAnswerSubmissions.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('You have signed out.'));
        }
        pendingAnswerSubmissions.clear();
        conversationModelRoutes.clear();
        this.startNewConversation();
        contextHandler?.toggleWindow(false);
    },
    async resumeConversation(conversationId, session = {}) {
        if (session.agent_id === 'aetheria-computer') {
            throw new Error('Computer-control chats can be viewed here. Continue them in the desktop app.');
        }
        if (sessionActive || planGenerationInProgress) throw new Error('Stop the active request before switching chats.');
        planModeEnabled = false;
        hidePlanReview();
        setCurrentConversationId(conversationId);
        if (window.projectWorkspace) {
            window.projectWorkspace.state.active = session.agent_id === 'aetheria-coder';
            window.projectWorkspace.state.project = null;
            window.projectWorkspace.updateUI();
        }
        if (!await restoreConversationHistory(conversationId)) throw new Error('Could not restore this conversation.');
        delete document.getElementById('chat-messages').dataset.viewingPastSession;
        delete document.getElementById('chat-messages').dataset.pastSessionId;
        welcomeDisplay?.hide();
        conversationStateManager?.onMessageAdded();
        socketService.joinConversation(conversationId);
        document.getElementById('floating-input')?.focus();
    },
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
        fileAttachmentHandler?.setAttachmentValidator?.(validateAttachmentForCurrentMode);

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

        socketService.init().catch(error => notificationService?.show(error.message, 'error'));
        setupSocketListeners();

        // Initialize BackgroundRunManager — lifecycle tracking + native notifications
        // Rendering is done exclusively inside the run_catchup socket handler above.
        try {
            backgroundRunManager.init(
                // onCompleted: optional hook (run_catchup socket event does the actual render)
                (conversationId) => {

                },
                // onFailed: optional hook — native notification is already sent by BRM
                (conversationId, error) => {
                    console.warn('[Chat] BRM onFailed:', conversationId, error);
                }
            );
        } catch (e) {
            console.warn('[Chat] BackgroundRunManager init error (non-critical):', e);
        }

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

        });

        // Setup view content button
        this.setupViewContentButton();
        setupPlanModeInteractions();
        syncUltraThinkControl();
        syncComposerModeVisual();
        updateSendButtonState();
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

            return;
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {

                return;
            }

            const url = `${config.backend.url}/api/sessions/${currentConversationId}/content`;

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const count = data.count || 0;

                const viewContentBtn = document.getElementById('view-content-btn');
                const contentBadge = document.getElementById('content-count-badge');

                if (count > 0) {

                    viewContentBtn?.classList.remove('hidden');
                    if (contentBadge) {
                        contentBadge.textContent = count;
                        contentBadge.classList.remove('hidden');
                    }
                } else {

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
        window.voiceInputHandler?.stopAll?.({ discard: true });
        const messagesContainer = document.getElementById('chat-messages');
        if (messagesContainer) destroyThinkingOrbs(messagesContainer);
        messagesContainer?.replaceChildren();

        const nextConversationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `conv_${Date.now()}`;
        setCurrentConversationId(nextConversationId);

        sentContexts.clear();
        ongoingStreams.clear();
        pendingSendQueue.length = 0;
        activeRunRequest = null;
        stopRequested = false;
        sessionActive = false;
        shouldResendWithHistory = false;
        planModeEnabled = false;
        thinkingMode = THINKING_MODE_STANDARD;
        planGenerationInProgress = false;
        hidePlanReview();
        setPlanModeEnabled(false);
        setThinkingMode(THINKING_MODE_STANDARD);
        planStreamBuffers.clear();
        planRenderStates.forEach((state) => {
            if (state?.timer) clearTimeout(state.timer);
        });
        planRenderStates.clear();
        planReasoningBuffers.clear();
        planReasoningRenderStates.forEach((state) => {
            if (state?.timer) clearTimeout(state.timer);
        });
        planReasoningRenderStates.clear();
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
        if (planModeEnabled && !submittingApprovedPlan && !options?.messageOverride) {
            await requestPlanFromAgent();
            return;
        }

        const input = document.getElementById('floating-input');
        const messageOverride = typeof options?.messageOverride === 'string' ? options.messageOverride.trim() : '';
        const isProgrammaticSend = messageOverride.length > 0;
        const message = isProgrammaticSend ? messageOverride : input.value.trim();
        const displayMessage = typeof options?.displayMessageOverride === 'string' && options.displayMessageOverride.trim()
            ? options.displayMessageOverride.trim()
            : message;
        const includeAttachedFiles = options?.includeAttachedFiles !== false;
        const includeSelectedSessions = options?.includeSelectedSessions !== false;
        const attachedFiles = Array.isArray(options?.attachedFilesOverride)
            ? cloneAttachedFiles(options.attachedFilesOverride)
            : (includeAttachedFiles ? cloneAttachedFiles(fileAttachmentHandler.getAttachedFiles()) : []);
        const selectedSessions = Array.isArray(options?.selectedSessionsOverride)
            ? cloneSelectedSessions(options.selectedSessionsOverride)
            : (includeSelectedSessions ? cloneSelectedSessions(contextHandler.getSelectedSessions()) : []);
        const skipUserMessage = options?.skipUserMessage === true;
        const requestedThinkingMode = options?.thinkingModeOverride === THINKING_MODE_ULTRA
            ? THINKING_MODE_ULTRA
            : thinkingMode;
        const turnThinkingMode = getEffectiveThinkingMode(requestedThinkingMode);
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

            if (getCurrentConversationRoute() === CONVERSATION_ROUTE_VIDEO && requestedThinkingMode === THINKING_MODE_ULTRA) {
                notificationService?.show('This conversation is using video input mode. Start a new conversation to use Ultra Think.', 'warning', 5000);
                return;
            }

            if (turnThinkingMode === THINKING_MODE_ULTRA && attachmentsIncludeVideo(attachedFiles)) {
                notificationService?.show('Video attachments are unavailable in Ultra Think mode.', 'warning', 5000);
                return;
            }

            if (!isSocketConnected) {
                if (!skipUserMessage && hasMessagePayload) {
                    addUserMessage(displayMessage || 'Attached context', attachedFiles, selectedSessions);
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
                    thinkingMode: turnThinkingMode,
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

        sessionActive = true;
        stopRequested = false;
        updateSendButtonState();

        if (!skipUserMessage && hasMessagePayload) {
            addUserMessage(displayMessage || 'Attached context', attachedFiles, selectedSessions);
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

        let messageToSend = message;
        if (isPresentationRequest(message)) {
            const selectedTemplate = getSelectedPresentationTemplate();
            if (selectedTemplate) {
                messageToSend += buildPresentationTemplateInstruction(selectedTemplate);
                clearSelectedPresentationTemplate();
            }
        }

        activeRunRequest = {
            messageId,
            conversationId: currentConversationId,
            message: messageToSend,
            attachedFiles: cloneAttachedFiles(attachedFiles),
            selectedSessions: cloneSelectedSessions(selectedSessions),
            thinkingMode: turnThinkingMode,
        };

        const payload = {
            id: messageId,
            conversationId: currentConversationId,
            message: messageToSend,
            config: buildOutgoingAgentConfig(),
            is_deepsearch: selectedAgentType === 'deepsearch',
            thinking_mode: turnThinkingMode,
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
            markConversationRouteForTurn(turnThinkingMode, attachedFiles);
            try {
                const runTitle = typeof this.getCurrentConversationTitle === 'function'
                    ? this.getCurrentConversationTitle()
                    : null;
                backgroundRunManager.markRunStarted(currentConversationId, messageId, runTitle || null);
            } catch (_) { }
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

    togglePlanMode(forceEnabled = undefined) {
        const next = typeof forceEnabled === 'boolean' ? forceEnabled : !planModeEnabled;
        setPlanModeEnabled(next);
        if (!next) {
            hidePlanReview();
        }
        return planModeEnabled;
    },

    toggleUltraThinkMode(forceEnabled = undefined) {
        const route = getCurrentConversationRoute();
        if (route === CONVERSATION_ROUTE_ULTRA) {
            notificationService?.show('Ultra Think is locked for this conversation.', 'info', 3500);
            return true;
        }
        if (route === CONVERSATION_ROUTE_VIDEO) {
            notificationService?.show('This conversation is using video input mode. Start a new conversation to use Ultra Think.', 'warning', 5000);
            return false;
        }
        if (fileAttachmentHandler?.hasAttachedVideo?.()) {
            notificationService?.show('Remove video attachments before enabling Ultra Think.', 'warning', 5000);
            syncUltraThinkControl();
            return false;
        }

        const nextEnabled = typeof forceEnabled === 'boolean'
            ? forceEnabled
            : getEffectiveThinkingMode() !== THINKING_MODE_ULTRA;
        setThinkingMode(nextEnabled ? THINKING_MODE_ULTRA : THINKING_MODE_STANDARD);
        return getEffectiveThinkingMode() === THINKING_MODE_ULTRA;
    },

    getThinkingMode() {
        return getEffectiveThinkingMode();
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
    setToolEnabled(key, enabled) {
        if (!Object.hasOwn(defaultToolsConfig, key)) throw new Error('Unknown tool.');
        chatConfig.tools[key] = Boolean(enabled);
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
