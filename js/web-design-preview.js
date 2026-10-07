// Previews run in an opaque sandbox. Only selection text is accepted from the frame.
export function openDesignPreview({ content, path, send }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'web-design-dialog';
    dialog.setAttribute('aria-label', `Design preview of ${path}`);
    dialog.innerHTML = `
        <div class="web-design-header"><h2>Design preview</h2><button type="button" data-close>Close</button></div>
        <div class="web-design-tools"><label>Preview width <select><option value="100%">Laptop</option><option value="390px">Phone</option><option value="768px">Tablet</option></select></label><span role="status">Select an element to describe a change.</span></div>
        <div class="web-design-stage"><iframe title="Sandboxed project preview" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div>
        <form><label>Describe your changes<textarea rows="2" required maxlength="8000" placeholder="Make this heading smaller and increase the spacing."></textarea></label><button type="submit">Ask coder to edit</button></form>`;
    const frame = dialog.querySelector('iframe');
    // Disable project scripts and inline event handlers. The inspector is the only script.
    const parsed = new DOMParser().parseFromString(content, 'text/html');
    parsed.querySelectorAll('script, base, iframe, object, embed, meta[http-equiv]').forEach(node => node.remove());
    parsed.querySelectorAll('*').forEach(node => {
        for (const attribute of Array.from(node.attributes)) {
            if (attribute.name.startsWith('on')) node.removeAttribute(attribute.name);
        }
    });
    const csp = parsed.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'nonce-aetheria-inspector'; form-action 'none';";
    parsed.head.prepend(csp);
    const inspector = parsed.createElement('script');
    inspector.setAttribute('nonce', 'aetheria-inspector');
    inspector.textContent = `document.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        const element = event.target;
        const selector = element.id ? '#' + CSS.escape(element.id) : element.tagName.toLowerCase()
            + Array.from(element.classList).slice(0, 3).map(name => '.' + CSS.escape(name)).join('');
        parent.postMessage({ type: 'aetheria-design-selection', selector, text: element.textContent.slice(0, 400) }, '*');
    }, true);`;
    parsed.body.appendChild(inspector);
    frame.srcdoc = '<!doctype html>' + parsed.documentElement.outerHTML;
    let selection = '';
    const status = dialog.querySelector('[role="status"]');
    const receive = event => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'aetheria-design-selection') return;
        if (typeof event.data.selector !== 'string' || typeof event.data.text !== 'string') return;
        selection = `${event.data.selector.slice(0, 500)}: ${event.data.text.slice(0, 400)}`;
        status.textContent = `Selected ${selection}`;
    };
    window.addEventListener('message', receive);
    dialog.querySelector('select').addEventListener('change', event => { frame.style.width = event.target.value; });
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { window.removeEventListener('message', receive); dialog.remove(); });
    dialog.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        button.disabled = true;
        try {
            await send(`Edit the cloud workspace file ${path}.\n${selection ? `Selected element: ${selection}\n` : ''}Requested design changes: ${dialog.querySelector('textarea').value.trim()}`);
            dialog.close();
        } catch (error) { status.textContent = error.message; button.disabled = false; }
    });
    document.body.appendChild(dialog);
    dialog.showModal();
}
