// js/supabase-client.js

import { config } from './config.js';

function authFetch(resource, options = {}) {
  const requestUrl = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
  if (!requestUrl.startsWith(`${config.supabase.url}/auth/`)) return fetch(resource, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Authentication timed out. Please retry.', 'TimeoutError')), 15000);
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  return fetch(resource, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  });
}

export const supabase = window.supabase.createClient(config.supabase.url, config.supabase.anonKey, {
  global: { fetch: authFetch },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: window.localStorage,
    flowType: 'pkce',
    detectSessionInUrl: true,
  },
});
