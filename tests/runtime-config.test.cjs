const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePublicSettings } = require('../scripts/prepare-runtime-config.js');

const input = { url: 'https://test-project.supabase.co', key: 'sb_publishable_test', backendUrl: 'https://api.example.test/' };
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

test('runtime settings emit only public client fields', () => {
    assert.deepEqual(validatePublicSettings({ ...input, SUPABASE_SERVICE_KEY: 'private-server-key', DATABASE_URL: 'private-db' }), {
        supabaseSettings: { url: input.url, anonKey: input.key }, backendUrl: 'https://api.example.test',
    });
});
test('service keys and mismatched legacy keys are rejected', () => {
    assert.throws(() => validatePublicSettings({ ...input, key: 'sb_secret_private' }));
    assert.throws(() => validatePublicSettings({ ...input, key: jwt({ role: 'service_role', ref: 'test-project' }) }));
    assert.throws(() => validatePublicSettings({ ...input, key: jwt({ role: 'anon', ref: 'other-project' }) }));
    assert.equal(validatePublicSettings({ ...input, key: jwt({ role: 'anon', ref: 'test-project' }) }).supabaseSettings.url, input.url);
});
test('URLs containing credentials or insecure protocols are rejected', () => {
    assert.throws(() => validatePublicSettings({ ...input, url: 'https://secret@test-project.supabase.co' }));
    assert.throws(() => validatePublicSettings({ ...input, backendUrl: 'http://api.example.test' }));
    assert.throws(() => validatePublicSettings({ ...input, backendUrl: 'https://api.example.test?key=private' }));
});
