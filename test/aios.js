// js/aios.js

import { supabase } from './supabase-client.js';
import { authService } from './auth-service.js';
import { AIOSUsageRenderer } from './aios-usage.js';
import NotificationService from './notification-service.js';
import skeletonLoader from './skeleton-loader.js';
import { ScreenAnalysisManager } from './screen-analysis.js';
import { DeploySettingsManager } from './deploy-settings-manager.js';
import { OfflineModelManager } from './offline-model-manager.js';

// Backend URL for OAuth integrations - Production (Cloudflare Tunnel)
const OAUTH_BACKEND_URL = 'https://api.pawsitivestrides.store';
// Backend URL for API calls - Production (Cloudflare Tunnel)
const API_BACKEND_URL = 'https://api.pawsitivestrides.store';
const COMPOSIO_PROVIDERS = {
    'composio-googlesheets': {
        toolkit: 'GOOGLESHEETS',
        label: 'Google Sheets',
    },
    'composio-whatsapp': {
        toolkit: 'WHATSAPP',
        label: 'WhatsApp',
    },
};
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['created', 'authenticated', 'active', 'pending', 'paused', 'resumed']);

export class AIOS {
    constructor() {
        this.initialized = false;
        this.currentTab = 'profile';
        this.elements = {};
        this.notificationService = new NotificationService();
        this.authService = authService;
        this.usageRenderer = null;
        this.deploySettingsManager = new DeploySettingsManager({
            notify: (message, type = 'info') => this.showNotification(message, type),
        });
        this.subscriptionSummary = null;
        this.isSubscriptionLoading = false;
        this.isCheckoutInProgress = false;
        this.nativeAuthSessionPlugin = null;
        this.nativeAssistantNotesPlugin = null;
        this.nativeMindspacePlugin = null;

        // Memory state
        this.memoriesCache = [];
        this._editingMemoryId = null;
        this.assistantNotesCache = [];
    }

    async init() {
        if (this.initialized) return;

        this.cacheElements();
        this.setupEventListeners();
        await this.authService.init();
        this.usageRenderer = new AIOSUsageRenderer();

        // Initialize Screen Analysis
        this.screenAnalysis = new ScreenAnalysisManager(this);
        // Initialize Offline Model
        this.offlineModelManager = new OfflineModelManager(this.notificationService);

        // Handler called from native Android with: analysisId, text, imageBase64, timestamp
        window.handleScreenAnalysisResult = (analysisId, text, imageData, timestamp) => {
            this.screenAnalysis.handleResult(analysisId, text, imageData, timestamp);
        };
        this.flushPendingMindspaceResults();

        // Load saved theme preference
        this.loadThemePreference();
        this.updateThemeUI();

        // Handle OAuth callback on page load
        await this.handleOAuthCallback();

        // Handle integration OAuth callback
        this.handleIntegrationOAuthCallback();
        this.handleComposioCallback();

        // Setup native auth bridge and sync current Supabase session.
        await this.initNativeAuthSessionBridge();
        await this.initNativeAssistantNotesBridge();
        await this.initNativeMindspaceBridge();
        await this.hydrateMindspaceFromNative();

        // Setup Capacitor Deep Links for Native Auth
        await this.setupCapacitorDeepLinks();

        // Get current user and update UI
        const { data: { user } } = await supabase.auth.getUser();
        await this.updateAuthUI(user);
        this.loadUsageData().catch((error) => {
            console.error('[AIOS] Initial usage load failed:', error);
        });

        this.initialized = true;
    }

    async setupCapacitorDeepLinks() {
        try {
            const { Capacitor } = await import('@capacitor/core');
            const { App } = await import('@capacitor/app');

            if (Capacitor.isNativePlatform()) {
                console.log('Running on Native Platform - Setting up Deep Links');

                App.addListener('appUrlOpen', async (data) => {
                    console.log('App opened with URL:', data.url);

                    // Allow URLs with auth callback data or Composio completion.
                    if (
                        !data.url.includes('auth-callback') &&
                        !data.url.includes('access_token') &&
                        !data.url.includes('code=') &&
                        !data.url.includes('composio_callback=true')
                    ) {
                        return;
                    }

                    try {
                        const urlObj = new URL(data.url);
                        const searchParams = new URLSearchParams(urlObj.search);
                        // Handle hash - some providers put query params in hash
                        const hashParams = new URLSearchParams(urlObj.hash ? urlObj.hash.substring(1) : '');
                        const isComposioCallback = searchParams.get('composio_callback') === 'true';
                        const composioToolkit = searchParams.get('toolkit') || hashParams.get('toolkit');

                        // 1. Check for errors
                        const error = searchParams.get('error') || hashParams.get('error');
                        const errorDescription = searchParams.get('error_description') || hashParams.get('error_description');

                        if (error) {
                            console.error('Auth callback error:', error, errorDescription);
                            this.showNotification(`Login failed: ${errorDescription || error}`, 'error');
                            return;
                        }

                        if (isComposioCallback && composioToolkit) {
                            const toolkitLabel = this.getComposioLabelByToolkit(composioToolkit);
                            this.showNotification(`${toolkitLabel} connected successfully.`, 'success');
                            await this.updateIntegrationStatus();
                            return;
                        }

                        // 2. Check for PKCE Code (Recommended/Default flow) - usually in search params
                        // Also check hash params just in case
                        const code = searchParams.get('code') || hashParams.get('code');

                        if (code) {
                            console.log('Found PKCE code, exchanging for session...');
                            // Exchange code for session using Supabase client
                            const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

                            if (sessionError) {
                                throw sessionError;
                            }

                            if (sessionData?.session) {
                                console.log('Session established via PKCE');
                                this.showNotification('Successfully signed in!', 'success');
                                this.updateAuthUI(sessionData.session.user);
                                this.syncNativeAuthSession(sessionData.session);
                                this.closeProfileMenu();
                                return;
                            }
                        }

                        // 3. Fallback: Check for Implicit Flow (access_token in hash)
                        const accessToken = hashParams.get('access_token') || searchParams.get('access_token');
                        const refreshToken = hashParams.get('refresh_token') || searchParams.get('refresh_token');

                        if (accessToken) {
                            console.log('Found access_token, setting session...');
                            const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
                                access_token: accessToken,
                                refresh_token: refreshToken || ''
                            });

                            if (sessionError) {
                                throw sessionError;
                            }

                            if (sessionData?.session) {
                                console.log('Session established via token');
                                this.showNotification('Successfully signed in!', 'success');
                                this.updateAuthUI(sessionData.session.user);
                                this.syncNativeAuthSession(sessionData.session);
                                this.closeProfileMenu();
                                return;
                            }
                        }

                        // If we got here, we found neither code nor token
                        console.warn('Redirect URL handled but no code or token found. URL:', data.url);
                        this.showNotification('Login incomplete: auth parameters missing.', 'warning');

                    } catch (err) {
                        console.error('Error processing deep link:', err);
                        this.showNotification(`Authentication error: ${err.message}`, 'error');
                    }
                });
            }
        } catch (e) {
            console.log('Capacitor imports failed - running in browser mode', e);
        }
    }



    /**
     * Handle Google Sign-In using Supabase OAuth
     */
    async handleGoogleSignIn() {
        this.elements.loginError.textContent = '';
        this.elements.signupError.textContent = '';

        try {
            const { Capacitor } = await import('@capacitor/core');

            // 1. Native Platform Logic: Use Native Google Sign-In
            // 1. Native Platform Logic: Use Native Google Sign-In
            if (Capacitor.isNativePlatform()) {
                console.log('Running on native - using @capgo/capacitor-social-login');
                const { SocialLogin } = await import('@capgo/capacitor-social-login');

                // Initialize (required for this plugin)
                await SocialLogin.initialize({
                    google: {
                        webClientId: '167883790879-6trds0p82hthlgsbmp97ojrqf8s5areb.apps.googleusercontent.com' // Ensure this matches capacitor.config.json
                    }
                });

                // Trigger Native Sign-In Modal
                const response = await SocialLogin.login({
                    provider: 'google'
                });

                console.log('Google Native Sign-In successful', response);

                // Extract ID token - SocialLogin returns it in 'result.idToken' or 'result.accessToken' depending on provider
                // For Google, we typically get an idToken
                const idToken = response.result.idToken;

                if (!idToken) {
                    console.error('Full response:', response);
                    throw new Error('No Google ID token received from native sign-in.');
                }

                this.showNotification('Verifying with Aetheria...', 'info');

                // Exchange Native ID Token for Supabase Session
                const { data, error } = await supabase.auth.signInWithIdToken({
                    provider: 'google',
                    token: idToken,
                });

                if (error) throw error;

                if (data.session) {
                    this.showNotification('Successfully signed in with Google!', 'success');
                    this.updateAuthUI(data.session.user);
                    this.syncNativeAuthSession(data.session);
                    this.closeProfileMenu();
                }

            } else {
                // 2. Web/PWA Logic: Use Standard Redirect
                console.log('Running on web - using Supabase OAuth Redirect');
                const { data, error } = await supabase.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                        redirectTo: `${window.location.origin}${window.location.pathname}`,
                        queryParams: {
                            access_type: 'offline',
                            prompt: 'consent',
                        },
                    },
                });

                if (error) {
                    throw error;
                }
                // Browser redirects...
            }
        } catch (error) {
            console.error('Google Sign-In error:', error);
            const errorMsg = error.message || 'Google Sign-In failed.';

            // User cancelled
            if (error?.error === 'cancelled' || error?.code === '12501') {
                console.log('User cancelled sign-in');
                return;
            }

            this.elements.loginError.textContent = errorMsg;
            this.elements.signupError.textContent = errorMsg;
            this.showNotification(`Login failed: ${errorMsg}`, 'error');
        }
    }

    loadThemePreference() {
        const savedTheme = localStorage.getItem('theme-preference');
        if (savedTheme) {
            document.body.classList.remove('light-mode', 'dark-mode');
            document.body.classList.add(`${savedTheme}-mode`);
        }
        // If no saved preference, keep the default from HTML (dark-mode)
    }

    cacheElements() {
        this.elements = {
            profileMenuBtn: document.getElementById('profile-menu-btn'),
            profileDropdown: document.getElementById('profile-dropdown'),
            settingsView: document.getElementById('settings-view'),
            profilePhoto: document.getElementById('profile-photo'),
            profileIconDefault: document.getElementById('profile-icon-default'),

            settingsMenuItems: document.querySelectorAll('.settings-menu-item'),
            settingsPanels: document.querySelectorAll('.settings-full-panel'),
            backButtons: document.querySelectorAll('.back-to-menu-btn'),

            logoutBtn: document.getElementById('logout-btn'),
            userNameDisplay: document.getElementById('userName-display'),
            userEmailDisplay: document.getElementById('userEmail-display'),
            profileAvatarLarge: document.getElementById('profile-avatar-large'),
            accountLoggedOut: document.getElementById('account-logged-out'),
            accountLoggedIn: document.getElementById('account-logged-in'),

            authTabs: document.querySelectorAll('.auth-tab-btn'),
            loginForm: document.getElementById('login-form'),
            signupForm: document.getElementById('signup-form'),
            loginError: document.getElementById('login-error'),
            signupError: document.getElementById('signup-error'),

            themeOptions: document.querySelectorAll('.theme-option'),

            githubConnectBtn: document.getElementById('connect-github-btn'),
            googleConnectBtn: document.getElementById('connect-google-btn'),
            googleSheetsConnectBtn: document.getElementById('connect-googlesheets-btn'),
            whatsappConnectBtn: document.getElementById('connect-whatsapp-btn'),
            vercelConnectBtn: document.getElementById('connect-vercel-btn'),
            supabaseConnectBtn: document.getElementById('connect-supabase-btn'),

            // Google Sign-In Buttons
            googleSignInBtn: document.getElementById('google-signin-btn'),
            googleSignUpBtn: document.getElementById('google-signup-btn'),

            usageRefreshBtn: document.getElementById('usage-refresh-btn'),
            notesRefreshBtn: document.getElementById('notes-refresh-btn'),
            notesStorageMeta: document.getElementById('notes-storage-meta'),
            notesList: document.getElementById('notes-list'),
            usageManagePlansBtn: document.getElementById('usage-manage-plans-btn'),
            accountManagePlansBtn: document.getElementById('account-manage-plans-btn'),
            accountSubscriptionCard: document.getElementById('account-subscription-card'),
            accountSubscriptionTitle: document.getElementById('account-subscription-title'),
            accountSubscriptionStatus: document.getElementById('account-subscription-status'),
            accountSubscriptionLimit: document.getElementById('account-subscription-limit'),
            accountSubscriptionMeta: document.getElementById('account-subscription-meta'),
            accountSubscriptionMeterFill: document.getElementById('account-subscription-meter-fill'),
            accountSubscriptionUsed: document.getElementById('account-subscription-used'),
            accountSubscriptionRemaining: document.getElementById('account-subscription-remaining'),

            subscriptionModal: document.getElementById('subscription-modal'),
            subscriptionModalBackdrop: document.getElementById('subscription-modal-backdrop'),
            subscriptionModalClose: document.getElementById('subscription-modal-close'),
            subscriptionModalFootnote: document.getElementById('subscription-modal-footnote'),
            subscriptionHeroTitle: document.getElementById('subscription-hero-title'),
            subscriptionHeroStatus: document.getElementById('subscription-hero-status'),
            subscriptionHeroLimit: document.getElementById('subscription-hero-limit'),
            subscriptionHeroPeriod: document.getElementById('subscription-hero-period'),
            subscriptionPlanGrid: document.getElementById('subscription-plan-grid'),
        };
    }

    setupEventListeners() {
        // Listen for OAuth callback messages from popup windows
        window.addEventListener('message', (event) => {
            // Verify the message is from our own origin
            if (event.origin !== window.location.origin) return;

            // Handle OAuth callback message
            if (event.data && event.data.type === 'oauth-callback') {
                console.log('Received OAuth callback message from popup:', event.data);

                if (event.data.success) {
                    this.showNotification(`Successfully connected to ${event.data.provider}!`, 'success');
                    // Refresh integration status
                    this.updateIntegrationStatus();
                } else {
                    this.showNotification(
                        `Failed to connect: ${event.data.error || 'Unknown error'}`,
                        'error'
                    );
                }
            }

            if (event.data && event.data.type === 'composio-callback') {
                console.log('Received Composio callback message from popup:', event.data);

                if (event.data.success) {
                    const toolkitLabel = this.getComposioLabelByToolkit(event.data.toolkit);
                    this.showNotification(`${toolkitLabel} connected successfully.`, 'success');
                    this.updateIntegrationStatus();
                }
            }
        });

        // Profile menu toggle
        this.elements.profileMenuBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleProfileMenu();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#profile-menu-btn') && !e.target.closest('#profile-dropdown')) {
                this.closeProfileMenu();
            }
        });

        // Settings menu items to open full panels
        this.elements.settingsMenuItems?.forEach(item => {
            item.addEventListener('click', () => {
                const section = item.dataset.section;
                this.openPanel(section);
            });
        });

        // Back buttons to return to dropdown menu
        this.elements.backButtons?.forEach(btn => {
            btn.addEventListener('click', () => {
                this.closePanel();
            });
        });

        this.elements.logoutBtn?.addEventListener('click', () => this.handleLogout());

        this.elements.loginForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });

        this.elements.signupForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleSignup();
        });

        this.elements.authTabs?.forEach(tab =>
            tab.addEventListener('click', () => this.switchAuthTab(tab.dataset.authTab))
        );

        this.elements.themeOptions?.forEach(option =>
            option.addEventListener('click', () => {
                const theme = option.dataset.theme;
                this.setTheme(theme);
            })
        );

        this.elements.githubConnectBtn?.addEventListener('click', (e) => this.handleIntegrationClick(e));
        this.elements.googleConnectBtn?.addEventListener('click', (e) => this.handleIntegrationClick(e));
        this.elements.googleSheetsConnectBtn?.addEventListener('click', (e) => this.handleIntegrationClick(e));
        this.elements.whatsappConnectBtn?.addEventListener('click', (e) => this.handleIntegrationClick(e));
        this.elements.vercelConnectBtn?.addEventListener('click', (e) => this.handleIntegrationClick(e));
        this.elements.supabaseConnectBtn?.addEventListener('click', (e) => this.handleIntegrationClick(e));

        // Google Sign-In event listeners
        this.elements.googleSignInBtn?.addEventListener('click', () => this.handleGoogleSignIn());
        this.elements.googleSignUpBtn?.addEventListener('click', () => this.handleGoogleSignIn());
        this.elements.usageRefreshBtn?.addEventListener('click', () => this.loadUsageData());
        this.elements.notesRefreshBtn?.addEventListener('click', () => this.loadAssistantNotes());
        this.elements.accountManagePlansBtn?.addEventListener('click', () => this.openSubscriptionModal('account'));
        this.elements.usageManagePlansBtn?.addEventListener('click', () => this.openSubscriptionModal('usage'));
        this.elements.subscriptionModalClose?.addEventListener('click', () => this.closeSubscriptionModal());
        this.elements.subscriptionModalBackdrop?.addEventListener('click', () => this.closeSubscriptionModal());
        this.elements.subscriptionPlanGrid?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-plan-type]');
            if (!button || button.disabled) return;
            const planType = button.dataset.planType;
            if (!planType) return;
            this.startPlanUpgrade(planType);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeSubscriptionModal();
            }
        });
        document.addEventListener('subscriptionLimitExceeded', async ({ detail }) => {
            await this.handleSubscriptionLimitExceeded(detail || {});
        });
        window.addEventListener('nativeAuthRequired', async (event) => {
            await this.handleNativeAuthRequired(event?.detail?.reason);
        });

        if (window.__nativeAuthRequiredPayload?.reason) {
            this.handleNativeAuthRequired(window.__nativeAuthRequiredPayload.reason);
            window.__nativeAuthRequiredPayload = null;
        }

        supabase.auth.onAuthStateChange((_event, session) => {
            this.updateAuthUI(session?.user);
            this.loadUsageData();
            this.syncNativeAuthSession(session);
        });
    }

    async initNativeAuthSessionBridge() {
        try {
            const { Capacitor, registerPlugin } = await import('@capacitor/core');
            if (!Capacitor.isNativePlatform()) {
                return;
            }

            this.nativeAuthSessionPlugin = registerPlugin('AuthSession');
            await this.syncNativeAuthSession();
        } catch (error) {
            console.warn('[AIOS] Native AuthSession bridge unavailable:', error);
        }
    }

    async initNativeAssistantNotesBridge() {
        try {
            const { Capacitor, registerPlugin } = await import('@capacitor/core');
            if (!Capacitor.isNativePlatform()) {
                return;
            }

            this.nativeAssistantNotesPlugin = registerPlugin('AssistantNotes');
        } catch (error) {
            console.warn('[AIOS] Native AssistantNotes bridge unavailable:', error);
        }
    }

    async initNativeMindspaceBridge() {
        try {
            const { Capacitor, registerPlugin } = await import('@capacitor/core');
            if (!Capacitor.isNativePlatform()) {
                return;
            }

            this.nativeMindspacePlugin = registerPlugin('Mindspace');
        } catch (error) {
            console.warn('[AIOS] Native Mindspace bridge unavailable:', error);
        }
    }

    async hydrateMindspaceFromNative() {
        if (!this.nativeMindspacePlugin || !this.screenAnalysis) {
            return;
        }

        try {
            const result = await this.nativeMindspacePlugin.listAnalyses({ limit: 50 });
            const analyses = Array.isArray(result?.analyses) ? result.analyses : [];
            if (analyses.length > 0) {
                this.screenAnalysis.mergeNativeAnalyses(analyses);
            }
        } catch (error) {
            console.warn('[AIOS] Failed to hydrate Mindspace from native store:', error);
        }
    }

    flushPendingMindspaceResults() {
        try {
            const queue = Array.isArray(window.__pendingMindspaceResults)
                ? window.__pendingMindspaceResults
                : [];

            if (queue.length === 0) {
                return;
            }

            queue.forEach((payload) => {
                if (!payload) return;
                this.screenAnalysis.handleResult(
                    payload.id,
                    payload.text,
                    payload.imageData,
                    payload.timestamp
                );
            });
            window.__pendingMindspaceResults = [];
        } catch (error) {
            console.warn('[AIOS] Failed flushing pending Mindspace results:', error);
        }
    }

    async syncNativeAuthSession(sessionOverride = null) {
        if (!this.nativeAuthSessionPlugin) return;

        try {
            let session = sessionOverride;
            if (!session) {
                const { data } = await supabase.auth.getSession();
                session = data?.session || null;
            }

            if (!session?.access_token) {
                await this.nativeAuthSessionPlugin.clearSession();
                return;
            }

            await this.nativeAuthSessionPlugin.syncSession({
                accessToken: session.access_token,
                refreshToken: session.refresh_token || '',
                expiresAt: session.expires_at || null,
                userId: session.user?.id || '',
            });
        } catch (error) {
            console.warn('[AIOS] Failed to sync native auth session:', error);
        }
    }

    async handleNativeAuthRequired(reason) {
        const message = (typeof reason === 'string' && reason.trim())
            ? reason.trim()
            : 'Please sign in to continue.';

        try {
            const { data } = await supabase.auth.getSession();
            if (data?.session?.access_token) {
                await this.syncNativeAuthSession(data.session);
                this.showNotification('Session restored for native features. Please try again.', 'info');
                return;
            }
        } catch (error) {
            console.warn('[AIOS] Failed to re-check auth session after native auth request:', error);
        }

        this.showNotification(message, 'warning');
        this.elements.settingsPanels?.forEach(panel => panel.classList.add('hidden'));
        this.openProfileMenu();
        this.switchAuthTab('login');

        const emailInput = this.elements.loginForm?.querySelector('#loginEmail');
        if (emailInput) {
            setTimeout(() => emailInput.focus(), 50);
        }
    }

    setTheme(theme) {
        document.body.classList.remove('light-mode', 'dark-mode');
        document.body.classList.add(`${theme}-mode`);
        // Save theme preference to localStorage
        localStorage.setItem('theme-preference', theme);
        this.updateThemeUI();
    }

    updateThemeUI() {
        const isDark = document.body.classList.contains('dark-mode');
        this.elements.themeOptions.forEach(option => {
            const theme = option.dataset.theme;
            const active = (isDark && theme === 'dark') || (!isDark && theme === 'light');
            option.classList.toggle('active', active);
        });
    }

    toggleProfileMenu() {
        const isOpen = !this.elements.profileDropdown.classList.contains('hidden');
        if (isOpen) {
            this.closeProfileMenu();
        } else {
            this.openProfileMenu();
        }
    }

    openProfileMenu() {
        this.elements.profileDropdown.classList.remove('hidden');
        this.elements.profileMenuBtn.setAttribute('aria-expanded', 'true');

        // Load settings view into dropdown
        if (this.elements.settingsView && !this.elements.profileDropdown.contains(this.elements.settingsView)) {
            this.elements.profileDropdown.appendChild(this.elements.settingsView);
        }

        // Update integration status if user is on account section
        this.updateIntegrationStatus();
        this.loadUsageData();
    }

    closeProfileMenu() {
        this.elements.profileDropdown.classList.add('hidden');
        this.elements.profileMenuBtn.setAttribute('aria-expanded', 'false');
    }

    openPanel(section) {
        const panel = document.getElementById(`${section}-panel`);
        if (panel) {
            panel.classList.remove('hidden');
            this.closeProfileMenu();

            // Update integration status when opening integrations panel
            if (section === 'integrations') {
                this.updateIntegrationStatus();
            } else if (section === 'usage') {
                this.loadUsageData();
            } else if (section === 'mindspace') {
                this.screenAnalysis.renderMindspace('mindspace-list');
            } else if (section === 'memory') {
                this.loadMemories();
            } else if (section === 'notes') {
                this.loadAssistantNotes();
            } else if (section === 'deployments') {
                this.deploySettingsManager.loadDeployments();
            } else if (section === 'files') {
                this.deploySettingsManager.loadFiles();
            } else if (section === 'database') {
                // Backward-compatibility for older menu entries.
                this.deploySettingsManager.loadFiles();
            } else if (section === 'offline-mode') {
                if (this.offlineModelManager) this.offlineModelManager.refreshStatus();
            }
        }
    }

    closePanel() {
        this.elements.settingsPanels?.forEach(panel => {
            panel.classList.add('hidden');
        });
        this.closeSubscriptionModal();
        // Reset memory form state when navigating away
        const fw = document.getElementById('memory-form-wrapper');
        if (fw) fw.classList.add('hidden');
        this._editingMemoryId = null;
        // Close any open card dropdowns
        document.querySelectorAll('.mem-card-dropdown').forEach(d => d.classList.add('hidden'));
        document.querySelectorAll('.mem-card-more-btn').forEach(b => b.classList.remove('active'));
        this.openProfileMenu();
    }

    switchAuthTab(tabName) {
        this.elements.authTabs.forEach(tab =>
            tab.classList.toggle('active', tab.dataset.authTab === tabName)
        );
        this.elements.loginForm.classList.toggle('active', tabName === 'login');
        this.elements.signupForm.classList.toggle('active', tabName === 'signup');
    }

    // Legacy methods for backward compatibility
    openSidebar() {
        this.openProfileMenu();
    }

    closeSidebar() {
        this.closeProfileMenu();
        this.elements.settingsPanels?.forEach(panel => {
            panel.classList.add('hidden');
        });
    }

    async handleLogin() {
        const email = this.elements.loginForm.querySelector('#loginEmail').value;
        const password = this.elements.loginForm.querySelector('#loginPassword').value;
        this.elements.loginError.textContent = '';

        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            this.elements.loginError.textContent = error.message;
        } else {
            this.showNotification('Logged in successfully!', 'success');
            this.elements.loginForm.reset();
            this.closeProfileMenu();
        }
    }

    async handleSignup() {
        const name = this.elements.signupForm.querySelector('#signupName').value;
        const email = this.elements.signupForm.querySelector('#signupEmail').value;
        const password = this.elements.signupForm.querySelector('#signupPassword').value;
        const confirm = this.elements.signupForm.querySelector('#confirmPassword').value;

        this.elements.signupError.textContent = '';
        if (password !== confirm) {
            this.elements.signupError.textContent = 'Passwords do not match.';
            return;
        }

        const { error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { name } }
        });

        if (error) {
            this.elements.signupError.textContent = error.message;
        } else {
            this.showNotification('Signup successful! Check your email.', 'success');
            this.elements.signupForm.reset();
            this.switchAuthTab('login');
        }
    }

    async handleLogout() {
        if (confirm('Are you sure you want to log out?')) {
            await supabase.auth.signOut();
            this.showNotification('Logged out successfully.', 'success');
        }
    }

    async updateAuthUI(user) {
        const isAuthenticated = !!user;
        this.elements.accountLoggedIn?.classList.toggle('hidden', !isAuthenticated);
        this.elements.accountLoggedOut?.classList.toggle('hidden', isAuthenticated);

        if (isAuthenticated) {
            const userName = user.user_metadata?.name || user.user_metadata?.full_name || 'User';
            const userEmail = user.email;

            // Update profile header card
            if (this.elements.userNameDisplay) {
                this.elements.userNameDisplay.textContent = userName;
            }
            if (this.elements.userEmailDisplay) {
                this.elements.userEmailDisplay.textContent = userEmail;
            }

            // Update profile photo in top bar
            this.updateProfilePhoto(user);

            // Update profile avatar in header card
            this.updateProfileAvatarLarge(user);
        } else {
            // Clear profile photo when logged out
            this.clearProfilePhoto();
            this.clearProfileAvatarLarge();
            this.updateIntegrationStatus(); // safe to clear buttons
            this.usageRenderer?.renderLoggedOut();
            this.renderAccountSubscriptionLoggedOut();
            this.closeSubscriptionModal();
            this.subscriptionSummary = null;
            this.deploySettingsManager?.reset();
        }
    }

    async loadUsageData() {
        if (!this.usageRenderer || this.isSubscriptionLoading) return;

        this.isSubscriptionLoading = true;
        const token = await this._getAccessToken();
        if (!token) {
            this.subscriptionSummary = null;
            this.usageRenderer.renderLoggedOut();
            this.renderAccountSubscriptionLoggedOut();
            this.isSubscriptionLoading = false;
            return;
        }

        this.usageRenderer.setState('loading');
        this.usageRenderer.setManagePlansEnabled(false);
        this.elements.accountManagePlansBtn && (this.elements.accountManagePlansBtn.disabled = true);

        try {
            const response = await fetch(`${API_BACKEND_URL}/api/subscription/status`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload?.ok || !payload?.summary) {
                throw new Error(payload?.error || `Failed to load subscription status (HTTP ${response.status})`);
            }

            const summary = payload.summary;
            this.subscriptionSummary = summary;
            this.usageRenderer.renderSummary(summary);
            this.renderAccountSubscriptionCard(summary);
            this.renderPricingModal(summary);
            this.usageRenderer.setManagePlansEnabled(true);
            this.elements.accountManagePlansBtn && (this.elements.accountManagePlansBtn.disabled = false);
        } catch (error) {
            console.error('[Subscription] Failed to load subscription status:', error);
            this.subscriptionSummary = null;
            this.usageRenderer.renderError();
            this.renderAccountSubscriptionUnavailable();
            this.usageRenderer.setManagePlansEnabled(false);
            this.elements.accountManagePlansBtn && (this.elements.accountManagePlansBtn.disabled = true);
        } finally {
            this.isSubscriptionLoading = false;
        }
    }

    renderAccountSubscriptionLoggedOut() {
        if (!this.elements.accountSubscriptionCard) return;
        this.elements.accountSubscriptionCard.classList.add('hidden');
        if (this.elements.accountManagePlansBtn) {
            this.elements.accountManagePlansBtn.disabled = true;
        }
    }

    renderAccountSubscriptionUnavailable() {
        if (!this.elements.accountSubscriptionCard) return;
        this.elements.accountSubscriptionCard.classList.remove('hidden');
        if (this.elements.accountSubscriptionTitle) this.elements.accountSubscriptionTitle.textContent = 'Unavailable';
        if (this.elements.accountSubscriptionStatus) this.elements.accountSubscriptionStatus.textContent = 'Error';
        if (this.elements.accountSubscriptionLimit) this.elements.accountSubscriptionLimit.textContent = 'Unable to load subscription details.';
        if (this.elements.accountSubscriptionMeta) this.elements.accountSubscriptionMeta.textContent = 'Try again from Usage refresh.';
        if (this.elements.accountSubscriptionMeterFill) this.elements.accountSubscriptionMeterFill.style.width = '0%';
        if (this.elements.accountSubscriptionUsed) this.elements.accountSubscriptionUsed.textContent = 'Used: 0';
        if (this.elements.accountSubscriptionRemaining) this.elements.accountSubscriptionRemaining.textContent = 'Remaining: 0';
        if (this.elements.accountManagePlansBtn) {
            this.elements.accountManagePlansBtn.disabled = true;
        }
    }

    renderAccountSubscriptionCard(summary) {
        if (!this.elements.accountSubscriptionCard) return;

        const usage = summary?.usage || {};
        const usagePercent = Math.max(0, Math.min(Number(summary?.usage_percent) || 0, 100));
        const usedTokens = Number(usage?.total_tokens) || 0;
        const remainingTokens = Number(summary?.remaining_tokens) || 0;

        this.elements.accountSubscriptionCard.classList.remove('hidden');
        if (this.elements.accountSubscriptionTitle) this.elements.accountSubscriptionTitle.textContent = summary?.plan_name || 'Core';
        if (this.elements.accountSubscriptionStatus) this.elements.accountSubscriptionStatus.textContent = summary?.status_label || 'Free';
        if (this.elements.accountSubscriptionLimit) this.elements.accountSubscriptionLimit.textContent = summary?.limit_label || '50,000 tokens/day';
        if (this.elements.accountSubscriptionMeta) {
            const periodEnd = summary?.current_period_end ? this._formatDateTime(summary.current_period_end) : '—';
            this.elements.accountSubscriptionMeta.textContent = `${summary?.period_label || 'Current day'} • Resets: ${periodEnd}`;
        }
        if (this.elements.accountSubscriptionMeterFill) this.elements.accountSubscriptionMeterFill.style.width = `${usagePercent}%`;
        if (this.elements.accountSubscriptionUsed) this.elements.accountSubscriptionUsed.textContent = `Used: ${this._formatNumber(usedTokens)}`;
        if (this.elements.accountSubscriptionRemaining) this.elements.accountSubscriptionRemaining.textContent = `Remaining: ${this._formatNumber(remainingTokens)}`;
        if (this.elements.accountManagePlansBtn) this.elements.accountManagePlansBtn.disabled = false;
    }

    renderPricingModal(summary) {
        if (!this.elements.subscriptionPlanGrid) return;

        const currentPlanType = String(summary?.plan_type || 'free');
        const canCreateSubscription = Boolean(summary?.can_create_subscription);
        const periodLabel = summary?.period_label || 'Current day';
        const periodEnd = summary?.current_period_end ? this._formatDateTime(summary.current_period_end) : '—';

        if (this.elements.subscriptionHeroTitle) this.elements.subscriptionHeroTitle.textContent = summary?.plan_name || 'Core';
        if (this.elements.subscriptionHeroStatus) this.elements.subscriptionHeroStatus.textContent = summary?.status_label || 'Free';
        if (this.elements.subscriptionHeroLimit) this.elements.subscriptionHeroLimit.textContent = summary?.limit_label || '50,000 tokens/day';
        if (this.elements.subscriptionHeroPeriod) this.elements.subscriptionHeroPeriod.textContent = `${periodLabel} • Resets: ${periodEnd}`;
        if (this.elements.subscriptionModalFootnote) {
            this.elements.subscriptionModalFootnote.textContent = canCreateSubscription
                ? 'Choose a plan to continue.'
                : 'An existing subscription is active or pending for this account.';
        }

        const plans = Array.isArray(summary?.plans) ? summary.plans : [];
        this.elements.subscriptionPlanGrid.innerHTML = plans.map((plan) => {
            const action = this.getPlanActionState(plan, summary);
            const isCurrent = currentPlanType === plan.type;
            const classes = [
                'subscription-plan-card',
                isCurrent ? 'is-current' : '',
                plan.type === 'pro' ? 'is-highlighted' : '',
                plan.type === 'elite' ? 'is-elite' : '',
            ].filter(Boolean).join(' ');
            return `
                <article class="${classes}">
                    <div class="subscription-plan-top">
                        <div>
                            <h4 class="subscription-plan-title">${plan.name}</h4>
                            <p class="subscription-plan-price">INR ${this._formatNumber(plan.price_inr)} <span>/ ${plan.interval_label || 'month'}</span></p>
                        </div>
                    </div>
                    <p class="subscription-plan-limit">${plan.token_limit_label || `${this._formatNumber(plan.limit_tokens)} tokens/${plan.interval_label}`}</p>
                    <p class="subscription-plan-description">${plan.description || ''}</p>
                    <p class="subscription-plan-status">${action.note}</p>
                    <button
                        type="button"
                        class="btn btn-primary subscription-plan-action"
                        data-plan-type="${plan.type}"
                        ${action.disabled ? 'disabled' : ''}
                    >
                        ${action.label}
                    </button>
                </article>
            `;
        }).join('');
    }

    getPlanActionState(plan, summary) {
        const planType = String(plan?.type || 'free');
        const currentPlanType = String(summary?.plan_type || 'free');
        const status = String(summary?.subscription_status || 'none').toLowerCase();
        const canCreateSubscription = Boolean(summary?.can_create_subscription);

        if (planType === 'free') {
            return {
                label: currentPlanType === 'free' ? 'Current Plan' : 'Included',
                note: currentPlanType === 'free'
                    ? 'You are currently on this plan.'
                    : 'Free plan is always available.',
                disabled: true,
            };
        }

        if (currentPlanType === planType && ACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
            return {
                label: 'Current Plan',
                note: 'You are currently on this plan.',
                disabled: true,
            };
        }

        if (!canCreateSubscription) {
            return {
                label: 'Unavailable',
                note: 'Existing subscription in progress.',
                disabled: true,
            };
        }

        if (this.isCheckoutInProgress) {
            return {
                label: 'Processing...',
                note: 'Please complete the current checkout.',
                disabled: true,
            };
        }

        return {
            label: plan?.cta_label || `Upgrade to ${plan?.name || 'Plan'}`,
            note: 'Upgrade instantly using Razorpay Checkout.',
            disabled: false,
        };
    }

    async openSubscriptionModal(reason = 'manual') {
        if (!this.subscriptionSummary) {
            await this.loadUsageData();
        }
        if (!this.subscriptionSummary) {
            this.showNotification('Unable to load subscription plans right now.', 'error');
            return;
        }
        this.renderPricingModal(this.subscriptionSummary);
        this.elements.subscriptionModal?.classList.remove('hidden');
        this.elements.subscriptionModal?.setAttribute('data-open-reason', reason);
    }

    closeSubscriptionModal() {
        this.elements.subscriptionModal?.classList.add('hidden');
    }

    async startPlanUpgrade(planType) {
        const normalizedPlan = String(planType || '').toLowerCase();
        if (!['pro', 'elite'].includes(normalizedPlan)) return;
        if (!this.subscriptionSummary) {
            this.showNotification('Subscription status not loaded. Please refresh and try again.', 'warning');
            return;
        }
        if (!this.subscriptionSummary.can_create_subscription) {
            this.showNotification('An active or pending subscription already exists for this account.', 'warning');
            return;
        }
        if (this.isCheckoutInProgress) {
            this.showNotification('Checkout already in progress.', 'info');
            return;
        }

        const token = await this._getAccessToken();
        if (!token) {
            this.showNotification('Please log in to manage plans.', 'error');
            return;
        }

        this.isCheckoutInProgress = true;
        this.renderPricingModal(this.subscriptionSummary);

        try {
            const response = await fetch(`${API_BACKEND_URL}/api/subscription/create`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ plan_type: normalizedPlan }),
            });
            const payload = await response.json().catch(() => ({}));

            if (!response.ok || !payload?.ok) {
                const message = payload?.error || 'Failed to create subscription.';
                this.showNotification(message, response.status === 409 ? 'warning' : 'error');
                return;
            }
            await this.launchRazorpayCheckout(payload);
        } catch (error) {
            console.error('[Subscription] Failed to start checkout:', error);
            this.showNotification(error.message || 'Failed to start checkout.', 'error');
        } finally {
            this.isCheckoutInProgress = false;
            if (this.subscriptionSummary) {
                this.renderPricingModal(this.subscriptionSummary);
            }
        }
    }

    async launchRazorpayCheckout(createPayload) {
        if (typeof window.Razorpay !== 'function') {
            throw new Error('Razorpay Checkout SDK is unavailable.');
        }

        const keyId = createPayload?.key_id;
        const subscriptionId = createPayload?.subscription_id;
        if (!keyId || !subscriptionId) {
            throw new Error('Invalid checkout payload received from server.');
        }

        await new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            const razorpay = new window.Razorpay({
                key: keyId,
                subscription_id: subscriptionId,
                name: 'Aetheria AI',
                description: `${createPayload?.plan_name || 'Premium'} Subscription`,
                prefill: {
                    email: this.subscriptionSummary?.profile?.email || '',
                    name: this.subscriptionSummary?.profile?.name || '',
                },
                theme: {
                    color: '#BD18C9',
                },
                modal: {
                    ondismiss: () => {
                        settle(false);
                    },
                },
                handler: async (response) => {
                    try {
                        await this.completeUpgradeVerification(response);
                        settle(true);
                    } catch (error) {
                        console.error('[Subscription] Verification failed:', error);
                        this.showNotification(error.message || 'Payment verification failed.', 'error');
                        settle(false);
                    }
                },
            });

            razorpay.on('payment.failed', (response) => {
                const description = response?.error?.description || 'Payment failed. Please try another method.';
                this.showNotification(description, 'error');
                settle(false);
            });

            razorpay.open();
        });
    }

    async completeUpgradeVerification(razorpayPayload) {
        const paymentId = razorpayPayload?.razorpay_payment_id;
        const subscriptionId = razorpayPayload?.razorpay_subscription_id;
        const signature = razorpayPayload?.razorpay_signature;
        if (!paymentId || !subscriptionId || !signature) {
            throw new Error('Missing payment verification fields.');
        }

        const token = await this._getAccessToken();
        if (!token) {
            throw new Error('Session expired. Please log in again.');
        }

        const response = await fetch(`${API_BACKEND_URL}/api/subscription/verify`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                razorpay_payment_id: paymentId,
                razorpay_subscription_id: subscriptionId,
                razorpay_signature: signature,
            }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error || 'Failed to verify subscription payment.');
        }

        this.showNotification('Subscription upgraded successfully.', 'success');
        await this.loadUsageData();
        this.closeSubscriptionModal();
    }

    async handleSubscriptionLimitExceeded(detail = {}) {
        await this.loadUsageData();
        this.openPanel('usage');
        await this.openSubscriptionModal('limit_reached');
    }

    _formatNumber(value) {
        return new Intl.NumberFormat().format(Number(value) || 0);
    }

    _formatDateTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleString();
    }

    updateProfilePhoto(user) {
        // Get profile photo URL from user metadata
        const photoUrl = user.user_metadata?.avatar_url ||
            user.user_metadata?.picture ||
            user.user_metadata?.photo_url;

        if (photoUrl && this.elements.profilePhoto) {
            this.elements.profilePhoto.src = photoUrl;
            this.elements.profilePhoto.classList.remove('hidden');

            // Add error handler in case image fails to load
            this.elements.profilePhoto.onerror = () => {
                this.clearProfilePhoto();
            };
        } else {
            this.clearProfilePhoto();
        }
    }

    clearProfilePhoto() {
        if (this.elements.profilePhoto) {
            this.elements.profilePhoto.classList.add('hidden');
            this.elements.profilePhoto.src = '';
        }
    }

    updateProfileAvatarLarge(user) {
        // Get profile photo URL from user metadata
        const photoUrl = user.user_metadata?.avatar_url ||
            user.user_metadata?.picture ||
            user.user_metadata?.photo_url;

        const avatarContainer = this.elements.profileAvatarLarge;
        if (!avatarContainer) return;

        // Clear existing content
        avatarContainer.innerHTML = '';

        if (photoUrl) {
            // Create and add image element
            const img = document.createElement('img');
            img.src = photoUrl;
            img.alt = 'Profile Avatar';
            img.onerror = () => {
                // Fallback to icon if image fails to load
                avatarContainer.innerHTML = '<i class="fas fa-user"></i>';
            };
            avatarContainer.appendChild(img);
        } else {
            // Show default icon if no photo URL
            avatarContainer.innerHTML = '<i class="fas fa-user"></i>';
        }
    }

    clearProfileAvatarLarge() {
        const avatarContainer = this.elements.profileAvatarLarge;
        if (avatarContainer) {
            avatarContainer.innerHTML = '<i class="fas fa-user"></i>';
        }
    }

    handleIntegrationClick(event) {
        const button = event.currentTarget;
        const provider = button.dataset.provider;
        const action = button.dataset.action || 'connect';

        if (this.isComposioProvider(provider)) {
            if (action === 'connect') {
                this.handleComposioConnect(provider);
            } else {
                this.handleComposioDisconnect(provider);
            }
            return;
        }

        if (action === 'connect') {
            this.handleIntegrationConnect(provider);
        } else {
            this.handleIntegrationDisconnect(provider);
        }
    }

    isComposioProvider(provider) {
        return Boolean(COMPOSIO_PROVIDERS[provider]);
    }

    getComposioConfig(provider) {
        return COMPOSIO_PROVIDERS[provider] || null;
    }

    getComposioLabelByToolkit(toolkit) {
        return Object.values(COMPOSIO_PROVIDERS)
            .find((config) => config.toolkit === toolkit)?.label || toolkit;
    }

    async buildComposioCallbackUrl(toolkit) {
        try {
            const { Capacitor } = await import('@capacitor/core');
            if (Capacitor.isNativePlatform()) {
                return `aios://auth-callback?composio_callback=true&toolkit=${encodeURIComponent(toolkit)}`;
            }
        } catch (error) {
            console.warn('Unable to detect native platform for Composio callback URL:', error);
        }

        const callbackUrl = new URL(window.location.href);
        callbackUrl.searchParams.set('composio_callback', 'true');
        callbackUrl.searchParams.set('toolkit', toolkit);
        return callbackUrl.toString();
    }

    async handleIntegrationConnect(provider) {
        this.showNotification(`Connecting to ${provider}...`, 'info');
        await supabase.auth.refreshSession();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            this.showNotification("You must be logged in to connect an integration.", 'error');
            return;
        }

        try {
            // Build OAuth URL with session token - use Render for OAuth
            const authUrl = `${OAUTH_BACKEND_URL}/login/${provider}?token=${session.access_token}`;

            // Open OAuth popup window
            const authWindow = window.open(
                authUrl,
                `${provider}Auth`,
                'width=600,height=700,scrollbars=yes,resizable=yes'
            );

            if (!authWindow) {
                throw new Error('Popup blocked. Please allow popups for this site.');
            }

            // Monitor popup for completion
            const checkInterval = setInterval(() => {
                try {
                    // Check if popup was closed
                    if (authWindow.closed) {
                        clearInterval(checkInterval);
                        console.log('OAuth popup closed');
                    }
                } catch (e) {
                    // Cross-origin errors are expected
                }
            }, 500);

            // Timeout after 5 minutes
            setTimeout(() => {
                clearInterval(checkInterval);
                if (!authWindow.closed) {
                    authWindow.close();
                    this.showNotification('OAuth timeout. Please try again.', 'error');
                }
            }, 300000);

        } catch (error) {
            console.error('Integration connection error:', error);
            this.showNotification(`Error connecting to ${provider}: ${error.message}`, 'error');
        }
    }

    async handleComposioConnect(provider) {
        const composioConfig = this.getComposioConfig(provider);
        if (!composioConfig) return;

        const token = await this._getAccessToken();
        if (!token) {
            this.showNotification("You must be logged in to connect an integration.", 'error');
            return;
        }

        this.showNotification(`Connecting ${composioConfig.label}...`, 'info');

        try {
            const callbackUrl = await this.buildComposioCallbackUrl(composioConfig.toolkit);

            const response = await fetch(`${API_BACKEND_URL}/api/composio/connect-url`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    toolkit: composioConfig.toolkit,
                    callback_url: callbackUrl
                })
            });

            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `Failed to start ${composioConfig.label} connection.`);
            }

            if (!payload.redirect_url) {
                throw new Error(`No redirect URL returned for ${composioConfig.label}.`);
            }

            const authWindow = window.open(
                payload.redirect_url,
                `${provider}Auth`,
                'width=600,height=700,scrollbars=yes,resizable=yes'
            );

            if (!authWindow) {
                throw new Error('Popup blocked. Please allow popups for this site.');
            }

            const checkInterval = setInterval(() => {
                if (!authWindow.closed) return;
                clearInterval(checkInterval);
                this.updateIntegrationStatus();
            }, 1000);

            setTimeout(() => {
                clearInterval(checkInterval);
                if (!authWindow.closed) {
                    authWindow.close();
                    this.showNotification(`${composioConfig.label} connection timed out. Please try again.`, 'error');
                }
            }, 300000);
        } catch (error) {
            console.error('Composio connection error:', error);
            this.showNotification(`Error connecting ${composioConfig.label}: ${error.message}`, 'error');
        }
    }

    async handleIntegrationDisconnect(provider) {
        if (!confirm(`Are you sure you want to disconnect your ${provider} account?`)) return;

        await supabase.auth.refreshSession();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            this.showNotification("Session expired. Please log in again.", 'error');
            return;
        }

        try {
            const response = await fetch(`${API_BACKEND_URL}/api/integrations/disconnect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ service: provider })
            });

            if (!response.ok) throw new Error('Failed to disconnect.');
            this.showNotification(`Successfully disconnected from ${provider}.`, 'success');
            this.updateIntegrationStatus();
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    async handleComposioDisconnect(provider) {
        const composioConfig = this.getComposioConfig(provider);
        if (!composioConfig) return;

        if (!confirm(`Are you sure you want to disconnect ${composioConfig.label}?`)) return;

        const token = await this._getAccessToken();
        if (!token) {
            this.showNotification("Session expired. Please log in again.", 'error');
            return;
        }

        try {
            const response = await fetch(`${API_BACKEND_URL}/api/composio/disconnect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ toolkit: composioConfig.toolkit })
            });

            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `Failed to disconnect ${composioConfig.label}.`);
            }

            this.showNotification(`Disconnected ${composioConfig.label}.`, 'success');
            this.updateIntegrationStatus();
        } catch (error) {
            console.error('Composio disconnect error:', error);
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    async updateIntegrationStatus() {
        const token = await this._getAccessToken();
        if (!token) {
            // Clear all integration buttons when not logged in
            this.updateButtonUI(this.elements.githubConnectBtn, false);
            this.updateButtonUI(this.elements.googleConnectBtn, false);
            this.updateButtonUI(this.elements.googleSheetsConnectBtn, false);
            this.updateButtonUI(this.elements.whatsappConnectBtn, false);
            this.updateButtonUI(this.elements.vercelConnectBtn, false);
            this.updateButtonUI(this.elements.supabaseConnectBtn, false);
            return;
        }

        try {
            const response = await fetch(`${API_BACKEND_URL}/api/integrations`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) {
                console.error("Failed to fetch integration status:", response.statusText);
            } else {
                const { integrations } = await response.json();

                // Update all integration buttons
                this.updateButtonUI(this.elements.githubConnectBtn, integrations.includes('github'));
                this.updateButtonUI(this.elements.googleConnectBtn, integrations.includes('google'));
                this.updateButtonUI(this.elements.vercelConnectBtn, integrations.includes('vercel'));
                this.updateButtonUI(this.elements.supabaseConnectBtn, integrations.includes('supabase'));
            }

        } catch (error) {
            console.error("Error fetching integration status:", error);
            // Don't show error to user, just log it
        }

        await this.updateComposioStatus(token);
    }

    async updateComposioStatus(token = null) {
        const accessToken = token || await this._getAccessToken();
        if (!accessToken) {
            this.updateButtonUI(this.elements.googleSheetsConnectBtn, false);
            this.updateButtonUI(this.elements.whatsappConnectBtn, false);
            return;
        }

        const composioButtons = [
            { provider: 'composio-googlesheets', button: this.elements.googleSheetsConnectBtn },
            { provider: 'composio-whatsapp', button: this.elements.whatsappConnectBtn }
        ];

        await Promise.all(composioButtons.map(async ({ provider, button }) => {
            const composioConfig = this.getComposioConfig(provider);
            if (!composioConfig || !button) return;

            try {
                const response = await fetch(
                    `${API_BACKEND_URL}/api/composio/status?toolkit=${encodeURIComponent(composioConfig.toolkit)}`,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    }
                );

                if (!response.ok) {
                    throw new Error(response.statusText || `Failed to fetch ${composioConfig.label} status.`);
                }

                const payload = await response.json();
                this.updateButtonUI(button, Boolean(payload.connected));
            } catch (error) {
                console.error(`Error fetching ${composioConfig.label} status:`, error);
                this.updateButtonUI(button, false);
            }
        }));
    }

    updateButtonUI(button, isConnected) {
        if (!button) return;
        const textSpan = button.querySelector('.btn-text');
        const connectIcon = button.querySelector('.icon-connect');
        const connectedIcon = button.querySelector('.icon-connected');

        if (isConnected) {
            button.dataset.action = 'disconnect';
            textSpan.textContent = 'Disconnect';
            connectIcon.style.display = 'none';
            connectedIcon.style.display = 'inline';
            button.classList.add('connected');
        } else {
            button.dataset.action = 'connect';
            textSpan.textContent = 'Connect';
            connectIcon.style.display = 'inline';
            connectedIcon.style.display = 'none';
            button.classList.remove('connected');
        }
    }

    showNotification(message, type = 'success', duration = 4000) {
        if (this.notificationService) {
            return this.notificationService.show(message, type, duration);
        }
    }

    /**
     * Handle OAuth callback when user is redirected back from Google
     */
    async handleOAuthCallback() {
        try {
            // Check if we have OAuth parameters in the URL
            const hashParams = new URLSearchParams(window.location.hash.substring(1));
            const searchParams = new URLSearchParams(window.location.search);

            // Supabase returns tokens in hash for implicit flow or in search for PKCE flow
            const hasOAuthParams = hashParams.has('access_token') ||
                searchParams.has('code') ||
                hashParams.has('error') ||
                searchParams.has('error');

            if (hasOAuthParams) {
                // Check for errors first
                const error = hashParams.get('error') || searchParams.get('error');
                const errorDescription = hashParams.get('error_description') || searchParams.get('error_description');

                if (error) {
                    console.error('OAuth error:', error, errorDescription);
                    this.showNotification(
                        `Sign-in failed: ${errorDescription || error}`,
                        'error'
                    );
                    // Clean up URL
                    window.history.replaceState({}, document.title, window.location.pathname);
                    return;
                }

                // Let Supabase handle the OAuth callback automatically
                // It will parse the tokens from the URL and set the session
                const { data, error: sessionError } = await supabase.auth.getSession();

                if (sessionError) {
                    console.error('Error getting session after OAuth:', sessionError);
                    this.showNotification('Failed to complete sign-in. Please try again.', 'error');
                } else if (data.session) {
                    console.log('OAuth callback successful, user signed in:', data.session.user);
                    this.showNotification('Successfully signed in with Google!', 'success');

                    // Close the profile menu after successful login
                    setTimeout(() => {
                        this.closeProfileMenu();
                    }, 1500);
                }

                // Clean up URL to remove OAuth parameters
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        } catch (error) {
            console.error('Error handling OAuth callback:', error);
        }
    }

    /**
     * Handle integration OAuth callback (GitHub, Google integrations, etc.)
     * This is called when the OAuth popup redirects back with auth_success or auth_error
     */
    handleIntegrationOAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const authSuccess = urlParams.get('auth_success');
        const authError = urlParams.get('auth_error');
        const provider = urlParams.get('provider');
        const message = urlParams.get('message');

        // Check if this is an OAuth callback in a popup window
        if (authSuccess === 'true' || authError === 'true') {
            // If we're in a popup (opened by window.open), notify the parent and close
            if (window.opener && !window.opener.closed) {
                console.log('OAuth callback detected in popup, notifying parent window');

                // Send message to parent window
                window.opener.postMessage({
                    type: 'oauth-callback',
                    success: authSuccess === 'true',
                    provider: provider,
                    error: authError === 'true' ? message : null
                }, window.location.origin);

                // Close the popup after a short delay
                setTimeout(() => {
                    window.close();
                }, 500);
            } else {
                // If not in a popup, just show notification and clean URL
                if (authSuccess === 'true') {
                    this.showNotification(`Successfully connected to ${provider}!`, 'success');
                    this.updateIntegrationStatus();
                } else if (authError === 'true') {
                    this.showNotification(`Failed to connect: ${message || 'Unknown error'}`, 'error');
                }

                // Clean up URL
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }
    }

    handleComposioCallback() {
        const url = new URL(window.location.href);
        const isComposioCallback = url.searchParams.get('composio_callback') === 'true';
        const toolkit = url.searchParams.get('toolkit');

        if (!isComposioCallback || !toolkit) return;

        const toolkitLabel = this.getComposioLabelByToolkit(toolkit);

        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
                type: 'composio-callback',
                success: true,
                toolkit
            }, window.location.origin);

            setTimeout(() => {
                window.close();
            }, 500);
            return;
        }

        this.showNotification(`${toolkitLabel} connected successfully.`, 'success');
        this.updateIntegrationStatus();
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    // =========================================================
    // =========================================================
    // NOTES SECTION
    // =========================================================

    async loadAssistantNotes() {
        this._notesSetState('loading');

        const storageEl = this.elements.notesStorageMeta || document.getElementById('notes-storage-meta');
        if (storageEl) {
            storageEl.textContent = 'Storage: loading...';
        }

        if (!this.nativeAssistantNotesPlugin) {
            this.assistantNotesCache = [];
            this._notesSetState('error');
            if (storageEl) {
                storageEl.textContent = 'Storage: native notes are only available in the Android app.';
            }
            return;
        }

        try {
            const payload = await this.nativeAssistantNotesPlugin.getNotes();
            const notes = Array.isArray(payload?.notes) ? payload.notes : [];
            const storage = payload?.storage || {};
            const count = Number.isFinite(payload?.count) ? payload.count : notes.length;

            this.assistantNotesCache = notes;
            this._renderAssistantNotes();

            if (storageEl) {
                const storageType = storage?.storage_type || 'unknown';
                const relativePath = storage?.relative_path || '';
                storageEl.textContent = `Storage: ${storageType}\nPath: ${relativePath}\nCount: ${count}`;
            }
        } catch (err) {
            console.error('[Notes] loadAssistantNotes failed:', err);
            this.assistantNotesCache = [];
            this._notesSetState('error');
            if (storageEl) {
                storageEl.textContent = `Storage: failed to load (${err?.message || 'unknown error'})`;
            }
        }
    }

    _notesSetState(state) {
        const loading = document.getElementById('notes-loading');
        const empty = document.getElementById('notes-empty');
        const error = document.getElementById('notes-error');
        const list = this.elements.notesList || document.getElementById('notes-list');

        [loading, empty, error].forEach(el => el?.classList.add('hidden'));
        if (list) list.innerHTML = '';

        if (state === 'loading') loading?.classList.remove('hidden');
        else if (state === 'empty') empty?.classList.remove('hidden');
        else if (state === 'error') error?.classList.remove('hidden');
    }

    _renderAssistantNotes() {
        const list = this.elements.notesList || document.getElementById('notes-list');
        if (!list) return;

        if (!Array.isArray(this.assistantNotesCache) || this.assistantNotesCache.length === 0) {
            this._notesSetState('empty');
            return;
        }

        this._notesSetState('list');
        list.innerHTML = '';

        const notesDesc = [...this.assistantNotesCache].sort((a, b) => {
            const ta = Number(a?.updated_at || a?.created_at || 0);
            const tb = Number(b?.updated_at || b?.created_at || 0);
            return tb - ta;
        });

        notesDesc.forEach(note => {
            const card = this._buildAssistantNoteCard(note);
            list.appendChild(card);
        });
    }

    _buildAssistantNoteCard(note) {
        const wrap = document.createElement('div');
        wrap.className = 'notes-card';

        const title = (note?.title || '').trim() || 'Untitled';
        const content = (note?.content || '').trim();
        const updatedAt = Number(note?.updated_at || note?.created_at || 0);
        const relativeTime = updatedAt > 0 ? this._timeAgo(updatedAt) : '';
        const absoluteTime = updatedAt > 0 ? new Date(updatedAt).toLocaleString() : '';
        const timeText = relativeTime && absoluteTime ? `${relativeTime} (${absoluteTime})` : (relativeTime || absoluteTime || 'Unknown time');

        wrap.innerHTML = `
            <h3 class="notes-card-title">${this._esc(title)}</h3>
            <div class="notes-card-time">${this._esc(timeText)}</div>
            <div class="notes-card-content">${this._esc(content || 'No content')}</div>
        `;
        return wrap;
    }

    // ✦ MEMORY SECTION
    // =========================================================

    /** Return current session access token, or null if not logged in */
    async _getAccessToken() {
        await supabase.auth.refreshSession();
        const { data: { session } } = await supabase.auth.getSession();
        return session?.access_token || null;
    }

    /** Load memories from GET /api/memories and render cards */
    async loadMemories() {
        const token = await this._getAccessToken();
        if (!token) return;

        // Show loading
        this._memorySetState('loading');

        try {
            const res = await fetch(`${API_BACKEND_URL}/api/memories`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const json = await res.json();
            this.memoriesCache = json.memories || [];
            this._renderMemoryCards();
        } catch (err) {
            console.error('[Memory] loadMemories failed:', err);
            this._memorySetState('error');
        }

        // Bind retry
        const retryBtn = document.getElementById('memory-retry-btn');
        if (retryBtn) {
            retryBtn.onclick = () => this.loadMemories();
        }

        // Bind form events (safe to call multiple times)
        this._bindMemoryFormEvents();
    }

    /** Switch between loading / empty / error / list states */
    _memorySetState(state) {
        const loading = document.getElementById('memory-loading');
        const empty = document.getElementById('memory-empty');
        const error = document.getElementById('memory-error');
        const list = document.getElementById('memory-list');

        [loading, empty, error].forEach(el => el?.classList.add('hidden'));
        if (list) list.innerHTML = '';

        if (state === 'loading') loading?.classList.remove('hidden');
        else if (state === 'empty') empty?.classList.remove('hidden');
        else if (state === 'error') error?.classList.remove('hidden');
        // 'list' state: fall through, cards will be appended
    }

    /** Render memory cards into #memory-list */
    _renderMemoryCards() {
        const list = document.getElementById('memory-list');
        if (!list) return;

        if (this.memoriesCache.length === 0) {
            this._memorySetState('empty');
            return;
        }

        this._memorySetState('list'); // clears loading/empty/error
        list.innerHTML = '';

        this.memoriesCache.forEach(row => {
            const card = this._buildMemoryCard(row);
            list.appendChild(card);
        });
    }

    /** Build a single memory card DOM element */
    _buildMemoryCard(row) {
        const wrap = document.createElement('div');
        wrap.className = 'memory-card';
        wrap.dataset.memoryId = row.memory_id;

        const contentText = this._formatMemoryContent(row.memory);
        const topicsText = this._formatTopics(row.topics);
        const timeText = row.updated_at ? this._timeAgo(row.updated_at * 1000) : '';

        // Build detail rows only for non-empty optional fields
        const detailRows = [
            row.input ? `<div class="mem-detail-row"><span class="mem-detail-label">Input</span><span class="mem-detail-val">${this._esc(row.input)}</span></div>` : '',
            row.agent_id ? `<div class="mem-detail-row"><span class="mem-detail-label">Agent</span><span class="mem-detail-val mem-detail-val--code">${this._esc(row.agent_id)}</span></div>` : '',
            row.team_id ? `<div class="mem-detail-row"><span class="mem-detail-label">Team</span><span class="mem-detail-val mem-detail-val--code">${this._esc(row.team_id)}</span></div>` : '',
            topicsText ? `<div class="mem-detail-row"><span class="mem-detail-label">Topics</span><span class="mem-detail-val">${this._esc(topicsText)}</span></div>` : '',
            row.memory_id ? `<div class="mem-detail-row"><span class="mem-detail-label">ID</span><span class="mem-detail-val mem-detail-val--code mem-detail-val--muted">${this._esc(row.memory_id)}</span></div>` : '',
        ].filter(Boolean).join('');

        wrap.innerHTML = `
            <div class="mem-card-main">
                <div class="mem-card-content">${this._esc(contentText)}</div>
                <div class="mem-card-meta">
                    ${timeText ? `<span class="mem-card-time"><i class="fas fa-clock"></i>${timeText}</span>` : ''}
                    ${topicsText ? `<span class="mem-card-topics">${this._esc(topicsText)}</span>` : ''}
                </div>
            </div>
            <button class="mem-card-more-btn" title="More options" aria-label="More options">
                <i class="fas fa-ellipsis-v"></i>
            </button>

            <!-- Dropdown -->
            <div class="mem-card-dropdown hidden">
                ${detailRows ? `<div class="mem-dropdown-details">${detailRows}</div>` : ''}
                <div class="mem-dropdown-actions">
                    <button class="mem-action-btn mem-action-edit">
                        <i class="fas fa-pen"></i> Edit
                    </button>
                    <button class="mem-action-btn mem-action-delete">
                        <i class="fas fa-trash-alt"></i> Delete
                    </button>
                </div>
            </div>
        `;

        // Toggle dropdown on ⋮ button
        const moreBtn = wrap.querySelector('.mem-card-more-btn');
        const dropdown = wrap.querySelector('.mem-card-dropdown');
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close other open dropdowns
            document.querySelectorAll('.mem-card-dropdown').forEach(d => {
                if (d !== dropdown) d.classList.add('hidden');
            });
            document.querySelectorAll('.mem-card-more-btn').forEach(b => {
                if (b !== moreBtn) b.classList.remove('active');
            });
            dropdown.classList.toggle('hidden');
            moreBtn.classList.toggle('active');
        });

        // Edit
        wrap.querySelector('.mem-action-edit').addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.add('hidden');
            moreBtn.classList.remove('active');
            this.startEditMemory(row);
        });

        // Delete
        wrap.querySelector('.mem-action-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.add('hidden');
            moreBtn.classList.remove('active');
            this.deleteMemory(row.memory_id);
        });

        return wrap;
    }

    /** Bind memory form submit + cancel events (idempotent via cloneNode trick) */
    _bindMemoryFormEvents() {
        const form = document.getElementById('memory-form');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddMemory();
        });

        const cancelAll = (e) => { e.preventDefault(); this.resetMemoryForm(); };
        document.getElementById('memory-form-cancel')?.addEventListener('click', cancelAll);
        document.getElementById('memory-form-cancel2')?.addEventListener('click', cancelAll);

        document.getElementById('memory-add-btn')?.addEventListener('click', () => {
            this._editingMemoryId = null;
            const formTitle = document.getElementById('memory-form-title');
            const submitLabel = document.getElementById('memory-submit-label');
            if (formTitle) formTitle.textContent = 'Add Memory';
            if (submitLabel) submitLabel.textContent = 'Save Memory';
            this.resetMemoryForm(); // clear fields first
            const fw = document.getElementById('memory-form-wrapper');
            if (fw) fw.classList.remove('hidden');
        });

        // Close open dropdowns when clicking elsewhere
        document.getElementById('memory-panel-content')?.addEventListener('click', () => {
            document.querySelectorAll('.mem-card-dropdown').forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.mem-card-more-btn').forEach(b => b.classList.remove('active'));
        });
    }

    /** Reset the add/edit form and hide it */
    resetMemoryForm() {
        this._editingMemoryId = null;
        document.getElementById('memory-field-memory').value = '';
        document.getElementById('memory-field-input').value = '';
        document.getElementById('memory-field-agent').value = '';
        document.getElementById('memory-field-team').value = '';
        document.getElementById('memory-field-topics').value = '';
        const fw = document.getElementById('memory-form-wrapper');
        if (fw) fw.classList.add('hidden');
    }

    /** Populate the form with an existing memory row for editing */
    startEditMemory(row) {
        this._editingMemoryId = row.memory_id;

        const formTitle = document.getElementById('memory-form-title');
        const submitLabel = document.getElementById('memory-submit-label');
        if (formTitle) formTitle.textContent = 'Edit Memory';
        if (submitLabel) submitLabel.textContent = 'Update Memory';

        // Memory field: if JSON object convert back to pretty-print string
        let memVal = '';
        if (row.memory !== null && typeof row.memory === 'object') {
            try { memVal = JSON.stringify(row.memory, null, 2); } catch (e) { memVal = String(row.memory); }
        } else {
            memVal = row.memory ?? '';
        }

        document.getElementById('memory-field-memory').value = memVal;
        document.getElementById('memory-field-input').value = row.input || '';
        document.getElementById('memory-field-agent').value = row.agent_id || '';
        document.getElementById('memory-field-team').value = row.team_id || '';

        // Topics: serialise array back to comma-separated text for the user
        let topicVal = '';
        if (Array.isArray(row.topics)) topicVal = row.topics.join(', ');
        else if (row.topics !== null && row.topics !== undefined) topicVal = String(row.topics);
        document.getElementById('memory-field-topics').value = topicVal;

        const fw = document.getElementById('memory-form-wrapper');
        if (fw) fw.classList.remove('hidden');

        // Scroll form into view
        fw?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /**
     * Handle form submit – POST when adding, PUT when editing.
     * memory column accepts JSON object or plain string.
     */
    async handleAddMemory() {
        const rawMemory = document.getElementById('memory-field-memory').value.trim();
        const inputText = document.getElementById('memory-field-input').value.trim();
        const agentId = document.getElementById('memory-field-agent').value.trim();
        const teamId = document.getElementById('memory-field-team').value.trim();
        const topicsRaw = document.getElementById('memory-field-topics').value.trim();

        if (!rawMemory) {
            this.showNotification('Memory content is required.', 'error');
            return;
        }

        // Parse memory: try JSON first, else keep as plain string
        let memoryVal;
        try {
            memoryVal = JSON.parse(rawMemory);
        } catch (_) {
            memoryVal = rawMemory;
        }

        // Parse topics: JSON array, or comma-separated strings, or raw value
        let topicsVal = null;
        if (topicsRaw) {
            try {
                topicsVal = JSON.parse(topicsRaw);
            } catch (_) {
                // Comma-sep fallback
                topicsVal = topicsRaw.split(',').map(t => t.trim()).filter(Boolean);
                if (topicsVal.length === 1 && !topicsRaw.includes(',')) topicsVal = topicsRaw;
            }
        }

        const token = await this._getAccessToken();
        if (!token) {
            this.showNotification('You must be logged in to save memories.', 'error');
            return;
        }

        const body = {
            memory: memoryVal,
            input: inputText || undefined,
            agent_id: agentId || undefined,
            team_id: teamId || undefined,
            topics: topicsVal ?? undefined,
        };

        const isEditing = !!this._editingMemoryId;
        const url = isEditing
            ? `${API_BACKEND_URL}/api/memories/${this._editingMemoryId}`
            : `${API_BACKEND_URL}/api/memories`;
        const method = isEditing ? 'PUT' : 'POST';

        // Optimistic UI: disable submit
        const submitBtn = document.getElementById('memory-form-submit');
        if (submitBtn) { submitBtn.disabled = true; }

        try {
            const res = await fetch(url, {
                method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

            this.showNotification(isEditing ? 'Memory updated!' : 'Memory saved!', 'success');
            this.resetMemoryForm();
            await this.loadMemories();
        } catch (err) {
            console.error('[Memory] save failed:', err);
            this.showNotification(`Failed to ${isEditing ? 'update' : 'save'} memory: ${err.message}`, 'error');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; }
        }
    }

    /** DELETE a memory by ID */
    async deleteMemory(memoryId) {
        if (!confirm('Delete this memory?')) return;

        const token = await this._getAccessToken();
        if (!token) return;

        try {
            const res = await fetch(`${API_BACKEND_URL}/api/memories/${memoryId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
            });

            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

            this.showNotification('Memory deleted.', 'success');
            // Remove from cache without full reload for snappiness
            this.memoriesCache = this.memoriesCache.filter(m => m.memory_id !== memoryId);
            this._renderMemoryCards();
        } catch (err) {
            console.error('[Memory] delete failed:', err);
            this.showNotification(`Delete failed: ${err.message}`, 'error');
        }
    }

    // ---- Memory helpers ----

    /** Format the memory column (JSON obj or string) to a human-readable string */
    _formatMemoryContent(mem) {
        if (mem === null || mem === undefined) return '—';
        if (typeof mem === 'string') return mem;
        if (typeof mem === 'object') {
            // Try to extract a meaningful text field
            const val = mem.memory || mem.text || mem.content || mem.value;
            if (typeof val === 'string') return val;
            try { return JSON.stringify(mem); } catch (_) { return String(mem); }
        }
        return String(mem);
    }

    /** Format topics to a short readable string */
    _formatTopics(topics) {
        if (!topics) return '';
        if (Array.isArray(topics)) return topics.join(', ');
        if (typeof topics === 'string') return topics;
        try { return JSON.stringify(topics); } catch (_) { return ''; }
    }

    /** Escape HTML entities */
    _esc(str) {
        const d = document.createElement('div');
        d.textContent = str ?? '';
        return d.innerHTML;
    }

    /** Human-relative time (e.g. "2 hours ago") */
    _timeAgo(ms) {
        const diff = Date.now() - ms;
        const sec = Math.floor(diff / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const day = Math.floor(hr / 24);
        if (day < 30) return `${day}d ago`;
        const mo = Math.floor(day / 30);
        if (mo < 12) return `${mo}mo ago`;
        return `${Math.floor(mo / 12)}y ago`;
    }
}
