// js/context-handler.js (Corrected)

import { supabase } from './supabase-client.js';
import { messageFormatter } from './message-formatter.js';
import NotificationService from './notification-service.js';
import skeletonLoader from './skeleton-loader.js';
import { config } from './config.js';
import { artifactHandler } from './artifact-handler.js';
import { sessionContentViewer } from './session-content-viewer.js';

const convertTimestampToSeconds = (timestampValue) => {
    if (timestampValue === null || timestampValue === undefined) {
        return Math.floor(Date.now() / 1000);
    }

    if (typeof timestampValue === 'string') {
        if (/^\d+$/.test(timestampValue)) {
            return convertTimestampToSeconds(Number(timestampValue));
        }

        const parsedDate = Date.parse(timestampValue);
        if (!Number.isNaN(parsedDate)) {
            return Math.floor(parsedDate / 1000);
        }

        return Math.floor(Date.now() / 1000);
    }

    const numericValue = Number(timestampValue);
    if (!Number.isFinite(numericValue)) {
        return Math.floor(Date.now() / 1000);
    }

    if (numericValue > 1e15) {
        return Math.floor(numericValue / 1e6); // microseconds
    }

    if (numericValue > 1e12) {
        return Math.floor(numericValue / 1e3); // milliseconds
    }

    return Math.floor(numericValue);
};

const getSessionWorkspaceInfo = (session = {}) => {
    const agentId = String(session.agent_id || '').toLowerCase();

    if (agentId === 'aetheria-coder') {
        return {
            type: 'coder',
            label: 'Coder',
            title: 'Coder Workspace chat',
            icon: 'fa-code'
        };
    }

    if (agentId === 'aetheria-computer') {
        return {
            type: 'computer',
            label: 'Computer',
            title: 'Computer Workspace chat',
            icon: 'fa-desktop'
        };
    }

    return {
        type: 'normal',
        label: '',
        title: 'Normal chat',
        icon: ''
    };
};

class ContextHandler {
    constructor({ preloadDelay = 2500 } = {}) {
        this.loadedSessions = [];
        this.selectedContextSessions = [];
        this.elements = {};
        this.triggerButton = null;
        this.notificationService = new NotificationService();

        this.preloadDelay = preloadDelay;
        this.loadingState = 'idle'; // idle | loading | loaded | error
        this.loadError = null;
        this.backgroundLoadTimer = null;
        this.isWindowOpen = false;
        this.pendingLoadPromise = null;

        // Pagination state
        this.currentOffset = 0;
        this.pageSize = 15;
        this.totalSessions = 0;
        this.hasMoreSessions = false;
        this.isLoadingMore = false;
    }

    initializeElements() {
        console.log('[ContextHandler] Initializing elements...');
        this.elements.contextWindow = document.getElementById('context-window');

        if (!this.elements.contextWindow) {
            console.error('[ContextHandler] context-window element not found in DOM!');
            return;
        }

        this.elements.panel = this.elements.contextWindow.querySelector('.context-window-panel');
        this.elements.closeContextBtn = this.elements.contextWindow.querySelector('.close-context-btn');
        this.elements.syncBtn = this.elements.contextWindow.querySelector('.sync-context-btn');
        this.elements.sessionsContainer = this.elements.contextWindow.querySelector('.context-content');
        this.elements.listView = document.getElementById('context-list-view');
        this.elements.detailView = document.getElementById('context-detail-view');
        this.elements.contextBtn = document.querySelector('[data-tool="context"]');

        console.log('[ContextHandler] Elements initialized:', {
            hasContextWindow: !!this.elements.contextWindow,
            hasPanel: !!this.elements.panel,
            hasCloseBtn: !!this.elements.closeContextBtn,
            hasSyncBtn: !!this.elements.syncBtn,
            hasSessionsContainer: !!this.elements.sessionsContainer,
            hasListView: !!this.elements.listView,
            hasDetailView: !!this.elements.detailView,
            hasContextBtn: !!this.elements.contextBtn
        });
    }

    bindEvents() {
        if (!this.elements.contextWindow) return;

        this.elements.contextWindow.addEventListener('click', (event) => {
            if (event.target === this.elements.contextWindow) {
                this.toggleWindow(false);
            }
        });
        this.elements.panel?.addEventListener('click', (e) => e.stopPropagation());
        this.elements.closeContextBtn?.addEventListener('click', () => this.toggleWindow(false));

        // Sync/refresh button
        this.elements.syncBtn?.addEventListener('click', () => {
            this.forceRefreshSessions();
        });

        this.elements.sessionsContainer?.addEventListener('change', (e) => {
            if (e.target.matches('.session-checkbox')) {
                const sessionItem = e.target.closest('.session-item');
                if (sessionItem) {
                    sessionItem.classList.toggle('selected', e.target.checked);
                    this.updateSelectionUI();
                }
            }
        });

        // Infinite scroll listener
        this.elements.sessionsContainer?.addEventListener('scroll', () => {
            this.handleScroll();
        });
    }

    toggleWindow(show, buttonElement = null) {
        console.log('[ContextHandler] toggleWindow called:', { show, hasElement: !!this.elements.contextWindow });

        if (!this.elements.contextWindow) {
            console.error('[ContextHandler] contextWindow element not found!');
            return;
        }

        if (show) {
            console.log('[ContextHandler] Opening window, loadingState:', this.loadingState);
            this.isWindowOpen = true;
            if (buttonElement) {
                this.triggerButton = buttonElement;
                this.triggerButton.classList.add('active');
            }

            this.elements.contextWindow.classList.remove('hidden');
            console.log('[ContextHandler] Window classList after remove hidden:', this.elements.contextWindow.classList.toString());

            this.renderCurrentState();

            if (this.loadingState === 'idle') {
                console.log('[ContextHandler] Starting loadSessionsInBackground...');
                this.loadSessionsInBackground().catch((err) => {
                    console.error('[ContextHandler] Context preload failed:', err);
                });
            } else {
                console.log('[ContextHandler] Skipping load, state is:', this.loadingState);
            }
        } else {
            console.log('[ContextHandler] Closing window');
            this.isWindowOpen = false;
            this.elements.contextWindow.classList.add('hidden');
            if (this.triggerButton) {
                this.triggerButton.classList.remove('active');
                this.triggerButton = null;
            }
        }
    }

    preloadSessions() {
        if (this.loadingState !== 'idle') return;

        if (this.backgroundLoadTimer) {
            clearTimeout(this.backgroundLoadTimer);
        }

        this.backgroundLoadTimer = setTimeout(() => {
            this.backgroundLoadTimer = null;
            this.loadSessionsInBackground().catch((err) => {
                console.warn('Background session preload failed (this is normal if backend is unavailable):', err.message);
                // Don't show error notification for background preload failures
                // User will see error only when they actually open the sessions window
            });
        }, this.preloadDelay);
    }

    async loadSessionsInBackground({ force = false } = {}) {
        console.log('[ContextHandler] loadSessionsInBackground called:', { force, loadingState: this.loadingState });

        if (!force) {
            if (this.loadingState === 'loading' && this.pendingLoadPromise) {
                console.log('[ContextHandler] Already loading, returning existing promise');
                return this.pendingLoadPromise;
            }
            if (this.loadingState === 'loaded' && this.loadedSessions.length > 0) {
                console.log('[ContextHandler] Already loaded, returning cached sessions:', this.loadedSessions.length);
                return Promise.resolve(this.loadedSessions);
            }
        } else if (this.pendingLoadPromise) {
            console.log('[ContextHandler] Force refresh but already loading');
            return this.pendingLoadPromise;
        }

        if (this.backgroundLoadTimer) {
            clearTimeout(this.backgroundLoadTimer);
            this.backgroundLoadTimer = null;
        }

        console.log('[ContextHandler] Setting state to loading');
        this.loadingState = 'loading';
        this.loadError = null;

        // Reset pagination on initial load
        this.currentOffset = 0;
        this.loadedSessions = [];

        if (this.isWindowOpen) {
            console.log('[ContextHandler] Window is open, rendering loading state');
            this.renderLoadingState();
        }

        const loadPromise = (async () => {
            try {
                console.log('[ContextHandler] Attempting Supabase session refresh...');
                try {
                    await supabase.auth.refreshSession();
                    console.log('[ContextHandler] Supabase session refresh successful');
                } catch (refreshError) {
                    console.warn('[ContextHandler] Supabase session refresh failed:', refreshError);
                }

                console.log('[ContextHandler] Getting Supabase session...');
                const { data: authData, error: authError } = await supabase.auth.getSession();
                const session = authData?.session;
                console.log('[ContextHandler] Session retrieved:', { hasSession: !!session, hasToken: !!session?.access_token, error: authError });

                if (authError || !session?.access_token) {
                    throw new Error('Please log in to view chat history.');
                }

                const userId = session.user.id;
                console.log('[ContextHandler] Fetching sessions with title fallback for user:', userId);

                const { sessions, total } = await this.fetchSessionsBatch(userId, this.currentOffset, this.pageSize);

                this.loadedSessions = sessions;
                this.currentOffset += sessions.length;
                this.totalSessions = Number.isFinite(total) ? total : sessions.length;
                this.hasMoreSessions = this.currentOffset < this.totalSessions;

                this.loadingState = 'loaded';
                this.loadError = null;

                console.log('[ContextHandler] Sessions loaded successfully:', {
                    count: this.loadedSessions.length,
                    total: this.totalSessions,
                    hasMore: this.hasMoreSessions
                });

                if (this.isWindowOpen) {
                    console.log('[ContextHandler] Window is open, showing session list');
                    this.showSessionList(this.loadedSessions);
                } else {
                    console.log('[ContextHandler] Window is closed, not rendering');
                }

                return this.loadedSessions;
            } catch (err) {
                console.error('[ContextHandler] Failed to load sessions:', err);
                console.error('[ContextHandler] Error details:', { name: err.name, message: err.message, stack: err.stack });

                // Handle different error types
                if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                    this.loadError = 'Request timed out. Please try again.';
                } else if (err.message.includes('Failed to fetch') || err.message.includes('Network')) {
                    this.loadError = 'Network error. Please check your internet connection and try again.';
                } else if (err.message.includes('offline')) {
                    this.loadError = 'You appear to be offline. Please check your internet connection.';
                } else {
                    this.loadError = err?.message || 'An unexpected error occurred while loading sessions.';
                }

                console.log('[ContextHandler] Setting error state:', this.loadError);
                this.loadingState = 'error';

                if (this.isWindowOpen) {
                    console.log('[ContextHandler] Window is open, rendering error state');
                    this.renderErrorState();
                } else {
                    console.log('[ContextHandler] Window is closed, not rendering error');
                }
                throw err;
            } finally {
                this.pendingLoadPromise = null;
            }
        })();

        this.pendingLoadPromise = loadPromise;
        return loadPromise;
    }

    async fetchSessionsBatch(userId, offset, limit) {
        if (limit <= 0) {
            return { sessions: [], total: 0 };
        }

        const rangeEnd = offset + limit - 1;
        const { data: sessionRows, error: sessionsError, count } = await supabase
            .from('agno_sessions')
            .select('session_id, created_at, session_type, agent_id, team_id', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, rangeEnd);

        if (sessionsError) {
            console.error('[ContextHandler] Error fetching sessions from agno_sessions:', sessionsError);
            throw new Error(`Failed to load sessions: ${sessionsError.message}`);
        }

        const sessionIds = (sessionRows || []).map(row => row.session_id);
        let titlesMap = new Map();

        if (sessionIds.length > 0) {
            const { data: titlesData, error: titlesError } = await supabase
                .from('session_titles')
                .select('session_id, tittle')
                .eq('user_id', userId)
                .in('session_id', sessionIds);

            if (titlesError) {
                console.warn('[ContextHandler] Unable to fetch titles for some sessions:', titlesError);
            } else {
                titlesMap = new Map((titlesData || []).map(title => [title.session_id, title.tittle]));
            }
        }

        const sessions = (sessionRows || []).map(row => ({
            session_id: row.session_id,
            title: titlesMap.get(row.session_id) || null,
            created_at: convertTimestampToSeconds(row.created_at),
            session_type: row.session_type || null,
            agent_id: row.agent_id || null,
            team_id: row.team_id || null,
            runs: []
        }));

        await this.populateMissingTitles(userId, sessions);

        return {
            sessions,
            total: typeof count === 'number' ? count : (sessionRows?.length || 0)
        };
    }

    async populateMissingTitles(userId, sessions) {
        if (!Array.isArray(sessions) || sessions.length === 0) {
            return;
        }

        const sessionsNeedingTitles = sessions.filter(session => !session.title);
        if (sessionsNeedingTitles.length === 0) {
            return;
        }

        console.log('[ContextHandler] Deriving titles for sessions without titles:', sessionsNeedingTitles.length);

        for (const session of sessionsNeedingTitles) {
            try {
                const derivedTitle = await this.deriveTitleFromSession(session.session_id);
                if (!derivedTitle) {
                    continue;
                }

                const createdAtSeconds = Number.isFinite(session.created_at)
                    ? Math.floor(session.created_at)
                    : Math.floor(Date.now() / 1000);

                await this.saveSessionTitle(userId, session.session_id, derivedTitle, createdAtSeconds);
                session.title = derivedTitle;
            } catch (error) {
                console.warn('[ContextHandler] Unable to derive/save session title:', session.session_id, error);
            }
        }
    }

    async deriveTitleFromSession(sessionId) {
        try {
            const { data, error } = await supabase
                .from('agno_sessions')
                .select('runs, session_data')
                .eq('session_id', sessionId)
                .single();

            if (error) {
                throw error;
            }

            const sessionData = data || {};
            const turnContextMessage = sessionData?.session_data?.session_state?.turn_context?.user_message;
            const titleFromContext = this.buildTitleFromMessage(turnContextMessage);
            if (titleFromContext) {
                return titleFromContext;
            }

            const runs = sessionData?.runs || [];
            if (!Array.isArray(runs) || runs.length === 0) {
                return null;
            }

            const topLevelRuns = runs.filter(run => !run.parent_run_id);
            const firstRun = topLevelRuns[0];
            if (!firstRun) {
                return null;
            }

            const userInput = firstRun.input?.input_content || firstRun.content || '';
            return this.buildTitleFromMessage(userInput);
        } catch (err) {
            console.warn('[ContextHandler] deriveTitleFromSession failed:', sessionId, err);
            return null;
        }
    }

    async saveSessionTitle(userId, sessionId, title, sessionCreatedAtSeconds) {
        try {
            await supabase
                .from('session_titles')
                .upsert({
                    session_id: sessionId,
                    user_id: userId,
                    tittle: title,
                    session_created_at: sessionCreatedAtSeconds
                });
        } catch (err) {
            console.warn('[ContextHandler] saveSessionTitle failed:', sessionId, err);
        }
    }

    buildTitleFromMessage(message) {
        if (!message || typeof message !== 'string') {
            return null;
        }

        const marker = 'Current message:';
        const markerIndex = message.lastIndexOf(marker);
        if (markerIndex !== -1) {
            message = message.substring(markerIndex + marker.length).trim();
        }

        const cleaned = message.replace(/\s+/g, ' ').trim();
        if (!cleaned) {
            return null;
        }

        const words = cleaned.split(' ');
        const maxWords = 4;
        let title = words.slice(0, maxWords).join(' ');

        if (words.length > maxWords) {
            title += '...';
        }

        const maxLength = 60;
        if (title.length > maxLength) {
            title = `${title.substring(0, maxLength - 3).trim()}...`;
        }

        return title;
    }

    async forceRefreshSessions() {
        this.loadingState = 'idle';
        this.loadError = null;
        this.currentOffset = 0;
        this.loadedSessions = [];
        return this.loadSessionsInBackground({ force: true });
    }

    async loadMoreSessions() {
        if (this.isLoadingMore || !this.hasMoreSessions) {
            console.log('[ContextHandler] Skip loadMore:', { isLoadingMore: this.isLoadingMore, hasMore: this.hasMoreSessions });
            return;
        }

        this.isLoadingMore = true;
        this.showLoadingMoreIndicator();

        try {
            await supabase.auth.refreshSession();
            const { data: authData, error: authError } = await supabase.auth.getSession();
            const session = authData?.session;

            if (authError || !session?.access_token) {
                throw new Error('Session expired. Please log in again.');
            }

            const userId = session.user.id;
            console.log('[ContextHandler] Loading more sessions, offset:', this.currentOffset);

            const { sessions: newSessions, total } = await this.fetchSessionsBatch(
                userId,
                this.currentOffset,
                this.pageSize
            );

            this.totalSessions = Number.isFinite(total) ? total : this.totalSessions;

            console.log('[ContextHandler] Loaded more sessions:', newSessions.length);

            if (newSessions.length === 0) {
                this.hasMoreSessions = false;
                return;
            }

            this.loadedSessions = [...this.loadedSessions, ...newSessions];
            this.currentOffset += newSessions.length;
            this.hasMoreSessions = this.currentOffset < this.totalSessions;

            // Append new sessions to the list
            this.appendSessionItems(newSessions);
        } catch (err) {
            console.error('[ContextHandler] Failed to load more sessions:', err);
            this.showNotification('Failed to load more sessions', 'error');
        } finally {
            this.isLoadingMore = false;
            this.hideLoadingMoreIndicator();
        }
    }

    handleScroll() {
        if (!this.elements.sessionsContainer || this.loadingState !== 'loaded') return;

        const container = this.elements.sessionsContainer;
        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const clientHeight = container.clientHeight;

        // Trigger load when user scrolls to within 200px of bottom
        const threshold = 200;
        const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);

        if (distanceFromBottom < threshold && this.hasMoreSessions && !this.isLoadingMore) {
            console.log('[ContextHandler] Scroll threshold reached, loading more sessions');
            this.loadMoreSessions();
        }
    }

    showLoadingMoreIndicator() {
        if (!this.elements.listView) return;

        let indicator = this.elements.listView.querySelector('.loading-more-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'loading-more-indicator';
            indicator.innerHTML = '<div class="session-item-loading">Loading more sessions…</div>';
            this.elements.listView.appendChild(indicator);
        }
    }

    hideLoadingMoreIndicator() {
        const indicator = this.elements.listView?.querySelector('.loading-more-indicator');
        if (indicator) {
            indicator.remove();
        }
    }

    appendSessionItems(sessions) {
        if (!this.elements.listView || !sessions || sessions.length === 0) return;

        console.log('[ContextHandler] Appending', sessions.length, 'session items');

        sessions.forEach(session => {
            this.elements.listView.appendChild(this.createSessionItem(session));
        });
    }

    renderCurrentState() {
        console.log('[ContextHandler] renderCurrentState called, state:', this.loadingState);
        switch (this.loadingState) {
            case 'loaded':
                console.log('[ContextHandler] Rendering loaded state with', this.loadedSessions.length, 'sessions');
                this.showSessionList(this.loadedSessions);
                break;
            case 'loading':
                console.log('[ContextHandler] Rendering loading state');
                this.renderLoadingState();
                break;
            case 'error':
                console.log('[ContextHandler] Rendering error state:', this.loadError);
                this.renderErrorState();
                break;
            case 'idle':
            default:
                console.log('[ContextHandler] Rendering idle state');
                this.renderIdleState();
                break;
        }
    }

    renderIdleState() {
        if (!this.elements.listView) return;
        this.elements.listView.classList.remove('hidden');
        this.elements.detailView?.classList.add('hidden');
        this.elements.listView.innerHTML = '<div class="session-item-loading">Preparing context history…</div>';
    }

    renderLoadingState() {
        if (!this.elements.listView) return;
        this.elements.listView.classList.remove('hidden');
        this.elements.detailView?.classList.add('hidden');

        // Show skeleton loading state
        skeletonLoader.showContextWindowSkeleton(this.elements.listView, 6);
    }

    renderErrorState() {
        if (!this.elements.listView) return;
        this.elements.listView.classList.remove('hidden');
        this.elements.detailView?.classList.add('hidden');

        const message = this.loadError || 'Unable to load previous sessions.';

        // Determine icon based on error type
        let icon = 'fa-exclamation-circle';
        if (message.includes('unavailable') || message.includes('503')) {
            icon = 'fa-server';
        } else if (message.includes('offline') || message.includes('Network')) {
            icon = 'fa-wifi-slash';
        } else if (message.includes('timeout')) {
            icon = 'fa-clock';
        } else if (message.includes('Authentication')) {
            icon = 'fa-lock';
        }

        this.elements.listView.innerHTML = `
            <div class="empty-state error-state">
                <i class="fas ${icon}"></i>
                <p>${message}</p>
                <button class="retry-load-btn" type="button">
                    <i class="fas fa-sync-alt"></i> Retry
                </button>
                ${message.includes('unavailable') ? `
                    <p class="error-hint">
                        <small>The backend service may be starting up or under maintenance. This usually resolves in a few minutes.</small>
                    </p>
                ` : ''}
            </div>
        `;

        this.elements.listView.querySelector('.retry-load-btn')?.addEventListener('click', () => this.forceRefreshSessions());
    }

    showSessionList(sessions) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('[ContextHandler] ✓ showSessionList CALLED');
        console.log('[ContextHandler] Sessions count:', sessions?.length);
        console.log('[ContextHandler] Elements check:', {
            hasListView: !!this.elements.listView,
            hasDetailView: !!this.elements.detailView,
            hasContextWindow: !!this.elements.contextWindow
        });

        if (!this.elements.listView || !this.elements.detailView) {
            console.error('[ContextHandler] ✗ Missing required elements for session list!');
            return;
        }

        // Show the header when returning to list view
        const contextHeader = this.elements.contextWindow?.querySelector('.context-header');
        console.log('[ContextHandler] Context header found:', !!contextHeader);
        if (contextHeader) {
            contextHeader.classList.remove('hidden-for-detail');
            console.log('[ContextHandler] ✓ Header shown (removed hidden-for-detail class)');
        }

        console.log('[ContextHandler] Switching views - showing list, hiding detail');
        this.elements.listView.classList.remove('hidden');
        this.elements.detailView.classList.add('hidden');
        this.elements.detailView.innerHTML = ''; // Clear detail view content
        this.elements.listView.innerHTML = '';
        console.log('[ContextHandler] ✓ Views switched successfully');

        if (!sessions || sessions.length === 0) {
            console.log('[ContextHandler] No sessions to display, showing empty state');
            this.elements.listView.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-comments"></i>
                    <p>No chat sessions yet.<br>Start a conversation to see your history here.</p>
                </div>
            `;
            return;
        }

        console.log('[ContextHandler] Rendering', sessions.length, 'session items');
        this.addSelectionHeader();
        this.renderSessionItems(sessions);
        this.initializeSelectionControls();
        this.updateSelectionUI();
        console.log('[ContextHandler] Session list rendered successfully');
    }

    addSelectionHeader() {
        const selectionHeader = document.createElement('div');
        selectionHeader.className = 'selection-controls';
        selectionHeader.innerHTML = `
            <div class="selection-actions hidden">
                <span class="selected-count">0 selected</span>
                <button class="use-selected-btn">Use Selected</button>
                <button class="clear-selection-btn">Clear</button>
            </div>`;
        this.elements.listView.appendChild(selectionHeader);
    }

    renderSessionItems(sessions) {
        let animIndex = 0;

        // Group sessions by date bucket
        const groups = [
            { label: 'Today',     sessions: [] },
            { label: 'Yesterday', sessions: [] },
            { label: 'This Week', sessions: [] },
            { label: 'Earlier',   sessions: [] },
        ];

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfYesterday = new Date(startOfToday);
        startOfYesterday.setDate(startOfYesterday.getDate() - 1);
        const startOfWeek = new Date(startOfToday);
        startOfWeek.setDate(startOfWeek.getDate() - 6); // last 7 days

        sessions.forEach(session => {
            const d = new Date(session.created_at * 1000);
            if (d >= startOfToday) {
                groups[0].sessions.push(session);
            } else if (d >= startOfYesterday) {
                groups[1].sessions.push(session);
            } else if (d >= startOfWeek) {
                groups[2].sessions.push(session);
            } else {
                groups[3].sessions.push(session);
            }
        });

        groups.forEach(group => {
            if (group.sessions.length === 0) return;

            // Render group label
            const label = document.createElement('div');
            label.className = 'session-date-group-label';
            label.textContent = group.label;
            this.elements.listView.appendChild(label);

            // Render items in group
            const groupEl = document.createElement('div');
            groupEl.className = 'session-date-group';
            group.sessions.forEach(session => {
                const item = this.createSessionItem(session, animIndex);
                groupEl.appendChild(item);
                animIndex++;
            });
            this.elements.listView.appendChild(groupEl);
        });
    }

    createSessionItem(session, animIndex = 0) {
        const sessionItem = document.createElement('div');
        sessionItem.className = 'session-item';
        sessionItem.dataset.sessionId = session.session_id;
        // Clamp stagger index at 14 for CSS rule coverage
        sessionItem.dataset.animIndex = Math.min(animIndex, 14);

        // Use title from session_titles table if available, otherwise fallback to session_id
        let sessionName = session.title || `Session ${session.session_id.substring(0, 8)}...`;

        // Truncate long titles
        if (sessionName.length > 55) {
            sessionName = sessionName.substring(0, 55) + '...';
        }

        const creationDate = new Date(session.created_at * 1000);
        const formattedDate = this.formatRelativeDate(creationDate);

        sessionItem.innerHTML = this.getSessionItemHTML(session, sessionName, formattedDate);

        // Click the entire row to open session (except checkbox)
        sessionItem.addEventListener('click', (e) => {
            if (!e.target.closest('.session-select')) {
                console.log('[ContextHandler] Session item clicked, ID:', session.session_id);
                this.showSessionDetails(session.session_id);
            }
        });

        return sessionItem;
    }

    /**
     * Format a date as relative (e.g. "2h ago", "Yesterday", "Mar 20")
     */
    formatRelativeDate(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    getSessionItemHTML(session, sessionName, formattedDate) {
        const checkboxId = `session-check-${session.session_id}`;
        const workspace = getSessionWorkspaceInfo(session);
        const workspaceBadge = workspace.type === 'coder' || workspace.type === 'computer'
            ? `
                <span class="session-workspace-badge session-workspace-${workspace.type}" title="${workspace.title}">
                    <i class="fas ${workspace.icon}"></i>
                    <span>${workspace.label}</span>
                </span>
            `
            : '';

        return `
            <div class="session-select">
                <input type="checkbox" class="session-checkbox" id="${checkboxId}" />
                <label for="${checkboxId}" class="custom-checkbox"></label>
            </div>
            <div class="session-content">
                <span class="session-title">${sessionName}</span>
                <span class="session-row-meta">
                    <span class="session-date">${formattedDate}</span>
                    ${workspaceBadge}
                </span>
            </div>
            <i class="fas fa-chevron-right session-arrow"></i>
        `;
    }

    initializeSelectionControls() {
        const useSelectedBtn = this.elements.listView.querySelector('.use-selected-btn');
        const clearBtn = this.elements.listView.querySelector('.clear-selection-btn');

        useSelectedBtn?.addEventListener('click', () => {
            const selectedData = this.getSelectedSessionsData();
            if (selectedData.length > 0) {
                this.selectedContextSessions = selectedData;
                this.renderSessionChips(); // Add chips to context bar
                this.toggleWindow(false);
                this.showNotification(`${selectedData.length} session(s) selected as context`, 'info');
            }
        });

        clearBtn?.addEventListener('click', () => this.clearSelectedContext());
    }

    updateSelectionUI() {
        const selectionActions = this.elements.listView.querySelector('.selection-actions');
        if (!selectionActions) return;

        const selectedCount = this.elements.listView.querySelectorAll('.session-checkbox:checked').length;
        selectionActions.classList.toggle('hidden', selectedCount === 0);

        if (selectedCount > 0) {
            selectionActions.querySelector('.selected-count').textContent = `${selectedCount} selected`;
        }
    }

    getSelectedSessionsData() {
        const selectedIds = new Set();
        this.elements.listView.querySelectorAll('.session-checkbox:checked').forEach(cb => {
            const sessionItem = cb.closest('.session-item');
            if (sessionItem) {
                selectedIds.add(sessionItem.dataset.sessionId);
            }
        });

        // Return full session objects (Electron format) - backend needs session_id to query data
        return this.loadedSessions.filter(session => selectedIds.has(session.session_id));
    }

    async showSessionDetails(sessionId) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('[ContextHandler] ✓ showSessionDetails CALLED');
        console.log('[ContextHandler] Session ID:', sessionId);

        const session = this.loadedSessions.find(s => s.session_id === sessionId);
        console.log('[ContextHandler] Session found:', !!session);

        if (!session) {
            console.error('[ContextHandler] ✗ Cannot show session details - missing session');
            this.notificationService?.show('Could not find session details.', 'error');
            return;
        }

        // Close the context modal — we will render full-screen in main chat area
        this.toggleWindow(false);

        // Get the main chat messages container
        const mainChatMessages = document.getElementById('chat-messages');
        if (!mainChatMessages) {
            console.error('[ContextHandler] ✗ chat-messages container not found');
            return;
        }

        // Hide welcome display
        const welcomeContainer = document.querySelector('.welcome-container');
        welcomeContainer?.classList.add('hidden');

        // Hide pills and carousel (they are separate fixed elements)
        const suggestionsWrapper = document.querySelector('.home-suggestions-wrapper');
        const carousel = document.querySelector('.home-carousel');
        suggestionsWrapper?.classList.add('hidden');
        suggestionsWrapper?.classList.remove('visible');
        carousel?.classList.add('hidden');

        // Switch floating input to chat mode (bottom positioned)
        const floatingInput = document.getElementById('floating-input-container');
        if (floatingInput) {
            floatingInput.classList.remove('welcome-mode', 'centered');
            floatingInput.classList.add('chat-mode');
        }

        // Clear current chat messages and show loading
        mainChatMessages.innerHTML = '<div class="session-item-loading" style="padding: 40px; text-align: center;"><i class="fas fa-spinner fa-spin" style="margin-right: 8px;"></i>Loading conversation...</div>';

        // Mark that we're viewing a past session (for back navigation)
        mainChatMessages.dataset.viewingPastSession = 'true';
        mainChatMessages.dataset.pastSessionId = sessionId;

        // Check if session already has runs data loaded
        if (!session.runs || session.runs.length === 0) {
            console.log('[ContextHandler] Session runs not loaded, fetching from agno_sessions...');

            try {
                const { data: sessionData, error: sessionError } = await supabase
                    .from('agno_sessions')
                    .select('runs, session_data, metadata, session_type, agent_id, team_id')
                    .eq('session_id', sessionId)
                    .single();

                if (sessionError) {
                    console.error('[ContextHandler] Error fetching session data:', sessionError);
                    throw new Error(`Failed to load conversation: ${sessionError.message}`);
                }

                session.runs = sessionData?.runs || [];
                session.session_data = sessionData?.session_data;
                session.metadata = sessionData?.metadata;
                session.session_type = sessionData?.session_type || session.session_type || null;
                session.agent_id = sessionData?.agent_id || session.agent_id || null;
                session.team_id = sessionData?.team_id || session.team_id || null;

                console.log('[ContextHandler] Session updated with runs:', session.runs.length);
            } catch (err) {
                console.error('[ContextHandler] Failed to load session details:', err);
                mainChatMessages.innerHTML = `
                    <div class="empty-state error-state" style="padding: 40px;">
                        <i class="fas fa-exclamation-circle"></i>
                        <p>${err.message || 'Failed to load conversation'}</p>
                        <button class="retry-load-btn" type="button">
                            <i class="fas fa-arrow-left"></i> Back
                        </button>
                    </div>
                `;
                mainChatMessages.querySelector('.retry-load-btn')?.addEventListener('click', () => {
                    this.exitPastSessionView();
                });
                return;
            }
        }

        // Clear loading state
        mainChatMessages.innerHTML = '';

        // Support both session.runs and session.memory.runs structures
        const runs = session.runs || session.memory?.runs || [];

        // Use title from session object
        let sessionName = session.title || `Session ${session.session_id.substring(0, 8)}...`;
        if (sessionName.length > 55) {
            sessionName = sessionName.substring(0, 55) + '...';
        }

        // --- Build a sticky header bar at the top of the chat area ---
        const pastSessionHeader = document.createElement('div');
        pastSessionHeader.className = 'past-session-header';
        pastSessionHeader.innerHTML = `
            <button class="past-session-back-btn" title="Exit past session">
                <i class="fas fa-arrow-left"></i>
            </button>
            <span class="past-session-title">${this.escapeHtml(sessionName)}</span>
            <div class="past-session-actions"></div>
        `;

        // Back button exits past session view
        pastSessionHeader.querySelector('.past-session-back-btn').addEventListener('click', () => {
            this.exitPastSessionView();
        });

        mainChatMessages.appendChild(pastSessionHeader);

        // --- Render messages ---
        if (!Array.isArray(runs) || runs.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-state';
            emptyMessage.style.padding = '40px 16px';
            emptyMessage.innerHTML = `
                <i class="fas fa-inbox"></i>
                <p>This session has no conversation history.</p>
            `;
            mainChatMessages.appendChild(emptyMessage);
        } else {
            // Filter only top-level runs (no parent_run_id)
            const topLevelRuns = runs.filter(run => !run.parent_run_id);

            topLevelRuns.forEach((run, runIndex) => {
                // Handle new format: run.input.input_content and run.content
                const userInput = run.input?.input_content || '';
                const assistantOutput = run.content || '';
                const events = Array.isArray(run.events) ? run.events : [];

                // Add user message if exists
                if (userInput && userInput.trim()) {
                    let messageContent = userInput;
                    const marker = 'Current message:';
                    const index = messageContent.lastIndexOf(marker);
                    if (index !== -1) {
                        messageContent = messageContent.substring(index + marker.length).trim();
                    }

                    const userMsgDiv = document.createElement('div');
                    userMsgDiv.className = 'message user-message';
                    userMsgDiv.innerHTML = messageFormatter.format(messageContent, { inlineArtifacts: true });
                    mainChatMessages.appendChild(userMsgDiv);
                }

                // --- Build bot message with reasoning dropdown (matching live chat structure) ---
                const hasEvents = events.length > 0;

                // Extract reasoning steps and tool calls from events
                const reasoningSteps = [];
                const toolCalls = [];
                let hasFiles = false;
                let hasTerminal = false;

                events.forEach(evt => {
                    if (!evt || typeof evt !== 'object') return;

                    // Collect reasoning content from TeamRunContent events
                    if (evt.event === 'TeamRunContent' && evt.reasoning_content && evt.reasoning_content.trim()) {
                        reasoningSteps.push({
                            agent_name: evt.team_name || evt.agent_name || 'Assistant',
                            step: evt.reasoning_content
                        });
                    }

                    // Collect tool calls
                    if (evt.event === 'TeamToolCallStarted' && evt.tool) {
                        const toolName = (evt.tool.tool_name || 'tool').replace(/_/g, ' ');
                        toolCalls.push({
                            name: toolName,
                            raw_name: evt.tool.tool_name || 'tool',
                            args: evt.tool.tool_args,
                            status: 'started',
                            agent_name: evt.team_name || evt.agent_name || 'Assistant'
                        });

                        // Check for file/terminal related tools
                        const tn = (evt.tool.tool_name || '').toLowerCase();
                        if (tn.includes('file') || tn.includes('write') || tn.includes('read') || tn.includes('create') || tn.includes('artifact') || tn.includes('upload') || tn.includes('download') || tn.includes('sheet') || tn.includes('drive') || tn.includes('deploy')) {
                            hasFiles = true;
                        }
                        if (tn.includes('terminal') || tn.includes('exec') || tn.includes('shell') || tn.includes('run_command') || tn.includes('code') || tn.includes('python') || tn.includes('coding')) {
                            hasTerminal = true;
                        }
                    }

                    if (evt.event === 'TeamToolCallCompleted' && evt.tool) {
                        // Update existing tool call to completed
                        const existing = toolCalls.find(t => t.raw_name === (evt.tool.tool_name || 'tool') && t.status === 'started');
                        if (existing) {
                            existing.status = 'completed';
                            existing.result = evt.tool.result;
                        } else {
                            const toolName = (evt.tool.tool_name || 'tool').replace(/_/g, ' ');
                            toolCalls.push({
                                name: toolName,
                                raw_name: evt.tool.tool_name || 'tool',
                                args: evt.tool.tool_args,
                                status: 'completed',
                                result: evt.tool.result,
                                agent_name: evt.team_name || evt.agent_name || 'Assistant'
                            });
                        }
                    }
                });

                const hasReasoningOrTools = reasoningSteps.length > 0 || toolCalls.length > 0;

                if (assistantOutput && assistantOutput.trim()) {
                    const messageId = `past-msg-${sessionId}-${runIndex}`;
                    const botMsgDiv = document.createElement('div');
                    botMsgDiv.className = 'message bot-message message-bot';
                    botMsgDiv.dataset.messageId = messageId;

                    if (hasReasoningOrTools) {
                        // --- Build thinking indicator (reasoning summary dropdown) ---
                        const thinkingIndicator = document.createElement('div');
                        thinkingIndicator.className = 'thinking-indicator steps-done';

                        const parts = [];
                        // Count unique agent reasoning blocks as thoughts
                        const reasoningAgents = new Set(reasoningSteps.map(r => r.agent_name));
                        if (reasoningAgents.size > 0) parts.push(`${reasoningAgents.size} thought${reasoningAgents.size > 1 ? 's' : ''}`);
                        if (toolCalls.length > 0) parts.push(`${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''}`);
                        const summaryText = parts.length > 0 ? `Reasoning: ${parts.join(', ')}` : 'Reasoning';

                        thinkingIndicator.innerHTML = `
                            <div class="reasoning-summary" role="button" tabindex="0">
                                <span class="summary-text">${summaryText}</span>
                                <i class="fas fa-chevron-down summary-chevron"></i>
                            </div>
                        `;

                        // --- Build detailed-logs ---
                        const detailedLogs = document.createElement('div');
                        detailedLogs.className = 'detailed-logs';
                        detailedLogs.id = `logs-${messageId}`;

                        // Group reasoning steps by agent name
                        const reasoningByAgent = {};
                        reasoningSteps.forEach(rs => {
                            const agentKey = rs.agent_name.replace(/[^a-zA-Z0-9_-]/g, '-');
                            if (!reasoningByAgent[agentKey]) {
                                reasoningByAgent[agentKey] = {
                                    name: rs.agent_name,
                                    steps: []
                                };
                            }
                            reasoningByAgent[agentKey].steps.push(rs.step);
                        });

                        // Add reasoning sections (matching live chat structure)
                        Object.entries(reasoningByAgent).forEach(([agentKey, agentData]) => {
                            const section = document.createElement('div');
                            section.className = 'content-block log-block reasoning-thought-block';
                            section.id = `reasoning-log-${messageId}-${agentKey}`;

                            section.innerHTML = `
                                <div class="reasoning-thought-header">
                                    <i class="fi fi-tr-brain reasoning-thought-icon"></i>
                                    <span>Deep reasoning</span>
                                </div>
                                <div class="inner-content reasoning-thought-content"></div>
                            `;

                            const innerContent = section.querySelector('.reasoning-thought-content');
                            // Join all reasoning steps into a single continuous text block
                            innerContent.textContent = agentData.steps.join('');

                            detailedLogs.appendChild(section);
                        });

                        // Add tool call log entries
                        toolCalls.forEach(tool => {
                            const logEntry = document.createElement('div');
                            logEntry.className = 'tool-log-entry';
                            logEntry.innerHTML = `
                                <i class="fi fi-tr-wisdom tool-log-icon"></i>
                                <div class="tool-log-details">
                                    <span class="tool-log-action">Used tool: <strong>${this.escapeHtml(tool.name)}</strong></span>
                                </div>
                                <span class="tool-log-status completed" title="Completed"></span>
                            `;
                            detailedLogs.appendChild(logEntry);
                        });

                        botMsgDiv.appendChild(thinkingIndicator);
                        botMsgDiv.appendChild(detailedLogs);

                        // Toggle expand on click
                        const summary = thinkingIndicator.querySelector('.reasoning-summary');
                        summary?.addEventListener('click', () => {
                            botMsgDiv.classList.toggle('expanded');
                        });
                        summary?.addEventListener('keypress', (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                botMsgDiv.classList.toggle('expanded');
                            }
                        });
                    }

                    // --- Build main content ---
                    const mainContent = document.createElement('div');
                    mainContent.className = 'message-content';
                    mainContent.id = `main-content-${messageId}`;
                    mainContent.innerHTML = messageFormatter.format(assistantOutput, { inlineArtifacts: true });

                    botMsgDiv.appendChild(mainContent);
                    mainChatMessages.appendChild(botMsgDiv);
                } else if (!assistantOutput && !userInput && run.role && run.content) {
                    // Legacy format support: run.role and run.content
                    const isUser = run.role === 'user';
                    let messageContent = run.content;

                    if (isUser) {
                        const marker = 'Current message:';
                        const index = messageContent.lastIndexOf(marker);
                        if (index !== -1) {
                            messageContent = messageContent.substring(index + marker.length).trim();
                        }
                    }

                    const msgDiv = document.createElement('div');
                    msgDiv.className = `message ${isUser ? 'user-message' : 'bot-message'}`;
                    msgDiv.innerHTML = messageFormatter.format(messageContent, { inlineArtifacts: true });
                    mainChatMessages.appendChild(msgDiv);
                }
            });
        }

        messageFormatter.applyInlineEnhancements?.(mainChatMessages);

        // Scroll to top
        mainChatMessages.scrollTop = 0;

        console.log('[ContextHandler] Past session rendered full-screen');

        // Fetch and display session content (files, artifacts, executions)
        this.fetchAndDisplaySessionContentFullscreen(sessionId, mainChatMessages, pastSessionHeader);
    }

    /**
     * Fetch session content (files, artifacts, executions) from the backend API
     */
    async fetchSessionContent(sessionId) {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session?.access_token) {
                console.warn('[ContextHandler] No auth session for fetching content');
                return [];
            }

            const url = `${config.backend.url}/api/sessions/${sessionId}/content`;
            console.log('[ContextHandler] Fetching session content from:', url);

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error('[ContextHandler] Failed to fetch session content:', response.status);
                return [];
            }

            const data = await response.json();
            console.log('[ContextHandler] Session content fetched:', data.count, 'items');
            return data.content || [];
        } catch (error) {
            console.error('[ContextHandler] Error fetching session content:', error);
            return [];
        }
    }

    /**
     * Exit past session view and return to welcome screen
     */
    exitPastSessionView() {
        console.log('[ContextHandler] Exiting past session view');
        const mainChatMessages = document.getElementById('chat-messages');
        if (mainChatMessages) {
            delete mainChatMessages.dataset.viewingPastSession;
            delete mainChatMessages.dataset.pastSessionId;
            mainChatMessages.innerHTML = '';
        }

        // Show welcome display again
        const welcomeContainer = document.querySelector('.welcome-container');
        welcomeContainer?.classList.remove('hidden');

        // Restore pills and carousel on desktop
        const suggestionsWrapper = document.querySelector('.home-suggestions-wrapper');
        const carousel = document.querySelector('.home-carousel');
        if (window.matchMedia('(min-width: 1024px)').matches) {
            suggestionsWrapper?.classList.remove('hidden');
            suggestionsWrapper?.classList.add('visible');
            carousel?.classList.remove('hidden');
        }

        // Restore floating input to welcome mode
        const floatingInput = document.getElementById('floating-input-container');
        if (floatingInput) {
            floatingInput.classList.remove('chat-mode');
            floatingInput.classList.add('welcome-mode');
        }

        // Hide content button
        const viewContentBtn = document.getElementById('view-content-btn');
        const contentBadge = document.getElementById('content-count-badge');
        viewContentBtn?.classList.add('hidden');
        contentBadge?.classList.add('hidden');
    }

    /**
     * Fetch and display session content in the full-screen view
     */
    async fetchAndDisplaySessionContentFullscreen(sessionId, container, headerElement) {
        const content = await this.fetchSessionContent(sessionId);

        if (content.length === 0) {
            console.log('[ContextHandler] No session content to display');
            return;
        }

        // Separate by type
        const artifacts = content.filter(item => item.content_type === 'artifact');
        const uploads = content.filter(item => item.content_type === 'upload');
        const executions = content.filter(item => item.content_type === 'execution');

        console.log('[ContextHandler] Session content breakdown:', {
            artifacts: artifacts.length,
            uploads: uploads.length,
            executions: executions.length
        });

        const allFiles = [...artifacts, ...uploads];
        const hasContent = allFiles.length > 0 || executions.length > 0;

        // Add a "Content Folder" button to the past session header
        if (hasContent && headerElement) {
            const actionsDiv = headerElement.querySelector('.past-session-actions');
            if (actionsDiv && !actionsDiv.querySelector('.session-content-folder-btn')) {
                const contentBtn = document.createElement('button');
                contentBtn.className = 'session-content-folder-btn';
                contentBtn.title = 'View session content';

                const fileParts = [];
                if (allFiles.length > 0) fileParts.push(`${allFiles.length} file${allFiles.length > 1 ? 's' : ''}`);
                if (executions.length > 0) fileParts.push(`${executions.length} terminal`);

                contentBtn.innerHTML = `
                    <i class="fi fi-tr-folder-open"></i>
                    <span>${fileParts.join(' • ')}</span>
                `;
                contentBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    sessionContentViewer.show(sessionId);
                });
                actionsDiv.appendChild(contentBtn);
            }
        }

        // Also show via the top bar content button
        const viewContentBtn = document.getElementById('view-content-btn');
        const contentBadge = document.getElementById('content-count-badge');
        if (hasContent) {
            viewContentBtn?.classList.remove('hidden');
            if (contentBadge) {
                contentBadge.textContent = content.length;
                contentBadge.classList.remove('hidden');
            }
            // Override the top bar button to show this session's content
            viewContentBtn?.replaceWith(viewContentBtn.cloneNode(true));
            document.getElementById('view-content-btn')?.addEventListener('click', () => {
                sessionContentViewer.show(sessionId);
            });
        }

        // Render files section
        if (allFiles.length > 0) {
            this.renderSessionFilesSection(container, allFiles);
        }

        // Render terminal logs section
        if (executions.length > 0) {
            this.renderSessionExecutionsSection(container, executions);
        }
    }

    /**
     * Render files section in session detail view
     */
    renderSessionFilesSection(container, files) {
        const filesSection = document.createElement('div');
        filesSection.className = 'session-files-section';
        filesSection.innerHTML = `
            <div class="session-section-header">
                <i class="fas fa-folder-open"></i>
                <span>Files (${files.length})</span>
            </div>
            <div class="session-files-list"></div>
        `;

        const filesList = filesSection.querySelector('.session-files-list');

        files.forEach(file => {
            const metadata = file.metadata || {};
            const filename = metadata.filename || 'Unknown file';
            const size = this.formatFileSize(metadata.size || 0);
            const isUpload = file.content_type === 'upload';
            const icon = isUpload ? 'fa-paperclip' : 'fa-file-code';
            const label = isUpload ? 'Attached' : 'Generated';

            const fileItem = document.createElement('div');
            fileItem.className = 'session-file-item';
            fileItem.innerHTML = `
                <i class="fas ${icon}"></i>
                <div class="file-info">
                    <span class="file-name">${this.escapeHtml(filename)}</span>
                    <span class="file-meta">${size} • ${label}</span>
                </div>
                <button class="view-file-btn" title="View file">
                    <i class="fas fa-eye"></i>
                </button>
            `;

            // Add click handler to view file
            fileItem.querySelector('.view-file-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.viewSessionFile(file);
            });

            // Also allow clicking the whole item to view
            fileItem.addEventListener('click', async () => {
                await this.viewSessionFile(file);
            });

            filesList.appendChild(fileItem);
        });

        // Insert after the header
        const header = container.querySelector('.past-session-header');
        if (header && header.nextSibling) {
            container.insertBefore(filesSection, header.nextSibling);
        } else {
            container.appendChild(filesSection);
        }
    }

    /**
     * Render terminal executions section in session detail view
     */
    renderSessionExecutionsSection(container, executions) {
        const execSection = document.createElement('div');
        execSection.className = 'session-executions-section';
        execSection.innerHTML = `
            <div class="session-section-header">
                <i class="fas fa-terminal"></i>
                <span>Terminal Logs (${executions.length})</span>
            </div>
            <div class="session-executions-list"></div>
        `;

        const execList = execSection.querySelector('.session-executions-list');

        executions.forEach(exec => {
            const metadata = exec.metadata || {};
            const command = metadata.command || 'Command';
            const exitCode = metadata.exit_code ?? '?';
            const exitClass = exitCode === 0 ? 'success' : 'error';

            const execItem = document.createElement('div');
            execItem.className = 'session-exec-item';
            execItem.innerHTML = `
                <i class="fas fa-terminal"></i>
                <div class="exec-info">
                    <span class="exec-command">${this.escapeHtml(command.substring(0, 50))}${command.length > 50 ? '...' : ''}</span>
                    <span class="exec-exit ${exitClass}">Exit: ${exitCode}</span>
                </div>
                <button class="view-exec-btn" title="View output">
                    <i class="fas fa-eye"></i>
                </button>
            `;

            execItem.querySelector('.view-exec-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.viewSessionExecution(exec);
            });

            execItem.addEventListener('click', async () => {
                await this.viewSessionExecution(exec);
            });

            execList.appendChild(execItem);
        });

        // Insert after files section or after header
        const filesSection = container.querySelector('.session-files-section');
        const header = container.querySelector('.past-session-header');
        const insertAfter = filesSection || header;
        
        if (insertAfter && insertAfter.nextSibling) {
            container.insertBefore(execSection, insertAfter.nextSibling);
        } else {
            container.appendChild(execSection);
        }
    }

    /**
     * View a file from session content
     */
    async viewSessionFile(file) {
        try {
            const metadata = file.metadata || {};
            const filename = metadata.filename || 'file';
            const mimeType = metadata.mime_type || 'application/octet-stream';

            if (file.content_type === 'upload') {
                // User-uploaded file - get from Supabase storage
                const path = metadata.path;
                if (!path) {
                    console.error('[ContextHandler] No path for uploaded file');
                    return;
                }

                const { data: { publicUrl } } = supabase.storage
                    .from('media-uploads')
                    .getPublicUrl(path);

                if (mimeType.startsWith('image/')) {
                    artifactHandler.showArtifact(publicUrl, 'image', null, filename);
                } else if (mimeType.startsWith('video/')) {
                    artifactHandler.showArtifact(publicUrl, 'video', null, filename);
                } else if (mimeType.startsWith('audio/')) {
                    artifactHandler.showArtifact(publicUrl, 'audio', null, filename);
                } else if (mimeType === 'application/pdf') {
                    window.open(publicUrl, '_blank');
                } else if (metadata.is_text) {
                    const response = await fetch(publicUrl);
                    const content = await response.text();
                    const language = this.detectLanguage(filename);
                    artifactHandler.showArtifact(content, language, null, filename);
                } else {
                    window.open(publicUrl, '_blank');
                }
            } else {
                // AI-generated artifact - use download_url
                const downloadUrl = file.download_url;
                if (!downloadUrl) {
                    console.error('[ContextHandler] No download URL for artifact');
                    return;
                }

                const response = await fetch(downloadUrl);
                const content = await response.text();
                const language = this.detectLanguage(filename);
                artifactHandler.showArtifact(content, language, null, filename);
            }
        } catch (error) {
            console.error('[ContextHandler] Error viewing file:', error);
            this.showNotification('Failed to load file', 'error');
        }
    }

    /**
     * View terminal execution output
     */
    async viewSessionExecution(execution) {
        try {
            const metadata = execution.metadata || {};
            const command = metadata.command || 'Command';
            const exitCode = metadata.exit_code ?? '?';

            let stdout = '';
            let stderr = '';

            if (execution.stdout_url) {
                try {
                    const response = await fetch(execution.stdout_url);
                    if (response.ok) stdout = await response.text();
                } catch (e) {
                    console.warn('[ContextHandler] Failed to fetch stdout:', e);
                }
            }

            if (execution.stderr_url) {
                try {
                    const response = await fetch(execution.stderr_url);
                    if (response.ok) stderr = await response.text();
                } catch (e) {
                    console.warn('[ContextHandler] Failed to fetch stderr:', e);
                }
            }

            let output = `$ ${command}\n\n`;
            if (stdout) output += stdout;
            if (stderr) output += `\n\n--- STDERR ---\n${stderr}`;
            output += `\n\n--- Exit Code: ${exitCode} ---`;

            artifactHandler.showArtifact(output, 'bash', null, `Terminal: ${command.substring(0, 30)}`);
        } catch (error) {
            console.error('[ContextHandler] Error viewing execution:', error);
            this.showNotification('Failed to load terminal output', 'error');
        }
    }

    /**
     * Detect language from filename extension
     */
    detectLanguage(filename) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const languageMap = {
            'py': 'python', 'js': 'javascript', 'ts': 'typescript',
            'jsx': 'javascript', 'tsx': 'typescript', 'html': 'html',
            'css': 'css', 'json': 'json', 'md': 'markdown',
            'sh': 'bash', 'bash': 'bash', 'java': 'java',
            'cpp': 'cpp', 'c': 'c', 'go': 'go', 'rs': 'rust',
            'rb': 'ruby', 'php': 'php', 'sql': 'sql', 'yaml': 'yaml',
            'yml': 'yaml', 'xml': 'xml', 'txt': 'plaintext'
        };
        return languageMap[ext] || 'plaintext';
    }

    /**
     * Format file size for display
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Escape HTML characters
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    clearSelectedContext() {
        this.elements.listView?.querySelectorAll('.session-checkbox:checked').forEach(cb => cb.checked = false);
        this.elements.listView?.querySelectorAll('.session-item.selected').forEach(item => item.classList.remove('selected'));
        this.selectedContextSessions = [];
        this.updateSelectionUI();
        this.renderSessionChips(); // Clear session chips from context bar
    }

    showNotification(message, type = 'info', duration = 3000) {
        if (this.notificationService) {
            this.notificationService.show(message, type, duration);
            return;
        }

        const container = document.querySelector('.notification-container');
        if (!container) return;

        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        container.appendChild(notification);

        setTimeout(() => notification.classList.add('show'), 10);
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }

    getSelectedSessions() {
        return this.selectedContextSessions;
    }

    getSessionTitleById(sessionId) {
        if (!sessionId) {
            return null;
        }

        const session = this.loadedSessions.find((item) => item.session_id === sessionId)
            || this.selectedContextSessions.find((item) => item.session_id === sessionId);

        const title = session?.title;
        return typeof title === 'string' && title.trim() ? title.trim() : null;
    }

    /**
     * Invalidate cache when a new conversation is created
     * This ensures fresh data on next open
     */
    invalidateCache() {
        console.log('[ContextHandler] Cache invalidated');
        this.loadingState = 'idle';
        this.loadedSessions = [];
        this.loadError = null;
        this.currentOffset = 0;
        this.hasMoreSessions = false;
        this.isLoadingMore = false;
    }

    /**
     * Render session chips in the context files bar
     */
    renderSessionChips() {
        const contextFilesBar = document.getElementById('context-files-bar');
        const contextFilesContent = document.querySelector('.context-files-content');

        if (!contextFilesBar || !contextFilesContent) return;

        // Remove existing session chips
        contextFilesContent.querySelectorAll('.session-chip').forEach(chip => chip.remove());

        // Add new session chips
        this.selectedContextSessions.forEach((session, index) => {
            this.createSessionChip(session, index);
        });

        this.updateContextFilesBarVisibility();
    }

    /**
     * Create a single session chip
     */
    createSessionChip(session, index) {
        const contextFilesContent = document.querySelector('.context-files-content');
        if (!contextFilesContent) return;

        const chip = document.createElement('div');
        chip.className = 'session-chip';

        const icon = document.createElement('i');
        icon.className = 'fas fa-comments session-chip-icon';

        const title = document.createElement('span');
        title.className = 'session-chip-title';

        // Use title from session_titles table if available
        const chipTitle = session.title || `Session ${index + 1}`;
        title.textContent = chipTitle.substring(0, 25) + (chipTitle.length > 25 ? '...' : '');

        const removeBtn = document.createElement('button');
        removeBtn.className = 'session-chip-remove';
        removeBtn.innerHTML = '<i class="fas fa-times"></i>';
        removeBtn.title = 'Remove session';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeSelectedSession(index);
        });

        chip.appendChild(icon);
        chip.appendChild(title);
        chip.appendChild(removeBtn);

        contextFilesContent.appendChild(chip);
    }

    /**
     * Remove a selected session by index
     */
    removeSelectedSession(index) {
        if (index > -1 && index < this.selectedContextSessions.length) {
            this.selectedContextSessions.splice(index, 1);
            this.renderSessionChips();
        }
    }

    /**
     * Update context files bar visibility
     */
    updateContextFilesBarVisibility() {
        const contextFilesBar = document.getElementById('context-files-bar');
        const inputContainer = document.getElementById('floating-input-container');

        if (!contextFilesBar || !inputContainer) return;

        const hasFiles = window.fileAttachmentHandler && window.fileAttachmentHandler.attachedFiles && window.fileAttachmentHandler.attachedFiles.length > 0;
        const hasSessions = this.selectedContextSessions.length > 0;
        const hasContent = hasFiles || hasSessions;

        if (hasContent) {
            contextFilesBar.classList.remove('hidden');
            inputContainer.classList.add('has-files');
        } else {
            contextFilesBar.classList.add('hidden');
            inputContainer.classList.remove('has-files');
        }
    }

    /**
     * Escape HTML special characters to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Format file size in human-readable format
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

export default ContextHandler;
