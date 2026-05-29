const fs = require('fs');
const path = require('path');

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

// Copy icon.ico as favicon.ico to handle browser fallback requests
const iconIcoSrc = path.join(rootDir, 'icon.ico');
const faviconIcoDest = path.join(distDir, 'favicon.ico');
if (fs.existsSync(iconIcoSrc)) {
    console.log('Copying icon.ico as favicon.ico...');
    fs.copyFileSync(iconIcoSrc, faviconIcoDest);
}

console.log('Build complete!');
