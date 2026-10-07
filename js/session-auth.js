import { supabase } from './supabase-client.js';

let refreshing = null;

// The SDK maintains the persisted session. Refresh only near expiry, sharing
// that request across callers instead of adding a network round trip per action.
export async function getAuthenticatedSession() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const session = data?.session;
    if (!session?.access_token) throw new Error('Sign in to continue.');
    if (!Number.isFinite(session.expires_at) || session.expires_at * 1000 > Date.now() + 60000) return session;
    if (!refreshing) {
        refreshing = supabase.auth.refreshSession().then(result => {
            if (result.error) throw result.error;
            if (!result.data?.session?.access_token) throw new Error('Your session expired. Sign in again.');
            return result.data.session;
        }).finally(() => { refreshing = null; });
    }
    return refreshing;
}
