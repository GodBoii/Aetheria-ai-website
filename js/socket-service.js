// js/socket-service.js (Updated)



// This service manages the WebSocket connection to the backend.

import { supabase } from './supabase-client.js';



// Backend URL - Local Testing

const BACKEND_URL = 'https://api.pawsitivestrides.store';

let socket = null;
let socketAuthToken = null;



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

};



// Store terminal execution data for artifact buttons

const terminalExecutions = new Map();



/**
 * Detect device type for browser tool selection
 * @returns {string} 'desktop', 'mobile', or 'web'
 */
function getDeviceType() {
    // Check for Electron (desktop app)
    if (window.electronAPI) {
        return 'desktop';
    }

    // Default to web (PWA in browser)
    return 'web';
}



function setupSocketHandlers() {

    socket.on('connect', () => {

        console.log('Successfully connected to backend socket server.');

        emitEvent('connect');

    });



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

        // Prevent creating a new socket if one already exists or is connecting.

        if (socket) {

            return;

        }



        console.log("Initializing socket connection to:", BACKEND_URL);

        try {
            await supabase.auth.refreshSession();
            const { data: { session } } = await supabase.auth.getSession();
            socketAuthToken = session?.access_token || null;
        } catch (error) {
            console.warn('[Socket] Unable to prepare auth token for socket handshake:', error);
            socketAuthToken = null;
        }

        // The 'io' function is available globally from the script in index.html

        socket = io(BACKEND_URL, {

            transports: ['websocket'],

            auth: socketAuthToken ? { token: socketAuthToken } : undefined,

            reconnection: true,

            reconnectionDelay: 2000,

            reconnectionAttempts: 5

        });

        setupSocketHandlers();

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

        await supabase.auth.refreshSession(); // Ensure the token is fresh

        const { data: { session } } = await supabase.auth.getSession();



        if (!session) {

            console.error('User is not authenticated.');

            // Throw an error for the UI to handle.

            throw new Error('You are not logged in. Please log in to chat.');

        }



        if (session?.access_token && session.access_token !== socketAuthToken) {
            socketAuthToken = session.access_token;
            socket.auth = { ...(socket.auth || {}), token: socketAuthToken };
        }

        // Add device type to the payload. The access token is sent via the socket
        // auth handshake instead of every message payload.

        const authenticatedPayload = {

            ...messagePayload,

            deviceType: getDeviceType() // ADD DEVICE TYPE DETECTION

        };


        // Log device type for debugging
        console.log(`[Device Detection] Sending message with deviceType: ${authenticatedPayload.deviceType}`);



        // The backend expects the entire payload to be a single JSON string.

        socket.emit('send_message', JSON.stringify(authenticatedPayload));

    },

    terminateConversation: async (conversationId, messageId = null) => {
        return socketService.sendMessage({
            type: 'terminate_session',
            conversationId,
            id: messageId,
        });
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

        socket.emit('join_conversation', { conversationId });

        console.log(`[SocketService] Joined conversation room: ${conversationId}`);

    },

    /**
     * Get current device type
     */
    getDeviceType: () => {
        return getDeviceType();
    }

};
