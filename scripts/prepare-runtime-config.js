const fs = require('node:fs');
const path = require('node:path');

function validatePublicSettings({ url, key, backendUrl }) {
    const supabaseUrl = new URL(url);
    if (supabaseUrl.protocol !== 'https:' || !supabaseUrl.hostname.endsWith('.supabase.co')
        || supabaseUrl.username || supabaseUrl.password || supabaseUrl.search || supabaseUrl.hash) {
        throw new Error('SUPABASE_URL must be an HTTPS Supabase project URL.');
    }
    if (!key.startsWith('sb_publishable_')) {
        let payload;
        try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')); }
        catch { throw new Error('Use a Supabase publishable key or legacy anon key for the website.'); }
        if (payload.role !== 'anon' || payload.ref !== supabaseUrl.hostname.split('.')[0]) {
            throw new Error('The website key must be an anon key for this Supabase project. Server keys cannot be published.');
        }
    }
    const backend = new URL(backendUrl);
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.search || backend.hash) {
        throw new Error('BACKEND_PUBLIC_URL must be an HTTPS URL without credentials.');
    }
    return { supabaseSettings: { url: supabaseUrl.origin, anonKey: key }, backendUrl: backend.href.replace(/\/$/, '') };
}

function prepareRuntimeConfig(env = process.env) {
    const filename = path.resolve(__dirname, '../js/runtime-config.js');
    const existing = fs.readFileSync(filename, 'utf8');
    const match = existing.match(/export const supabaseSettings = (\{[^\n]*\});/);
    if (!match) throw new Error('Public runtime settings are missing.');
    const defaults = JSON.parse(match[1]);
    const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
    if (env.VERCEL && (!env.SUPABASE_URL || !key || !env.BACKEND_PUBLIC_URL)) {
        throw new Error('Configure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and BACKEND_PUBLIC_URL in Vercel before deploying.');
    }
    const settings = validatePublicSettings({
        url: env.SUPABASE_URL || defaults.url,
        key: key || defaults.anonKey,
        backendUrl: env.BACKEND_PUBLIC_URL || 'https://api.aetheriaai.website',
    });
    // Only these public values are emitted. No database or service credentials are read.
    fs.writeFileSync(filename,
        `export const supabaseSettings = ${JSON.stringify(settings.supabaseSettings)};\n`
        + `export const backendUrl = ${JSON.stringify(settings.backendUrl)};\n`, 'utf8');
    console.log('Prepared public Supabase and backend settings.');
}

module.exports = { prepareRuntimeConfig, validatePublicSettings };
if (require.main === module) prepareRuntimeConfig();
