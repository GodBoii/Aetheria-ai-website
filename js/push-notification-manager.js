import { supabase } from './supabase-client.js';
import { config } from './config.js';

const DEVICE_ID_KEY = 'aetheria_device_id';

function getOrCreateDeviceId() {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const generated = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
}

class PushNotificationManager {
    constructor() {
        this._initStarted = false;
        this._listenersBound = false;
        this._registerRequested = false;
        this._currentToken = null;
        this._lastSyncedToken = null;
        this._platform = 'web';
        this._PushNotifications = null;
    }

    _getPushPlugin() {
        return null;
    }

    async init() {
        if (this._initStarted) return;
        this._initStarted = true;

        try {
            await this.ensurePermission({ forcePrompt: false });
        } catch (e) {
            console.warn('[PushManager] Push init failed:', e);
        }
    }

    async ensurePermission({ forcePrompt = false } = {}) {
        if (!this._PushNotifications) {
            if (!('Notification' in window)) return 'denied';
            if (!forcePrompt) return Notification.permission || 'default';
            try {
                return await Notification.requestPermission();
            } catch (_) {
                return 'denied';
            }
        }

        try {
            const current = await this._PushNotifications.checkPermissions();
            let receive = current?.receive || 'prompt';

            if (receive === 'prompt' && forcePrompt) {
                const requested = await this._PushNotifications.requestPermissions();
                receive = requested?.receive || 'denied';
            }

            if (receive === 'granted') {
                await this._registerForPush();
            }
            return receive;
        } catch (e) {
            console.warn('[PushManager] Permission check/request failed:', e);
            return 'denied';
        }
    }

    _bindListeners() {
        if (this._listenersBound || !this._PushNotifications) return;
        this._listenersBound = true;

        this._PushNotifications.addListener('registration', async (token) => {
            const value = token?.value;
            if (!value) return;
            this._currentToken = value;
            await this._syncTokenToBackend(value);
        });

        this._PushNotifications.addListener('registrationError', (error) => {
            console.warn('[PushManager] Registration error:', error);
        });

        this._PushNotifications.addListener('pushNotificationReceived', (notification) => {
            console.log('[PushManager] Push received:', notification?.title || '(no title)');
        });

        this._PushNotifications.addListener('pushNotificationActionPerformed', (notificationAction) => {
            const data = notificationAction?.notification?.data || {};
            const conversationId = data.conversationId || data.conversation_id;
            if (!conversationId) return;
            document.dispatchEvent(new CustomEvent('notification-tapped', {
                detail: { conversationId: String(conversationId) }
            }));
        });
    }

    async _registerForPush() {
        if (this._registerRequested || !this._PushNotifications) return;
        this._registerRequested = true;
        try {
            await this._PushNotifications.register();
        } catch (e) {
            this._registerRequested = false;
            console.warn('[PushManager] Push register() failed:', e);
        }
    }

    async _syncTokenToBackend(token) {
        if (!token || token === this._lastSyncedToken) return;
        try {
            await supabase.auth.refreshSession();
            const { data: { session } } = await supabase.auth.getSession();
            if (!session?.access_token) return;

            const response = await fetch(`${config.backend.url}/api/notifications/push-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    fcmToken: token,
                    deviceId: getOrCreateDeviceId(),
                    platform: this._platform || 'android',
                }),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }
            this._lastSyncedToken = token;
            console.log('[PushManager] Push token synced with backend.');
        } catch (e) {
            console.warn('[PushManager] Failed to sync push token:', e);
        }
    }
}

const pushNotificationManager = new PushNotificationManager();
export default pushNotificationManager;
