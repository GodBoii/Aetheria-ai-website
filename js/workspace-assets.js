const scripts = new Map();
const libraries = {
    marked: ['https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', () => window.marked],
    purifier: ['https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.3.0/purify.min.js', () => window.DOMPurify],
    highlight: ['https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js', () => window.hljs],
    socket: ['/assets/vendor/socket.io.min.js', () => window.io],
    mermaid: ['https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js', () => window.mermaid],
    checkout: ['https://checkout.razorpay.com/v1/checkout.js', () => window.Razorpay],
};

export function loadLibrary(name) {
    const library = libraries[name];
    if (!library) throw new Error('Unknown workspace library.');
    if (library[1]()) return Promise.resolve();
    if (scripts.has(name)) return scripts.get(name);
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = library[0];
        script.async = true;
        const timer = setTimeout(() => failed(), 20000);
        const failed = () => {
            clearTimeout(timer);
            script.remove();
            scripts.delete(name);
            reject(new Error(`Could not load ${name}. Check your connection and retry.`));
        };
        script.onload = () => { clearTimeout(timer); if (library[1]()) resolve(); else failed(); };
        script.onerror = failed;
        document.head.appendChild(script);
    });
    scripts.set(name, promise);
    return promise;
}

export async function loadWorkspaceAssets() {
    const styles = Array.from(document.querySelectorAll('link[data-workspace-href]')).map(link => new Promise((resolve, reject) => {
        if (link.sheet) return resolve();
        const timer = setTimeout(() => failed(), 20000);
        const failed = () => { clearTimeout(timer); reject(new Error('Could not load workspace styles. Check your connection and retry.')); };
        link.onload = () => { clearTimeout(timer); resolve(); };
        link.onerror = failed;
        link.href = link.dataset.workspaceHref;
    }));
    await Promise.all([...styles, ...['marked', 'purifier', 'highlight', 'socket'].map(loadLibrary)]);
}
