const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const origin = process.env.TEST_BASE_URL || 'http://127.0.0.1:3011';
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/browser-services.js'), 'utf8');
let browser;
let server;
const screenshots = path.join(os.tmpdir(), 'aetheria-web-parity');

before(async () => {
    fs.mkdirSync(screenshots, { recursive: true });
    if (!process.env.TEST_BASE_URL) {
        server = spawn(process.execPath, [require.resolve('http-server/bin/http-server'), '.', '-p', '3011', '-c-1', '-a', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
        for (let attempt = 0; attempt < 40; attempt += 1) {
            try { if ((await fetch(origin)).ok) break; } catch {}
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true });
});
after(async () => { await browser?.close(); server?.kill(); });

async function openApp(viewport, { signedOut = false } = {}) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    const requests = [];
    let files = [{ id: 'file-1', file_name: 'project-notes.txt', mime_type: 'text/plain', size_bytes: 20 }];
    page.on('pageerror', error => {
        // Playwright's service-worker blocker reads this property in opaque preview frames.
        if (error.message === "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.") return;
        errors.push(error.message);
    });
    await page.addInitScript(({ signedOut }) => { window.__signedOut = signedOut; }, { signedOut });
    await page.route('**/assets/vendor/supabase.js', route => route.fulfill({ contentType: 'application/javascript', body: fixture }));
    await page.route('**/assets/vendor/socket.io.min.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('https://checkout.razorpay.com/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('**/sw.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('https://api.aetheriaai.website/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push({ path: url.pathname, method: request.method(), authorization: request.headers().authorization, body: request.postData() });
        let body = { ok: true };
        if (url.pathname === '/api/subscription/status') body = { ok: true, summary: { plan_name: 'Core', status_label: 'Free', limit_label: '50000 tokens/day', usage: {}, lifetime_usage: {}, remaining_tokens: 50000, is_enforceable: true } };
        if (url.pathname === '/api/sessions') body = [{ session_id: 'saved-chat', session_title: 'Saved conversation', created_at: 1780000000, agent_id: 'aetheria-ai', session_type: 'agent' }];
        if (url.pathname.endsWith('/history')) body = { runs: [{ run_id: 'run-1', input: { input_content: 'Saved question' }, content: 'Saved answer' }], session_data: {}, input_requests: [] };
        if (url.pathname.endsWith('/content')) body = url.pathname.includes('/user-files/') ? { ok: true, file: { content: '<script>bad()</script> project notes' } } : { content: [] };
        if (url.pathname === '/api/integrations') body = { integrations: ['google'] };
        if (url.pathname === '/api/composio/status') body = { connected: true };
        if (url.pathname === '/api/memories') body = { memories: [] };
        if (url.pathname === '/api/usage/daily') body = { ok: true, rows: [{ day_key: new Date().toISOString().slice(0, 10), input_tokens: 100, output_tokens: 50, total_tokens: 150 }] };
        if (url.pathname === '/api/user-files') body = { ok: true, files, storage: { used_bytes: 20, quota_bytes: 524288000 } };
        if (url.pathname === '/api/user-files/upload') { files.push({ id: 'file-2', file_name: 'upload-test.txt', mime_type: 'text/plain', size_bytes: 4 }); body = { ok: true, file: files.at(-1) }; }
        if (url.pathname === '/api/user-files/file-2' && request.method() === 'DELETE') files = files.filter(file => file.id !== 'file-2');
        if (url.pathname.endsWith('/download')) return route.fulfill({ contentType: 'text/plain', body: 'file data' });
        if (url.pathname === '/api/deploy/projects') body = { projects: [] };
        if (url.pathname === '/api/project/workspace/tree') body = { ok: true, files: [{ path: '/home/sandboxuser/workspace/index.html', name: 'index.html', size: 100, type: 'file' }] };
        if (url.pathname === '/api/project/workspace/file-content') body = { ok: true, content: '<h1 id="title">Project preview</h1><script>parent.__unsafe=true</script>', is_binary: false };
        if (url.pathname === '/api/project/workspace/deployment-status') body = { ok: true, modified: true, summary: { new_files: ['index.html'], changed_files: [], deleted_files: [] } };
        if (url.pathname === '/api/project/workspace/redeploy') body = { ok: true };
        if (url.pathname === '/api/mic/transcribe') body = { ok: true, text: 'Voice test transcript' };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin);
    if (!signedOut) {
        try { await page.waitForFunction(() => window.projectWorkspace && window.chat && window.contextHandler); }
        catch (error) { throw new Error(`App did not initialize. ${errors.join('; ')}. ${error.message}`); }
    }
    return { context, page, errors, requests };
}

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    test(`app renders and composer works at ${viewport.width}px`, async () => {
        const { context, page, errors } = await openApp(viewport);
        try {
            await page.locator('#attach-file-btn').focus();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('End');
            assert.equal(await page.locator('#ultra-think-btn').evaluate(element => element === document.activeElement), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#attach-file-btn').getAttribute('aria-expanded'), 'false');
            await page.screenshot({ path: path.join(screenshots, `home-${viewport.width}.png`) });
            await page.locator('#floating-input').fill('Explain the project');
            await page.locator('#attach-file-btn').click();
            await page.locator('#ultra-think-btn').click();
            assert.equal(await page.locator('#ultra-think-btn').getAttribute('aria-pressed'), 'true');
            await page.locator('#send-message').click();
            await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
            const sent = await page.evaluate(() => JSON.parse(window.__testSocket.emitted.find(event => event.name === 'send_message').payload));
            assert.equal(sent.deviceType, 'web');
            assert.equal(sent.thinking_mode, 'ultra');
            assert.equal(sent.accessToken, 'fixture-token');
            assert.equal(sent.supports_user_questions, true);
            const buttonColors = await page.locator('#send-message').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, classes: element.className }));
            assert.notEqual(buttonColors.background, buttonColors.color, JSON.stringify(buttonColors));
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
            assert.equal(overflow, false);
            await page.screenshot({ path: path.join(screenshots, `chat-${viewport.width}.png`) });
            assert.deepEqual(errors, []);
        } finally { await context.close(); }
    });
}

test('vault uploads, filters, previews safely and deletes through the backend', async () => {
    const { context, page, errors, requests } = await openApp({ width: 390, height: 844 });
    try {
        await page.evaluate(() => window.aios.openPanel('files'));
        await page.locator('.web-vault-card').waitFor();
        await page.locator('#files-search-input').fill('missing');
        assert.equal(await page.locator('.web-vault-card').count(), 0);
        await page.locator('#files-search-input').fill('');
        await page.getByRole('button', { name: 'Preview project-notes.txt', exact: true }).click();
        await page.locator('#files-inline-preview pre').waitFor();
        assert.match(await page.locator('#files-inline-preview pre').textContent(), /<script>/);
        assert.equal(await page.locator('#files-inline-preview script').count(), 0);
        await page.locator('#settings-files-input').setInputFiles({ name: 'upload-test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
        await page.getByRole('button', { name: 'Delete upload-test.txt', exact: true }).waitFor();
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Delete upload-test.txt', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('.web-vault-card').length === 1);
        assert.ok(requests.some(request => request.path === '/api/user-files/upload' && request.method === 'POST' && request.body.includes('upload-test.txt')));
        assert.ok(requests.filter(request => request.path.startsWith('/api/user-files')).every(request => request.authorization === 'Bearer fixture-token'));
        await page.screenshot({ path: path.join(screenshots, 'vault-mobile.png') });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('agent questions submit authenticated answers and resume', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.evaluate(() => window.__testSocket.serverEmit('user_question', { requestId: 'question-1', id: 'message-1', conversationId: window.chat.getCurrentConversationId(), status: 'pending', expiresAt: Date.now() / 1000 + 600, questions: [{ id: 'choice', question: 'Choose a format', kind: 'choice', options: [{ label: 'Report', description: 'Write a report' }] }] }));
        await page.getByLabel('Report', { exact: false }).check();
        await page.getByRole('button', { name: 'Submit answers' }).click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'submit_user_answers'));
        const sent = await page.evaluate(() => window.__testSocket.emitted.find(event => event.name === 'submit_user_answers').payload);
        assert.equal(sent.accessToken, 'fixture-token');
        assert.deepEqual(sent.answers.choice.selected, ['Report']);
        await page.evaluate(() => window.__testSocket.serverEmit('user_question_ack', { requestId: 'question-1', conversationId: window.chat.getCurrentConversationId(), id: 'message-1', status: 'resuming', success: true }));
        await page.getByText('Answers submitted. Continuing', { exact: false }).waitFor();
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('usage history renders real rows with continuous UTC days', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.evaluate(() => window.aios.openPanel('usage'));
        await page.waitForFunction(() => document.querySelectorAll('.web-usage-bar').length === 7);
        assert.match(await page.locator('.web-usage-summary').textContent(), /150 tokens/);
        await page.getByLabel('Usage history period').selectOption('30');
        await page.waitForFunction(() => document.querySelectorAll('.web-usage-bar').length === 30);
        const result = await page.evaluate(async () => {
            const { dailyUsageSeries } = await import('/js/usage-history.js');
            return dailyUsageSeries([{ day_key: '2026-10-07', input_tokens: 2, output_tokens: 3 }, { day_key: '2026-10-07', total_tokens: 7 }], 2, new Date('2026-10-07T12:00:00Z'));
        });
        assert.equal(result[0].total, 0);
        assert.equal(result[1].total, 12);
        await page.screenshot({ path: path.join(screenshots, 'usage-desktop.png') });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('signed-out users see the authentication screen', async () => {
    const { context, page, errors } = await openApp({ width: 390, height: 844 }, { signedOut: true });
    try {
        await page.locator('#auth-gate-root').waitFor();
        await page.screenshot({ path: path.join(screenshots, 'login-mobile.png') });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('plan mode supports review, editing and approved execution', async () => {
    const { context, page, errors } = await openApp({ width: 390, height: 844 });
    try {
        await page.locator('#floating-input').fill('Build a portfolio');
        await page.locator('#plan-mode-btn').click();
        await page.locator('#send-message').click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'plan_request'));
        const request = await page.evaluate(() => JSON.parse(window.__testSocket.emitted.find(event => event.name === 'plan_request').payload));
        assert.equal(request.deviceType, 'web');
        assert.equal(request.supports_user_questions, true);
        await page.evaluate(request => window.__testSocket.serverEmit('plan_response', { requestId: request.requestId, messageId: request.messageId, success: true, done: true, plan: '## Plan\nBuild the homepage.' }), request);
        await page.locator('.plan-output-edit').click();
        await page.locator('.plan-output-editor').fill('Build an accessible portfolio with a contact form.');
        await page.screenshot({ path: path.join(screenshots, 'plan-mobile.png') });
        await page.locator('.plan-output-submit').click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
        const approved = await page.evaluate(() => JSON.parse(window.__testSocket.emitted.find(event => event.name === 'send_message').payload));
        assert.match(approved.message, /accessible portfolio with a contact form/);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('tool choices reach the agent and Ultra Think rejects video attachments', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.locator('#attach-file-btn').click();
        await page.getByRole('menuitem', { name: 'Memory and tools' }).click();
        await page.getByLabel('Web search', { exact: true }).uncheck();
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        const result = await page.evaluate(async () => {
            window.chat.toggleUltraThinkMode(true);
            return window.fileAttachmentHandler.validateAttachment({ name: 'movie.mp4', type: 'video/mp4' });
        });
        assert.equal(result.valid, false);
        await page.locator('#floating-input').fill('Explain this feature');
        await page.locator('#send-message').click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
        const sent = await page.evaluate(() => JSON.parse(window.__testSocket.emitted.find(event => event.name === 'send_message').payload));
        assert.equal(sent.config.internet_search, false);
        assert.equal(sent.config.enable_composio_whatsapp, true);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('current social integrations refresh their connected state', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.evaluate(() => window.aios.openPanel('integrations'));
        await page.waitForFunction(() => document.querySelector('#connect-youtube-btn')?.dataset.action === 'disconnect');
        for (const provider of ['facebook', 'instagram', 'youtube', 'whatsapp']) {
            assert.match(await page.locator(`#connect-${provider}-btn`).textContent(), /Disconnect/);
        }
        assert.equal(await page.locator('#connect-googlesheets-btn').count(), 0);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('saved sessions rename and resume through the shared backend', async () => {
    const { context, page, errors, requests } = await openApp({ width: 1440, height: 900 });
    try {
        await page.evaluate(async () => { await window.contextHandler.loadSessionsInBackground({ force: true }); await window.contextHandler.showSessionDetails('saved-chat'); });
        await page.getByText('Saved answer', { exact: true }).waitFor();
        page.once('dialog', dialog => dialog.accept('Renamed conversation'));
        await page.getByRole('button', { name: 'Rename', exact: true }).click();
        await page.getByText('Renamed conversation', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Continue chat', exact: true }).click();
        await page.waitForFunction(() => window.chat.getCurrentConversationId() === 'saved-chat');
        assert.ok(requests.some(request => request.path === '/api/sessions/saved-chat/title' && request.method === 'PUT'));
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('HTML design preview is sandboxed and sends selected changes to the cloud coder', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.evaluate(async () => { window.projectWorkspace.activate(); await window.projectWorkspace.openFilesSheet(); });
        await page.getByText('index.html', { exact: true }).first().click();
        await page.getByRole('button', { name: 'Preview and edit design' }).click();
        const dialog = page.locator('.web-design-dialog');
        await dialog.frameLocator('iframe').getByRole('heading', { name: 'Project preview' }).click();
        await dialog.getByRole('status').filter({ hasText: 'Selected #title' }).waitFor();
        assert.equal(await page.evaluate(() => window.__unsafe), undefined);
        await dialog.getByLabel('Preview width').selectOption('390px');
        await dialog.getByLabel('Describe your changes').fill('Make this title green.');
        await page.screenshot({ path: path.join(screenshots, 'design-desktop.png') });
        await dialog.getByRole('button', { name: 'Ask coder to edit' }).click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
        const sent = await page.evaluate(() => JSON.parse(window.__testSocket.emitted.find(event => event.name === 'send_message').payload));
        assert.equal(sent.agent_mode, 'coder');
        assert.match(sent.message, /Selected element: #title/);
        assert.match(sent.message, /Make this title green/);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('cloud voice sends the backend audio contract and handles its transcript', async () => {
    const { context, page, errors, requests } = await openApp({ width: 390, height: 844 });
    try {
        const transcript = await page.evaluate(() => window.voiceInputHandler.transcribeWithCloudMic('fixture-audio'));
        assert.equal(transcript, 'Voice test transcript');
        const request = requests.find(request => request.path === '/api/mic/transcribe');
        assert.deepEqual(JSON.parse(request.body), { audio: 'fixture-audio', format: 'wav', language: 'en' });
        assert.equal(request.authorization, 'Bearer fixture-token');
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('presentation metadata remains text and the desktop template reaches requests', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        const count = await page.evaluate(async () => {
            const templates = await import('/js/presentation-templates.js');
            templates.setSelectedPresentationTemplate('venture_blueprint');
            return Object.keys(templates.PRESENTATION_TEMPLATES).length;
        });
        assert.equal(count, 9);
        await page.locator('#floating-input').fill('Create a presentation about the project');
        await page.locator('#send-message').click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
        const sent = await page.evaluate(() => JSON.parse(window.__testSocket.emitted.find(event => event.name === 'send_message').payload));
        assert.match(sent.message, /template="venture_blueprint"/);
        await page.evaluate(sent => window.__testSocket.serverEmit('presentation_generated', { id: sent.id, metadata: {
            artifact_id: 'artifact-1', title: '<img src=x onerror="window.__unsafe=true">', summary: 'Presentation',
            template: 'venture_blueprint', inline: { slides: [{ type: 'title', title: '<script>bad()</script>' }] },
        } }), sent);
        await page.locator('.presentation-preview-block').waitFor();
        assert.equal(await page.locator('.presentation-preview-block img, .presentation-preview-block script').count(), 0);
        assert.equal(await page.evaluate(() => window.__unsafe), undefined);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('vault and usage failures are visible and recover through refresh', async () => {
    const { context, page, errors } = await openApp({ width: 390, height: 844 });
    try {
        await page.route('**/api/user-files?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"File storage unavailable"}' }));
        await page.evaluate(() => window.aios.openPanel('files'));
        await page.getByText('File storage unavailable', { exact: true }).waitFor();
        await page.unroute('**/api/user-files?*');
        await page.locator('#refresh-files-btn').click();
        await page.locator('.web-vault-card').waitFor();
        await page.route('**/api/usage/daily?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Usage service unavailable"}' }));
        await page.evaluate(() => window.aios.openPanel('usage'));
        await page.getByText('Usage service unavailable', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('laptop account controls keep their handlers and panels survive a phone resize', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.locator('#sidebar-profile-btn').click();
        assert.equal(await page.locator('#account-manage-plans-btn').count(), 1);
        await page.locator('#account-manage-plans-btn').click();
        await page.locator('#subscription-modal').waitFor();
        await page.evaluate(() => { window.aios.closeSubscriptionModal(); window.aios.openPanel('usage'); });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => document.querySelector('#settings-view .account-section'));
        await page.locator('#usage-panel').waitFor();
        assert.equal(await page.locator('#settings-view .account-section').count(), 1);
        await page.screenshot({ path: path.join(screenshots, 'usage-resized-mobile.png') });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('light theme preserves usable composer and file controls on phones', async () => {
    const { context, page, errors } = await openApp({ width: 390, height: 844 });
    try {
        await page.evaluate(() => window.aios.setTheme('light'));
        await page.locator('#floating-input').fill('Light theme test');
        const colors = await page.locator('#floating-input').evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(document.body).backgroundColor }));
        assert.notEqual(colors.color, colors.background);
        await page.screenshot({ path: path.join(screenshots, 'home-light-mobile.png') });
        await page.evaluate(() => window.aios.openPanel('files'));
        await page.locator('.web-vault-card').waitFor();
        await page.screenshot({ path: path.join(screenshots, 'vault-light-mobile.png') });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('scheduled tasks retain tools, custom repeat and timezone metadata', async () => {
    const { context, page, errors } = await openApp({ width: 390, height: 844 });
    try {
        await page.waitForFunction(() => window.todo?.elements?.container);
        await page.evaluate(() => { window.todo.toggleWindow(true); window.todo.openNewTaskModal(); });
        await page.locator('#task-name').fill('Research weekly updates');
        await page.locator('#task-description').fill('Prepare a concise report.');
        await page.locator('#task-schedule-date').fill('2026-12-01');
        await page.locator('#task-schedule-time').fill('09:30');
        await page.locator('#task-repeat').selectOption('custom');
        await page.locator('#task-custom-interval-value').fill('2');
        await page.locator('#task-custom-interval-unit').selectOption('days');
        await page.locator('#tool-chips .tool-chip').filter({ hasText: 'Web Search' }).click();
        await page.locator('#task-priority').selectOption('high');
        await page.locator('#task-tags').fill('research, weekly');
        await page.locator('#save-task-btn').click();
        await page.waitForFunction(() => window.__testMutations.some(item => item.table === 'tasks'));
        const task = await page.evaluate(() => window.__testMutations.find(item => item.table === 'tasks').rows[0]);
        assert.equal(task.text, 'Research weekly updates');
        assert.equal(task.priority, 'high');
        assert.deepEqual(task.tags, ['research', 'weekly']);
        assert.deepEqual(task.metadata.custom_interval, { value: 2, unit: 'days' });
        assert.equal(task.metadata.repeat, 'custom');
        assert.deepEqual(task.metadata.tools, ['internet_search']);
        assert.ok(task.metadata.user_timezone);
        assert.ok(task.deadline.endsWith('Z'));
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('chat exports a valid PDF using the browser PDF generator', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.locator('#floating-input').fill('Explain the project');
        await page.locator('#send-message').click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
        const pdf = await page.evaluate(async () => {
            const { pdfExportService } = await import('/js/pdf-export-service.js');
            const { conversationExtractor } = await import('/js/conversation-extractor.js');
            const conversation = await conversationExtractor.extractConversation();
            const ctor = await pdfExportService.ensureJsPdf();
            const document = await pdfExportService.buildPdfDocument(ctor, conversation);
            const bytes = document.output('arraybuffer');
            return { size: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 5)) };
        });
        assert.equal(pdf.signature, '%PDF-');
        assert.ok(pdf.size > 1000);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('background catch-up preserves the active conversation', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        const result = await page.evaluate(() => {
            const current = window.chat.getCurrentConversationId();
            window.__testSocket.serverEmit('run_catchup', { conversationId: 'background-chat', messageId: 'background-message', content: 'Finished in the background.' });
            return { current, after: window.chat.getCurrentConversationId() };
        });
        assert.equal(result.current, result.after);
        await page.getByText('A background chat finished. Open it from Chats to view the result.', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('sign-out clears chat data and returns to the authentication gate', async () => {
    const { context, page, errors } = await openApp({ width: 1440, height: 900 });
    try {
        await page.locator('#floating-input').fill('Private conversation');
        await page.locator('#send-message').click();
        await page.waitForFunction(() => window.__testSocket.emitted.some(event => event.name === 'send_message'));
        await page.locator('#sidebar-profile-btn').click();
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#logout-btn').click();
        await page.locator('#auth-gate-root').waitFor();
        assert.equal(await page.locator('#chat-messages .message').count(), 0);
        assert.equal(await page.evaluate(() => window.__testSocket.connected), false);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});
