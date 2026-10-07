const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const distDir = path.join(__dirname, '../dist');
const rootDir = path.join(__dirname, '..');

// Clean and recreate dist to avoid stale assets between builds.
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Files and directories to copy
const itemsToCopy = [
    'index.html',
    'manifest.json',
    'sw.js',
    'assets',
    'css',
    'js',
    'aios.html',
    'chat.html',
    'to-do-list.html',
    'test-colors.html',
    'icon.ico',
    '.well-known'
];

function copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();

    if (isDirectory) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest);
        }
        fs.readdirSync(src).forEach(childItemName => {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        if (exists) {
            fs.copyFileSync(src, dest);
        }
    }
}

itemsToCopy.forEach(item => {
    const srcPath = path.join(rootDir, item);
    const destPath = path.join(distDir, item);
    console.log(`Copying ${item}...`);
    copyRecursiveSync(srcPath, destPath);
});

// Preserve the stylesheet order, but deliver workspace CSS in one request.
const indexPath = path.join(distDir, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');
const deferredStyle = /<link\b[^>]*data-workspace-href="(css\/[^\"]+)"[^>]*>/g;
const styleTags = Array.from(indexHtml.matchAll(deferredStyle));
if (styleTags.length) {
    const workspaceCss = styleTags.map(match => {
        const filename = match[1].split('?')[0];
        return `/* ${filename} */\n${fs.readFileSync(path.join(distDir, filename), 'utf8')}`;
    }).join('\n');
    fs.writeFileSync(path.join(distDir, 'css/workspace.bundle.css'), workspaceCss);
    let position = 0;
    indexHtml = indexHtml.replace(deferredStyle, () => {
        position += 1;
        return position === styleTags.length ? '<link rel="stylesheet" data-workspace-href="css/workspace.bundle.css" />' : '';
    });
    fs.writeFileSync(indexPath, indexHtml);
}

// Invalidate installed PWA caches for any changed frontend file, including the
// Supabase client itself. Runtime settings alone do not describe the deployed app.
const sourceHash = crypto.createHash('sha256');
function hashFrontend(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
        const filename = path.join(directory, name);
        if (fs.statSync(filename).isDirectory()) hashFrontend(filename);
        else if (/\.(js|css|html)$/.test(name)) {
            sourceHash.update(path.relative(distDir, filename).replace(/\\/g, '/'));
            sourceHash.update(fs.readFileSync(filename));
        }
    }
}
hashFrontend(distDir);
const publicConfigHash = sourceHash.digest('hex').slice(0, 16);
const serviceWorkerPath = path.join(distDir, 'sw.js');
const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, 'utf8');
if (!/^const CACHE_VERSION = '[^']+';/m.test(serviceWorkerSource)) {
    throw new Error('Service worker cache version declaration is missing.');
}
fs.writeFileSync(serviceWorkerPath,
    serviceWorkerSource.replace(/^const CACHE_VERSION = '[^']+';/m,
        `const CACHE_VERSION = 'aetheria-frontend-${publicConfigHash}';`));

// Copy icon.ico as favicon.ico to handle browser fallback requests
const iconIcoSrc = path.join(rootDir, 'icon.ico');
const faviconIcoDest = path.join(distDir, 'favicon.ico');
if (fs.existsSync(iconIcoSrc)) {
    console.log('Copying icon.ico as favicon.ico...');
    fs.copyFileSync(iconIcoSrc, faviconIcoDest);
}

console.log('Build complete!');
