import { supabaseSettings } from './runtime-config.js';

/**
 * Configuration for the AI-OS application
 */
export const config = {
    // Backend connection settings
    backend: {
        // URL for the Python backend - Production
        url: 'https://api.aetheriaai.website',

        // Maximum number of reconnection attempts
        maxReconnectAttempts: 50,

        // Delay between reconnection attempts (in milliseconds)
        reconnectDelay: 20000,

        // Connection timeout (in milliseconds)
        connectionTimeout: 20000
    },

    supabase: supabaseSettings
};
