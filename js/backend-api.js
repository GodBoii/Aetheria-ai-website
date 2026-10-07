import { supabase } from './supabase-client.js';
import { config } from './config.js';

export async function backendRequest(path, { method = 'GET', body, signal, binary = false } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error('Expected a backend API path.');
    }
    const { data, error } = await supabase.auth.getSession();
    if (error || !data?.session?.access_token) {
        throw new Error('Sign in to load your account data.');
    }
    const multipart = body instanceof FormData;
    const response = await fetch(`${config.backend.url}/api${path}`, {
        method,
        signal,
        cache: 'no-store',
        headers: {
            Authorization: `Bearer ${data.session.access_token}`,
            ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
    if (binary && response.ok) return response.blob();
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error(`The server returned an unreadable response. HTTP ${response.status}.`);
    }
    if (!response.ok || result?.ok === false) {
        throw new Error(result?.error || result?.message || `Request failed. HTTP ${response.status}.`);
    }
    return result;
}

export async function uploadReadUrl(item, sessionId) {
    if (item.signed_url) return item.signed_url;
    const conversation = item.session_id || sessionId;
    if (!conversation) throw new Error('The file has no conversation reference.');
    const { content } = await backendRequest(`/sessions/${encodeURIComponent(conversation)}/content`);
    const match = Array.isArray(content) ? content.find(row => row.reference_id === item.reference_id) : null;
    if (!match?.signed_url) throw new Error('The file is no longer available.');
    return match.signed_url;
}
