const TOOLS = [
    ['internet_search', 'Web search'], ['coding_assistant', 'Cloud coding'],
    ['enable_browser', 'Cloud browser'],
    ['enable_github', 'GitHub'], ['enable_google_email', 'Gmail'],
    ['enable_google_drive', 'Google Drive'], ['enable_google_sheets', 'Google Sheets'],
    ['enable_supabase', 'Supabase'], ['enable_vercel', 'Vercel'],
    ['enable_composio_whatsapp', 'WhatsApp'], ['enable_composio_facebook', 'Facebook'],
    ['enable_composio_instagram', 'Instagram'], ['enable_composio_youtube', 'YouTube'],
];

export function openToolSettings(chat) {
    if (document.querySelector('.web-tool-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'web-tool-dialog';
    dialog.setAttribute('aria-label', 'Agent tools');
    const heading = document.createElement('h2');
    heading.textContent = 'Agent tools';
    const description = document.createElement('p');
    description.textContent = 'Choose which tools the agent can use. Connect your accounts in Settings.';
    const controls = document.createElement('div');
    controls.className = 'web-tool-options';
    for (const [key, name] of TOOLS) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = chat.getConfig().tools[key] !== false;
        input.addEventListener('change', () => chat.setToolEnabled(key, input.checked));
        label.append(input, document.createTextNode(name));
        controls.appendChild(label);
    }
    const memory = document.createElement('label');
    const memoryToggle = document.createElement('input');
    memoryToggle.type = 'checkbox';
    memoryToggle.checked = chat.getConfig().memory;
    memoryToggle.addEventListener('change', () => chat.setMemoryEnabled(memoryToggle.checked));
    memory.append(memoryToggle, document.createTextNode('Use saved memory'));
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Done';
    close.addEventListener('click', () => dialog.close());
    dialog.append(heading, description, memory, controls, close);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
}
