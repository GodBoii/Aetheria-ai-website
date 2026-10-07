import { config } from './config.js';
import { getAuthenticatedSession } from './session-auth.js';

export async function backendRequest(path, { method = 'GET', body, signal, binary = false, timeoutMs = 20000 } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error('Expected a backend API path.');
    }
    const session = await getAuthenticatedSession();
    const multipart = body instanceof FormData;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('The server took too long to respond. Please retry.', 'TimeoutError')),
        multipart || binary ? 120000 : timeoutMs);
    try {
        const response = await fetch(`${config.backend.url}/api${path}`, {
            method,
            signal: controller.signal,
            cache: 'no-store',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
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
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
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
