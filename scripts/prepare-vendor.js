const fs = require('node:fs');
const path = require('node:path');
const { prepareRuntimeConfig } = require('./prepare-runtime-config.js');

prepareRuntimeConfig();

const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'assets', 'vendor');
const bundles = [
    ['@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js'],
    ['socket.io-client/dist/socket.io.min.js', 'socket.io.min.js'],
];

fs.mkdirSync(destination, { recursive: true });
for (const [source, filename] of bundles) {
    const sourcePath = path.join(root, 'node_modules', source);
    if (!fs.existsSync(sourcePath)) throw new Error(`Missing ${source}. Run npm ci first.`);
    fs.copyFileSync(sourcePath, path.join(destination, filename));
}
console.log('Prepared the installed Supabase and Socket.IO browser SDKs.');
