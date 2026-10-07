(() => {
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'web-test@example.test', user_metadata: { name: 'Web test' } };
    let session = window.__signedOut ? null : { access_token: 'fixture-token', user };
    const authListeners = [];
    window.__testTasks = [];
    window.__testMutations = [];
    function query(table) {
        const result = { data: table === 'profiles' ? { id: user.id, full_name: 'Web test' } : table === 'tasks' ? window.__testTasks : [], error: null, count: 0 };
        const builder = new Proxy({}, { get(_target, key) {
            if (key === 'then') return resolve => Promise.resolve(result).then(resolve);
            if (key === 'insert') return rows => {
                window.__testMutations.push({ table, rows });
                if (table === 'tasks') window.__testTasks.push(...rows);
                return builder;
            };
            return () => builder;
        } });
        return builder;
    }
    window.supabase = { createClient: () => ({
        auth: {
            getSession: async () => ({ data: { session }, error: null }),
            refreshSession: async () => ({ data: { session }, error: null }),
            getUser: async () => ({ data: { user: session?.user || null }, error: null }),
            onAuthStateChange: callback => { authListeners.push(callback); return { data: { subscription: { unsubscribe() {} } } }; },
            signOut: async () => { session = null; authListeners.forEach(callback => callback('SIGNED_OUT', null)); return { error: null }; },
        },
        from: query,
        channel: () => { const channel = { on: () => channel, subscribe: () => channel, unsubscribe() {} }; return channel; },
        removeChannel() {},
    }) };
    const handlers = new Map();
    window.__testSocket = {
        connected: true,
        emitted: [],
        on(name, callback) { handlers.set(name, [...(handlers.get(name) || []), callback]); },
        emit(name, payload) { this.emitted.push({ name, payload }); },
        serverEmit(name, payload) { for (const callback of handlers.get(name) || []) callback(payload); },
        disconnect() { this.connected = false; this.serverEmit('disconnect'); },
        auth: {},
    };
    window.io = () => { setTimeout(() => window.__testSocket.serverEmit('connect'), 20); return window.__testSocket; };
})();
