// js/background-run-manager.js
//
// Single-responsibility: lifecycle tracking + native notifications.
// DOES NOT render anything into the DOM — that is chat.js's job.
//
// NATIVE NOTIFICATION FLOW:
//   • App goes to background while a run is in progress
//       → schedule "Your 'XYZ' conversation is running in the background"
//   • Run completes while app is backgrounded
//       → schedule "Your 'XYZ' task is complete! Tap to view."
//   • Run fails while app is backgrounded
//       → schedule "Your 'XYZ' request ran into an error."
//
// STATE (localStorage  key: "aetheria_queued_runs"):
//   { [conversationId]: { conversationId, messageId, title, status, queuedAt, notified } }

import { socketService } from './socket-service.js';

const STORAGE_KEY = 'aetheria_queued_runs';

class BackgroundRunManager {
    constructor() {
        this._queuedRuns = this._load();       // persisted run registry
        this._listenerOk = false;              // visibility listener attached?
        this._appActive = true;               // is the app in the foreground?
        this._joinedRooms = new Set();          // rooms already joined this session
        this._onCompleted = [];                 // (convId, {messageId,content,title}) => void
        this._onFailed = [];                 // (convId, error) => void
        this._notificationPermission = null;    // cached permission state
    }

    // ------------------------------------------------------------------ //
    // PUBLIC API                                                           //
    // ------------------------------------------------------------------ //

    /**
     * Call once after socketService is ready.
     * @param {function} onCompleted  - (conversationId, {messageId,content,title}) => void
     * @param {function} onFailed     - (conversationId, error) => void
     */
    init(onCompleted, onFailed) {
        if (onCompleted) this._onCompleted.push(onCompleted);
        if (onFailed) this._onFailed.push(onFailed);
        this._attachLifecycleListener();
        console.log('[BRM] Initialized. Queued runs:', Object.keys(this._queuedRuns));
    }

    /** Called by chat.js immediately after send_message is emitted. */
    markRunStarted(conversationId, messageId, title = null) {
        this._queuedRuns[conversationId] = {
            conversationId,
            messageId,
            title,
            status: 'running',
            queuedAt: Date.now(),
            notified: false,
        };
        this._save();
        // If the app is already in the background, schedule the "in progress" notification
        if (!this._appActive) {
            this._notifyRunningInBackground(conversationId, title);
        }
        // Ensure we're in the conversation room
        this._joinRoom(conversationId);
        console.log('[BRM] Run started:', conversationId);
    }

    /**
     * Called by chat.js when the live `done` event arrives
     * (user was watching the response in real-time — no notification needed).
     */
    markRunCompleted(conversationId) {
        const entry = this._queuedRuns[conversationId];
        if (entry) {
            entry.status = 'completed';
            entry.notified = true;   // user saw it live
            this._save();
        }
        console.log('[BRM] Run completed (live):', conversationId);
    }

    /** Called by chat.js when the run errored out and the user saw it live. */
    markRunFailed(conversationId, error) {
        const entry = this._queuedRuns[conversationId];
        if (entry) {
            entry.status = 'failed';
            entry.error = error;
            this._save();
        }
    }

    /** Remove a conversation from the registry (e.g. user explicitly clears it). */
    clearRun(conversationId) {
        if (this._queuedRuns[conversationId]) {
            delete this._queuedRuns[conversationId];
            this._save();
        }
        this._joinedRooms.delete(conversationId);
    }

    /**
     * Called by chat.js when the server sends `run_catchup` and the response
     * was rendered.  Triggers native notification only if the app is backgrounded.
     */
    onCatchupRendered(conversationId, title) {
        const entry = this._queuedRuns[conversationId];
        const shouldNotify = entry && !entry.notified;

        if (entry) {
            entry.status = 'completed';
            entry.notified = true;
            this._save();
        }

        if (shouldNotify && !this._appActive) {
            this._notifyCompleted(conversationId, title);
        }
        this._onCompleted.forEach(fn => { try { fn(conversationId, null); } catch (_) { } });
    }

    /**
     * Called by chat.js when `run_catchup` arrives for a conversation that
     * the user was NOT actively viewing (different conv or cold start).
     * Always fires a native notification.
     */
    onBackgroundCatchupReceived(conversationId, title) {
        const entry = this._queuedRuns[conversationId];
        if (entry) {
            entry.status = 'completed';
            entry.notified = true;
            this._save();
        }
        // Always notify — user missed the response
        this._notifyCompleted(conversationId, title);
    }

    /**
     * Called by chat.js on every `connect` event via handleSocketConnect.
     * Re-joins ALL rooms that have a queued/running run.
     * Deduplication via _joinedRooms so we never fire join_conversation twice.
     */
    rejoinAllRunning() {
        Object.values(this._queuedRuns).forEach((entry) => {
            if (entry.status === 'running') {
                this._joinRoom(entry.conversationId);
            }
        });
    }

    /**
     * Expose runnable status check so chat.js can ask "does this conv have
     * a queued run I should watch for?"
     */
    hasRunningEntry(conversationId) {
        const e = this._queuedRuns[conversationId];
        return e && e.status === 'running';
    }

    /** Returns the stored entry for a conversation (or null). */
    getEntry(conversationId) {
        return this._queuedRuns[conversationId] || null;
    }

    /**
     * Foreground-only permission helper.
     * Call this from explicit UI actions (e.g. first send).
     */
    async ensureNotificationPermission({ forcePrompt = false } = {}) {
        if (!('Notification' in window)) return 'denied';
        if (!forcePrompt) return Notification.permission || 'default';
        try {
            const perm = await Notification.requestPermission();
            return perm || 'default';
        } catch (_) {
            return 'denied';
        }
    }

    // ------------------------------------------------------------------ //
    // INTERNAL — ROOM JOINING (with dedup)                                //
    // ------------------------------------------------------------------ //

    _joinRoom(conversationId) {
        if (!conversationId) return;
        if (this._joinedRooms.has(conversationId)) return;   // already joined this session
        this._joinedRooms.add(conversationId);
        socketService.joinConversation(conversationId);
        console.log('[BRM] Joined room for:', conversationId);
    }

    /**
     * Reset join dedup on full disconnect so that on the next connect
     * we re-join properly (the server loses all room state on disconnect).
     */
    resetRoomTracking() {
        this._joinedRooms.clear();
    }

    // ------------------------------------------------------------------ //
    // INTERNAL — CAPACITOR / PAGE VISIBILITY LISTENER                     //
    // ------------------------------------------------------------------ //

    _attachLifecycleListener() {
        if (this._listenerOk) return;

        document.addEventListener('visibilitychange', () => {
            this._appActive = document.visibilityState === 'visible';
            if (this._appActive) {
                this.resetRoomTracking();
                return;
            }

            Object.values(this._queuedRuns).forEach(entry => {
                if (entry.status === 'running' && !entry.bgNotified) {
                    entry.bgNotified = true;
                    this._save();
                    this._notifyRunningInBackground(entry.conversationId, entry.title);
                }
            });
        });
        this._listenerOk = true;
    }

    // ------------------------------------------------------------------ //
    // INTERNAL — NATIVE NOTIFICATIONS                                     //
    // ------------------------------------------------------------------ //

    async _notifyRunningInBackground(conversationId, title) {
        const label = title ? `"${title}"` : 'your conversation';
        await this._scheduleNotification(
            '⏳ Aetheria AI',
            `${label} is running in the background…`,
            conversationId,
        );
    }

    async _notifyCompleted(conversationId, title) {
        const label = title ? `"${title}"` : 'Your AI task';
        await this._scheduleNotification(
            '✅ Aetheria AI',
            `${label} is complete! Tap to view.`,
            conversationId,
        );
    }

    async _notifyFailed(conversationId, title) {
        const label = title ? `"${title}"` : 'Your AI request';
        await this._scheduleNotification(
            '⚠️ Aetheria AI',
            `${label} ran into an error. Tap to retry.`,
            conversationId,
        );
    }

    async _scheduleNotification(title, body, conversationId) {
        this._fallbackWebNotification(title, body);
    }

    _fallbackWebNotification(title, body) {
        if (!('Notification' in window)) return;
        const show = () => { try { new Notification(title, { body, icon: '/assets/icon.png' }); } catch (_) { } };
        if (Notification.permission === 'granted') {
            show();
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => { if (p === 'granted') show(); });
        }
    }

    // ------------------------------------------------------------------ //
    // INTERNAL — PERSISTENCE                                               //
    // ------------------------------------------------------------------ //

    _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    }

    _save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._queuedRuns)); } catch (_) { }
    }
}

const backgroundRunManager = new BackgroundRunManager();
export default backgroundRunManager;
