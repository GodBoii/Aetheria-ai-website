import { supabase } from './supabase-client.js';

class AuthService {
    constructor() {
        this.supabase = supabase;
        this.user = null;
        this.listeners = [];
        this._authListenerBound = false;
        this.initPromise = null;
        this.lastError = null;
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.initializeSession();
        return this.initPromise;
    }

    async initializeSession() {
        this.lastError = null;
        try {
            // Check for existing session
            const { data, error } = await this.supabase.auth.getSession();
            if (error) throw error;
            if (data.session) {
                this.user = data.session.user;

                this._notifyListeners();
            }

            // Set up auth state change listener
            if (!this._authListenerBound) {
                this.supabase.auth.onAuthStateChange((event, session) => {

                    this.user = session?.user || null;
                    if (this.user) this.lastError = null;
                    this._notifyListeners();
                });
                this._authListenerBound = true;
            }

            return true;
        } catch (error) {
            this.lastError = error;
            this.initPromise = null;
            console.error('Failed to initialize auth service:', error);
            return false;
        }
    }

    async signInWithGoogle() {
        const { error } = await this.supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: `${window.location.origin}/`, queryParams: { prompt: 'select_account' } },
        });
        if (error) throw error;
    }

    // Add listener for auth state changes
    onAuthChange(callback) {
        this.listeners.push(callback);
        // Immediately notify with current state
        if (callback && typeof callback === 'function') {
            callback(this.user);
        }
        return () => {
            this.listeners = this.listeners.filter(listener => listener !== callback);
        };
    }

    // Notify all listeners of auth state change
    _notifyListeners() {
        this.listeners.forEach(listener => {
            if (listener && typeof listener === 'function') {
                listener(this.user);
            }
        });
    }

    normalizePhoneNumber(phoneNumber) {
        return typeof phoneNumber === 'string'
            ? phoneNumber.replace(/[\s.\-()]/g, '')
            : '';
    }

    isValidPhoneNumber(phoneNumber) {
        return /^\+[1-9]\d{7,14}$/.test(phoneNumber);
    }

    // Sign up with email, password, name, and phone number
    async signUp(email, password, name, phoneNumber) {

        const processedName = typeof name === 'string' ? name.trim() : '';

        const normalizedPhoneNumber = this.normalizePhoneNumber(phoneNumber);

        if (!processedName || !email || !normalizedPhoneNumber || !password) {
            return { success: false, error: 'Name, email, mobile number, and password are required.' };
        }

        if (!this.isValidPhoneNumber(normalizedPhoneNumber)) {
            return { success: false, error: 'Enter a valid mobile number with country code, for example +919876543210.' };
        }

        try {
            const { data, error } = await this.supabase.auth.signUp({
                email: email,
                password: password,
                options: {
                    data: {
                        name: processedName,
                        phone_number: normalizedPhoneNumber
                    }
                }
            });

            if (error) {
                console.error('Signup error:', error);
                return { success: false, error: error.message };
            }

            // The database's auth.users trigger creates the profile from signup metadata.
            return { success: true, data };
        } catch (error) {
            console.error('Signup error:', error);
            return { success: false, error: error.message };
        }
    }

    // Sign in with email and password
    async signIn(email, password) {
        try {
            const { data, error } = await this.supabase.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error) throw error;

            this.user = data.user || null;
            this._notifyListeners();

            return { success: true, data };
        } catch (error) {
            console.error('Sign in error:', error);
            return { success: false, error: error.message };
        }
    }

    // Sign out
    async signOut() {
        try {
            const { error } = await this.supabase.auth.signOut();
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error('Sign out error:', error);
            return { success: false, error: error.message };
        }
    }

    // Get current user
    getCurrentUser() {
        return this.user;
    }

    // Check if user is authenticated
    isAuthenticated() {
        return !!this.user;
    }

    // --- ADDED THIS METHOD ---
    // Get the full session object, including the access token
    async getSession() {
        try {
            const { data, error } = await this.supabase.auth.getSession();
            if (error) {
                console.error('Error getting session:', error.message);
                return null;
            }
            return data.session;
        } catch (error) {
            console.error('Failed to get session:', error.message);
            return null;
        }
    }

    async fetchUsageData() {
        try {
            const { data: sessionData, error: sessionError } = await this.supabase.auth.getSession();
            if (sessionError) {
                throw sessionError;
            }

            const userId = sessionData?.session?.user?.id;
            if (!userId) {
                return {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    created_at: null
                };
            }

            const { data, error } = await this.supabase
                .from('request_logs')
                .select('input_tokens, output_tokens, total_tokens, created_at')
                .eq('user_id', userId);

            if (error) {
                throw error;
            }

            if (!Array.isArray(data) || data.length === 0) {
                return {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    created_at: null
                };
            }

            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;
            let latestCreatedAt = null;
            let latestTs = 0;

            data.forEach((row) => {
                const input = Number(row.input_tokens) || 0;
                const output = Number(row.output_tokens) || 0;
                const total = Number(row.total_tokens);

                inputTokens += input;
                outputTokens += output;
                totalTokens += Number.isFinite(total) ? total : input + output;

                const createdTs = row.created_at ? Date.parse(row.created_at) : NaN;
                if (Number.isFinite(createdTs) && createdTs > latestTs) {
                    latestTs = createdTs;
                    latestCreatedAt = row.created_at;
                }
            });

            return {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: totalTokens,
                created_at: latestCreatedAt
            };
        } catch (error) {
            console.error('Failed to fetch usage data:', error);
            return {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                created_at: null,
                error: error.message
            };
        }
    }
}

// Create singleton instance
export const authService = new AuthService();
