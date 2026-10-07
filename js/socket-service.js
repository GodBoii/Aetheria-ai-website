import { getAuthenticatedSession } from './session-auth.js';
// js/socket-service.js (Updated)

// This service manages the WebSocket connection to the backend.

import { supabase } from './supabase-client.js';
import { config } from './config.js';

// Backend URL - Local Testing

const BACKEND_URL = config.backend.url;

let socket = null;
let socketAuthToken = null;
let authListenerBound = false;
let initialization = null;
let generation = 0;

// Store callbacks for different events.

const eventListeners = {

    'response': [],

    'agent_step': [],
    'reasoning_step': [],

    'error': [],

    'status': [],

    'connect': [],

    'disconnect': [],

    'sandbox-command-started': [],

    'sandbox-command-finished': [],

    'sandbox-artifacts-created': [],

    'browser-command': [],

    'image_generated': [],

    'browser_screenshot': [],

    'run_status': [],    // run state on reconnect: running | completed | failed | idle

    'run_catchup': [],   // full response delivered after reconnect

    'run_completed': [], // agent finished — trigger local notification

    'plan_response': [],
    'presentation_generated': [],
    'user_question': [],
    'user_question_ack': [],

};

// Store terminal execution data for artifact buttons

const terminalExecutions = new Map();

/**
 * Detect device type for browser tool selection
 * @returns {string} 'desktop', 'mobile', or 'web'
 */
function getDeviceType() {
    return 'web';
}

function setupSocketHandlers() {

    socket.on('connect', () => {

        emitEvent('connect');

    });

    socket.on('connect_error', () => emitEvent('disconnect', { reason: 'connection_error' }));

    socket.on('disconnect', () => {

        console.warn('Disconnected from backend socket server.');

        emitEvent('disconnect');

    });

    socket.on('response', (data) => emitEvent('response', data));

    socket.on('agent_step', (data) => emitEvent('agent_step', data)); // <-- NEW: Handle the event
    socket.on('reasoning_step', (data) => emitEvent('reasoning_step', data));

    socket.on('error', (data) => emitEvent('error', data));

    socket.on('status', (data) => emitEvent('status', data));

    socket.on('sandbox-command-started', (data) => {

        // Store execution data for terminal artifact button

        if (data.execution_id) {

            terminalExecutions.set(data.execution_id, {

                command: data.command || '',

                status: 'running',

                startedAt: Date.now(),

                messageId: data.id || data.messageId

            });

        }

        emitEvent('sandbox-command-started', data);

    });

    socket.on('sandbox-command-finished', (data) => {

        // Update execution data with results

        if (data.execution_id) {

            terminalExecutions.set(data.execution_id, {

                command: data.command || terminalExecutions.get(data.execution_id)?.command || '',

                stdout: data.stdout || '',

                stderr: data.stderr || '',

                exitCode: data.exit_code,

                status: 'completed',

                finishedAt: Date.now(),

                messageId: data.id || data.messageId

            });

        }

        emitEvent('sandbox-command-finished', data);

    });

    socket.on('sandbox-artifacts-created', (data) => emitEvent('sandbox-artifacts-created', data));

    socket.on('browser-command', (data) => emitEvent('browser-command', data));

    socket.on('image_generated', (data) => emitEvent('image_generated', data));

    socket.on('browser_screenshot', (data) => emitEvent('browser_screenshot', data));

    // Queued-run system events
    socket.on('run_status', (data) => emitEvent('run_status', data));
    socket.on('run_catchup', (data) => emitEvent('run_catchup', data));
    socket.on('run_completed', (data) => emitEvent('run_completed', data));
    socket.on('plan_response', (data) => emitEvent('plan_response', data));
    socket.on('presentation_generated', (data) => emitEvent('presentation_generated', data));
    socket.on('user_question', (data) => emitEvent('user_question', data));
    socket.on('user_question_ack', (data) => emitEvent('user_question_ack', data));

}

function emitEvent(eventName, data) {

    if (eventListeners[eventName]) {

        eventListeners[eventName].forEach(callback => callback(data));

    }

}

export const socketService = {

    /**

     * Initializes the socket connection if it doesn't already exist.

     */

    init: async () => {
        if (!authListenerBound) {
            authListenerBound = true;
            supabase.auth.onAuthStateChange((event, session) => {
                // Leave the auth SDK callback before requesting another session.
                setTimeout(() => {
                    if (event === 'SIGNED_OUT') socketService.disconnect();
                    else if (session?.access_token && !socket) socketService.init().catch(error => emitEvent('error', { message: error.message }));
                    else if (session?.access_token && socket) {
                        socketAuthToken = session.access_token;
                        socket.auth = { ...(socket.auth || {}), token: socketAuthToken };
                    }
                }, 0);
            });
        }

        if (socket) return;
        if (initialization) return initialization;
        const currentGeneration = generation;
        const pending = (async () => {
            const { data, error } = await supabase.auth.getSession();
            if (error) throw error;
            if (!data?.session?.access_token) return;
            const session = await getAuthenticatedSession();
            if (currentGeneration !== generation || socket) return;
            socketAuthToken = session.access_token;
            socket = io(BACKEND_URL, {
                transports: ['websocket', 'polling'],
                tryAllTransports: true,
                auth: { token: socketAuthToken },
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 10000,
                reconnectionAttempts: config.backend.maxReconnectAttempts,
                timeout: config.backend.connectionTimeout,
            });
            setupSocketHandlers();
        })();
        initialization = pending;
        try { await pending; }
        finally { if (initialization === pending) initialization = null; }

    },

    /**

     * Sends a message payload to the backend.

     * @param {object} messagePayload - The data to send.

     * @throws {Error} If the socket is not connected or the user is not authenticated.

     */

    sendMessage: async (messagePayload) => {

        if (!socket || !socket.connected) {

            console.error('Socket not connected. Cannot send message.');

            // Throw an error instead of using alert, so the UI can handle it gracefully.

            throw new Error('Not connected to the server. Please wait or refresh.');

        }

        // Verify the user is still authenticated before sending.

        const session = await getAuthenticatedSession();

        if (!session) {

            console.error('User is not authenticated.');

            // Throw an error for the UI to handle.

            throw new Error('You are not logged in. Please log in to chat.');

        }

        if (session?.access_token && session.access_token !== socketAuthToken) {
            socketAuthToken = session.access_token;
            socket.auth = { ...(socket.auth || {}), token: socketAuthToken };
        }

        // Include the refreshed token because an established socket may still
        // carry an older handshake token after a Supabase session refresh.

        const authenticatedPayload = {

            ...messagePayload,
            supports_user_questions: true,

            accessToken: session.access_token,

            deviceType: getDeviceType() // ADD DEVICE TYPE DETECTION

        };

        // Log device type for debugging

        // The backend expects the entire payload to be a single JSON string.

        socket.emit('send_message', JSON.stringify(authenticatedPayload));

    },

    submitUserAnswers: async (payload) => {
        if (!socket?.connected) throw new Error('Reconnect before submitting answers.');
        const { data, error } = await supabase.auth.getSession();
        if (error || !data?.session?.access_token) throw new Error('Sign in before answering.');
        socket.emit('submit_user_answers', { ...payload, accessToken: data.session.access_token });
    },

    terminateConversation: async (conversationId, messageId = null) => {
        return socketService.sendMessage({
            type: 'terminate_session',
            conversationId,
            id: messageId,
        });
    },

    sendPlanRequest: async (planPayload = {}) => {
        if (!socket || !socket.connected) {
            console.error('Socket not connected. Cannot send plan request.');
            throw new Error('Not connected to the server. Please wait or refresh.');
        }
        const session = await getAuthenticatedSession();

        if (!session) {
            console.error('User is not authenticated.');
            throw new Error('You are not logged in. Please log in to create a plan.');
        }

        if (session?.access_token && session.access_token !== socketAuthToken) {
            socketAuthToken = session.access_token;
            socket.auth = { ...(socket.auth || {}), token: socketAuthToken };
        }

        const authenticatedPayload = {
            ...planPayload,
            supports_user_questions: true,
            accessToken: session.access_token,
            deviceType: getDeviceType()
        };

        socket.emit('plan_request', JSON.stringify(authenticatedPayload));
    },

    /**

     * Allows other modules to register a callback for a specific socket event.

     * @param {string} eventName - The name of the event (e.g., 'response', 'error').

     * @param {function} callback - The function to call when the event occurs.

     */

    on: (eventName, callback) => {

        if (eventListeners[eventName]) {

            eventListeners[eventName].push(callback);

        }

    },

    /**

     * Disconnects the socket if it's currently connected.

     */

    disconnect: () => {
        generation += 1;
        socketAuthToken = null;

        if (socket) {

            socket.disconnect();

            socket = null;

        }

    },

    /**

     * Get terminal execution data by execution_id

     */

    getTerminalExecution: (executionId) => {

        return terminalExecutions.get(executionId);

    },

    /**

     * Clear all terminal execution data (called on new conversation)

     */

    clearTerminalExecutions: () => {

        terminalExecutions.clear();

    },

    /**
     * Join a conversation room on the backend so this socket receives
     * all streaming events for that conversation.
     * Called on connect and whenever the active conversation changes.
     * @param {string} conversationId
     */
    joinConversation: (conversationId) => {

        if (!socket || !socket.connected || !conversationId) {

            return;

        }

        socket.emit('join_conversation', {
            conversationId,
            accessToken: socketAuthToken
        });

    },

    /**
     * Get current device type
     */
    getDeviceType: () => {
        return getDeviceType();
    }

};
