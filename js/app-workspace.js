import { AIOS } from './aios.js';
    import { chatModule } from './chat.js';
    import { pdfExportService } from './pdf-export-service.js';
    import { ProjectWorkspaceManager } from './project-workspace-manager.js';
    import { ToDoList } from './to-do-list.js';
    import ContextHandler from './context-handler.js';
    import FileAttachmentHandler from './add-files.js';
    import VoiceInputHandler from './voice-input.js';
    import { messageFormatter } from './message-formatter.js';
    import skeletonLoader from './skeleton-loader.js';
    
    import { openToolSettings } from './web-tool-settings.js';

    // Download button logic
    (function () {
      const downloadBtn = document.getElementById('sidebar-download-btn');
      const downloadPopup = document.getElementById('download-popup');
      if (downloadBtn && downloadPopup) {
        downloadBtn.addEventListener('click', () => {
          window.open('https://aetheriaai.online/download', '_blank');
          downloadPopup.classList.remove('hidden');
          setTimeout(() => {
            downloadPopup.classList.add('hidden');
          }, 3000);
        });
      }
    })();

    // ★★★ NEW: Context Viewer Class (Expanded Logic) ★★★
    class ContextViewer {
      constructor() {
        this.modal = document.getElementById('context-viewer-modal');
        this.closeBtn = this.modal.querySelector('.close-viewer-btn');
        this.tabs = this.modal.querySelectorAll('.viewer-tab');
        this.sessionsContent = this.modal.querySelector('#sessions-content');
        this.filesContent = this.modal.querySelector('#files-content');
        this.tabContents = this.modal.querySelectorAll('.viewer-tab-content');
        this.currentContext = {};

        // --- NEW: Preview Modal Elements ---
        this.previewModal = document.getElementById('context-viewer-preview-modal');
        this.previewContentArea = this.previewModal.querySelector('#context-viewer-preview-area');
        this.closePreviewBtn = this.previewModal.querySelector('.close-preview-btn');

        this.bindEvents();
      }

      bindEvents() {
        this.closeBtn.addEventListener('click', () => this.hide());
        this.modal.addEventListener('click', (e) => {
          if (e.target === this.modal) this.hide();
        });

        this.tabs.forEach(tab => {
          tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // --- Preview Modal Events ---
        this.closePreviewBtn.addEventListener('click', () => this.hidePreview());
        this.previewModal.addEventListener('click', (e) => {
          if (e.target === this.previewModal) this.hidePreview();
        });
      }

      show(contextData) {
        this.currentContext = contextData;
        const { files = [], sessions = [] } = contextData;

        this.renderSessions(sessions);
        this.renderFiles(files);

        this.tabs.forEach(tab => {
          const tabName = tab.dataset.tab;
          const hasContent = (tabName === 'files' && files.length > 0) || (tabName === 'sessions' && sessions.length > 0);
          tab.style.display = hasContent ? 'flex' : 'none';
        });

        if (sessions.length > 0) {
          this.switchTab('sessions');
        } else if (files.length > 0) {
          this.switchTab('files');
        } else {
          this.switchTab('sessions');
        }

        this.modal.classList.remove('hidden');
      }

      hide() {
        this.modal.classList.add('hidden');
      }

      switchTab(tabName) {
        this.tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
        this.tabContents.forEach(content => content.classList.toggle('active', content.id === `${tabName}-content`));
      }

      renderFiles(files) {
        if (files.length === 0) {
          this.filesContent.innerHTML = '<div class="empty-state"><i class="fas fa-paperclip"></i><p>No files were attached.</p></div>';
          return;
        }

        this.filesContent.innerHTML = files.map((file, index) => {
          // Determine file icon based on type
          let iconClass = 'fa-file';
          if (file.type.startsWith('image/')) iconClass = 'fa-file-image';
          else if (file.type.startsWith('video/')) iconClass = 'fa-file-video';
          else if (file.type.startsWith('audio/')) iconClass = 'fa-file-audio';
          else if (file.type === 'application/pdf') iconClass = 'fa-file-pdf';
          else if (file.type.includes('word') || file.type.includes('document')) iconClass = 'fa-file-word';
          else if (file.type.includes('excel') || file.type.includes('spreadsheet')) iconClass = 'fa-file-excel';
          else if (file.type.includes('zip') || file.type.includes('archive')) iconClass = 'fa-file-archive';
          else if (file.name.match(/\.(js|jsx|ts|tsx|py|java|cpp|c|cs|php|rb|go|rs|html|css|json)$/i)) iconClass = 'fa-file-code';

          // Check if file has preview capability (either previewUrl or text content)
          const hasPreview = file.previewUrl || file.isText || file.content;

          return `
                    <div class="viewer-file-item">
                        <i class="fas ${iconClass}"></i>
                        <span class="item-name">${this.escapeHtml(file.name)}</span>
                        <div class="viewer-file-actions">
                            ${hasPreview ? `<button class="preview-context-file-btn" data-file-index="${index}" title="Preview File"><i class="fas fa-eye"></i></button>` : ''}
                        </div>
                    </div>
                `;
        }).join('');

        // Add click handlers for preview buttons
        this.filesContent.querySelectorAll('.preview-context-file-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fileIndex = parseInt(btn.dataset.fileIndex);
            const file = files[fileIndex];
            this.showFilePreview(file);
          });
        });
      }

      renderSessions(sessions) {
        if (sessions.length === 0) {
          this.sessionsContent.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No sessions were used as context.</p></div>';
          return;
        }

        // Render session chips
        this.sessionsContent.innerHTML = sessions.map((session, index) => {
          // Support both session.runs and session.memory.runs structures
          const runs = session.runs || session.memory?.runs || [];

          // Get session title from first user message
          let sessionTitle = `Session ${index + 1}`;
          const topLevelRuns = runs.filter(run => !run.parent_run_id);

          if (topLevelRuns.length > 0) {
            const firstRun = topLevelRuns[0];
            const userInput = firstRun.input?.input_content || firstRun.content || '';

            if (userInput && userInput.trim()) {
              let messageContent = userInput;
              const marker = 'Current message:';
              const markerIndex = messageContent.lastIndexOf(marker);
              if (markerIndex !== -1) {
                messageContent = messageContent.substring(markerIndex + marker.length).trim();
              }

              // Get first line as title
              sessionTitle = messageContent.split('\n')[0].trim();
              if (sessionTitle.length > 50) {
                sessionTitle = sessionTitle.substring(0, 50) + '...';
              }
            }
          }

          return `
                    <div class="viewer-session-chip" data-session-index="${index}">
                        <span class="viewer-session-chip-title">${this.escapeHtml(sessionTitle)}</span>
                        <i class="fas fa-chevron-right viewer-session-chip-icon"></i>
                    </div>
                `;
        }).join('');

        // Add click handlers to chips
        this.sessionsContent.querySelectorAll('.viewer-session-chip').forEach(chip => {
          chip.addEventListener('click', (e) => {
            const sessionIndex = parseInt(chip.dataset.sessionIndex);
            this.showSessionDetail(sessions[sessionIndex], sessionIndex);
          });
        });
      }

      showSessionDetail(session, index) {
        // Support both session.runs and session.memory.runs structures
        const runs = session.runs || session.memory?.runs || [];
        const topLevelRuns = runs.filter(run => !run.parent_run_id);

        // Get session title
        let sessionTitle = `Session ${index + 1}`;
        if (topLevelRuns.length > 0) {
          const firstRun = topLevelRuns[0];
          const userInput = firstRun.input?.input_content || firstRun.content || '';

          if (userInput && userInput.trim()) {
            let messageContent = userInput;
            const marker = 'Current message:';
            const markerIndex = messageContent.lastIndexOf(marker);
            if (markerIndex !== -1) {
              messageContent = messageContent.substring(markerIndex + marker.length).trim();
            }
            sessionTitle = messageContent.split('\n')[0].trim();
            if (sessionTitle.length > 50) {
              sessionTitle = sessionTitle.substring(0, 50) + '...';
            }
          }
        }

        // Build conversation HTML
        const conversationHtml = topLevelRuns.map(run => {
          const userInput = run.input?.input_content || '';
          const assistantOutput = run.content || '';

          let html = '';

          // Add user message
          if (userInput && userInput.trim()) {
            let messageContent = userInput;
            const marker = 'Current message:';
            const markerIndex = messageContent.lastIndexOf(marker);
            if (markerIndex !== -1) {
              messageContent = messageContent.substring(markerIndex + marker.length).trim();
            }

            html += `
                        <div class="viewer-session-turn">
                            <div class="viewer-session-role">User</div>
                            <div class="viewer-session-content">${this.escapeHtml(messageContent)}</div>
                        </div>
                    `;
          }

          // Add assistant message
          if (assistantOutput && assistantOutput.trim()) {
            html += `
                        <div class="viewer-session-turn">
                            <div class="viewer-session-role">Assistant</div>
                            <div class="viewer-session-content">${this.escapeHtml(assistantOutput)}</div>
                        </div>
                    `;
          }

          // Legacy format support
          if (!userInput && !assistantOutput && run.role && run.content) {
            const isUser = run.role === 'user';
            let messageContent = run.content;

            if (isUser) {
              const marker = 'Current message:';
              const markerIndex = messageContent.lastIndexOf(marker);
              if (markerIndex !== -1) {
                messageContent = messageContent.substring(markerIndex + marker.length).trim();
              }
            }

            html += `
                        <div class="viewer-session-turn">
                            <div class="viewer-session-role">${isUser ? 'User' : 'Assistant'}</div>
                            <div class="viewer-session-content">${this.escapeHtml(messageContent)}</div>
                        </div>
                    `;
          }

          return html;
        }).join('');

        // Render expanded view
        this.sessionsContent.innerHTML = `
                <div class="viewer-session-expanded">
                    <div class="viewer-session-header">
                        <button class="viewer-session-back-btn">
                            <i class="fas fa-arrow-left"></i>
                        </button>
                        <div class="viewer-session-header-title">${this.escapeHtml(sessionTitle)}</div>
                    </div>
                    <div class="viewer-session-conversation">
                        ${conversationHtml || '<div class="empty-state"><i class="fas fa-inbox"></i><p>No conversation history.</p></div>'}
                    </div>
                </div>
            `;

        // Add back button handler
        const backBtn = this.sessionsContent.querySelector('.viewer-session-back-btn');
        backBtn.addEventListener('click', () => {
          this.renderSessions(this.currentContext.sessions);
        });
      }

      escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // --- Preview Logic ---
      showFilePreview(file) {
        let contentHTML = '';
        const fileExt = file.name.split('.').pop().toLowerCase();

        // Handle text files
        if (file.isText || file.content) {
          const content = file.content || '';

          // Handle Markdown files
          if (fileExt === 'md' && typeof marked !== 'undefined') {
            const renderedMarkdown = marked.parse(content);
            contentHTML = `
                        <div class="preview-header">
                            <h3 class="preview-title">${this.escapeHtml(file.name)}</h3>
                        </div>
                        <div class="markdown-file-preview">
                            ${renderedMarkdown}
                        </div>
                    `;
          }
          // Handle CSV files
          else if (fileExt === 'csv') {
            const tableHTML = this.renderCSVTable(content);
            contentHTML = `
                        <div class="preview-header">
                            <h3 class="preview-title">${this.escapeHtml(file.name)}</h3>
                        </div>
                        <div class="csv-file-preview">
                            ${tableHTML}
                        </div>
                    `;
          }
          // Handle other text files
          else {
            const escapedContent = this.escapeHtml(content);
            contentHTML = `
                        <div class="preview-header">
                            <h3 class="preview-title">${this.escapeHtml(file.name)}</h3>
                        </div>
                        <div class="text-file-preview">
                            <pre><code>${escapedContent}</code></pre>
                        </div>
                    `;
          }
        }
        // Handle media files with previewUrl
        else if (file.previewUrl) {
          if (file.type.startsWith('image/')) {
            contentHTML = `
                        <div class="preview-header">
                            <h3 class="preview-title">${this.escapeHtml(file.name)}</h3>
                        </div>
                        <img src="${file.previewUrl}" alt="Preview of ${this.escapeHtml(file.name)}">
                    `;
          } else if (file.type.startsWith('video/')) {
            contentHTML = `<video src="${file.previewUrl}" controls autoplay></video>`;
          } else if (file.type.startsWith('audio/')) {
            contentHTML = `<audio src="${file.previewUrl}" controls autoplay></audio>`;
          } else if (file.type === 'application/pdf') {
            contentHTML = `<iframe class="pdf-preview" src="${file.previewUrl}"></iframe>`;
          } else {
            contentHTML = `<p>Preview is not available for this file type.</p>`;
          }
        }
        // Handle binary document files (docx, xlsx, etc.)
        else if (file.type.includes('word') || file.type.includes('excel') || file.type.includes('powerpoint') ||
          file.type.includes('document') || file.type.includes('spreadsheet') || file.type.includes('presentation')) {
          contentHTML = `
                    <div class="preview-unavailable">
                        <i class="fas fa-file-alt"></i>
                        <h3>${this.escapeHtml(file.name)}</h3>
                        <p>Preview is not available for ${fileExt.toUpperCase()} files.</p>
                        <p class="preview-hint">This file will be sent to the AI for processing.</p>
                    </div>
                `;
        }
        else {
          contentHTML = `
                    <div class="preview-unavailable">
                        <i class="fas fa-file"></i>
                        <h3>${this.escapeHtml(file.name)}</h3>
                        <p>Preview is not available for this file type.</p>
                    </div>
                `;
        }

        this.previewContentArea.innerHTML = contentHTML;
        this.previewModal.classList.remove('hidden');
      }

      renderCSVTable(csvContent) {
        const lines = csvContent.split('\n').filter(line => line.trim());
        if (lines.length === 0) return '<p>Empty CSV file</p>';

        // Parse CSV (simple parser, handles basic cases)
        const parseCSVLine = (line) => {
          const result = [];
          let current = '';
          let inQuotes = false;

          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              result.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          result.push(current.trim());
          return result;
        };

        const rows = lines.map(line => parseCSVLine(line));
        const headers = rows[0];
        const dataRows = rows.slice(1);

        // Limit to first 100 rows for performance
        const limitedRows = dataRows.slice(0, 100);
        const hasMore = dataRows.length > 100;

        let tableHTML = '<table class="csv-table"><thead><tr>';
        headers.forEach(header => {
          tableHTML += `<th>${this.escapeHtml(header)}</th>`;
        });
        tableHTML += '</tr></thead><tbody>';

        limitedRows.forEach(row => {
          tableHTML += '<tr>';
          row.forEach(cell => {
            tableHTML += `<td>${this.escapeHtml(cell)}</td>`;
          });
          tableHTML += '</tr>';
        });

        tableHTML += '</tbody></table>';

        if (hasMore) {
          tableHTML += `<p class="csv-note">Showing first 100 rows of ${dataRows.length} total rows</p>`;
        }

        return tableHTML;
      }

      hidePreview() {
        this.previewModal.classList.add('hidden');
        this.previewContentArea.innerHTML = '';
      }
    }

    export async function initializeWorkspace() {
      const loadModuleHTML = async (name, containerId) => {
        try {
          const response = await fetch(`${name}.html`);
          if (!response.ok) throw new Error(`Failed to load ${name}.html: ${response.statusText}`);
          document.getElementById(containerId).innerHTML = await response.text();
        } catch (error) {
          throw new Error(`Could not load ${name}. Please retry.`, { cause: error });
        }
      };


      // Create aios-root container for profile dropdown content
      const aiosRoot = document.createElement('div');
      aiosRoot.id = 'aios-root';
      document.body.appendChild(aiosRoot);

      await Promise.all([
        loadModuleHTML('aios', 'aios-root'),
        loadModuleHTML('chat', 'context-root'),
        loadModuleHTML('to-do-list', 'to-do-list-root')
      ]);

      const chatContainer = document.getElementById('chat-container');
      if (chatContainer) {
        document.getElementById('chat-root').appendChild(chatContainer);
      }

      window.aios = new AIOS();
      const aiosInitPromise = window.aios.init().catch((error) => {
        console.error('[Init] AIOS init failed:', error);
      });

      console.log('[Init] Creating ContextHandler...');
      const contextHandler = new ContextHandler({ preloadDelay: 2500 });
      console.log('[Init] ContextHandler created, initializing elements...');
      contextHandler.initializeElements();
      console.log('[Init] Binding events...');
      contextHandler.bindEvents();
      console.log('[Init] Starting preload sessions...');
      contextHandler.preloadSessions();
      console.log('[Init] ContextHandler setup complete');

      const fileAttachmentHandler = new FileAttachmentHandler();
      const voiceInputHandler = new VoiceInputHandler();

      console.log('[Init] Creating ContextViewer...');
      window.contextViewer = new ContextViewer();
      console.log('[Init] Setting global references...');
      window.chat = chatModule;
      window.contextHandler = contextHandler;
      window.fileAttachmentHandler = fileAttachmentHandler;
      window.voiceInputHandler = voiceInputHandler;
      console.log('[Init] Initializing chat module...');
      window.chat.init(contextHandler, fileAttachmentHandler, window.contextViewer);
      const composer = document.getElementById('floating-input-container');
      const updateComposerClearance = () => {
        const gap = window.matchMedia('(min-width: 1024px)').matches ? 48 : 24;
        document.documentElement.style.setProperty('--web-composer-clearance', `${Math.ceil(composer.getBoundingClientRect().height) + gap}px`);
      };
      const composerObserver = new ResizeObserver(updateComposerClearance);
      composerObserver.observe(composer);
      updateComposerClearance();
      console.log('[Init] Chat module initialized');
      window.projectWorkspace = new ProjectWorkspaceManager();
      window.todo = new ToDoList();
      const todoInitPromise = window.todo.init();
      bindUIEvents();
      await window.projectWorkspace.init();
      console.log('[Init] Core chat initialization complete');

      const loadDeferredModules = async () => {
        try {
          await Promise.allSettled([aiosInitPromise, todoInitPromise]);
          console.log('[Init] Deferred modules initialized');
        } catch (error) {
          console.error('[Init] Deferred module initialization failed:', error);
        }
      };

      loadDeferredModules();
      console.log("AI-OS Initialization Complete.");
    }

    function bindUIEvents() {
      document.querySelectorAll('[role="menu"] i').forEach(icon => icon.setAttribute('aria-hidden', 'true'));
      const hamburgerBtn = document.getElementById('hamburger-btn');
      const newChatBtn = document.getElementById('new-chat-btn');
      const newChatMenu = document.getElementById('new-chat-menu');
      const attachMenuTrigger = document.getElementById('attach-file-btn');
      const inputActionMenu = document.getElementById('input-action-menu');
      const memoryMenuItem = inputActionMenu?.querySelector('[data-menu-action="memory"]');
      const sendBtn = document.getElementById('send-message');
      const input = document.getElementById('floating-input');

      const closeDropdowns = () => {
        newChatBtn?.setAttribute('aria-expanded', 'false');
        attachMenuTrigger?.setAttribute('aria-expanded', 'false');
        newChatMenu?.classList.add('hidden');
        inputActionMenu?.classList.add('hidden');
        window.projectWorkspace?.closeQuickMenu?.();
      };

      function closeFloatingWindows() {
        window.todo?.toggleWindow(false);
        window.contextHandler?.toggleWindow(false);
      }

      function closeAllModalsAndMenus() {
        closeFloatingWindows();
        closeDropdowns();
      }

      document.addEventListener('keydown', event => {
        if (document.querySelector('dialog[open]')) return;
        const focused = document.activeElement;
        let menu = focused?.closest('[role="menu"]');
        if (['ArrowDown', 'ArrowUp'].includes(event.key) && (focused === newChatBtn || focused === attachMenuTrigger)) {
          const target = focused === newChatBtn ? newChatMenu : inputActionMenu;
          if (target.classList.contains('hidden')) focused.click();
          menu = target;
          const choices = menu.querySelectorAll('button[role="menuitem"]:not(:disabled)');
          (event.key === 'ArrowUp' ? choices[choices.length - 1] : choices[0])?.focus();
          event.preventDefault();
          return;
        }
        if (!menu) {
          if (event.key === 'Escape' && (!newChatMenu?.classList.contains('hidden') || !inputActionMenu?.classList.contains('hidden'))) {
            closeDropdowns();
            event.preventDefault();
          }
          return;
        }
        const items = Array.from(menu.querySelectorAll('button[role="menuitem"]:not(:disabled)'));
        if (event.key === 'Tab') {
          const trigger = menu === newChatMenu ? newChatBtn : menu === inputActionMenu ? attachMenuTrigger : document.getElementById('project-workspace-actions-btn');
          closeDropdowns();
          trigger?.focus();
          return;
        }
        if (event.key === 'Escape') {
          const trigger = menu === newChatMenu ? newChatBtn : menu === inputActionMenu ? attachMenuTrigger : document.getElementById('project-workspace-actions-btn');
          closeDropdowns();
          trigger?.focus();
          event.preventDefault();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
          const index = items.indexOf(focused);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next].focus();
          event.preventDefault();
        }
      });

      // Profile menu button handler is now in aios.js

      newChatBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        const isExpanded = newChatBtn.getAttribute('aria-expanded') === 'true';
        closeDropdowns();
        if (!isExpanded) {
          newChatBtn.setAttribute('aria-expanded', 'true');
          newChatMenu?.classList.remove('hidden');
        }
      });

      newChatMenu?.addEventListener('click', (event) => {
        event.stopPropagation();
        const item = event.target.closest('.dropdown-item');
        if (!item) return;

        const action = item.dataset.dropdownAction;
        closeDropdowns();
        if (action === 'new-chat') {
          window.chat?.clearChat();
        } else if (action === 'new-task') {
          closeFloatingWindows();
          window.todo?.toggleWindow(true);
        } else if (action === 'export-pdf') {
          pdfExportService.exportEntireConversationPdf().catch(error => window.chat?.showNotification(error.message, 'error'));
        } else if (action === 'project-workspace') {
          window.projectWorkspace?.toggleFromMenu?.();
        }
      });

      attachMenuTrigger?.addEventListener('click', (event) => {
        event.stopPropagation();
        const isExpanded = attachMenuTrigger.getAttribute('aria-expanded') === 'true';
        closeDropdowns();
        if (!isExpanded) {
          attachMenuTrigger.setAttribute('aria-expanded', 'true');
          inputActionMenu?.classList.remove('hidden');
        }
      });

      memoryMenuItem?.addEventListener('click', (event) => {
        event.stopPropagation();
        const current = window.chat?.getConfig?.().memory;
        window.chat?.setMemoryEnabled?.(!current);
        memoryMenuItem.classList.toggle('active', !current);
        memoryMenuItem.setAttribute('aria-pressed', (!current).toString());
      });

      inputActionMenu?.addEventListener('click', (event) => {
        event.stopPropagation();
        const item = event.target.closest('.input-action-menu-item');
        if (!item) return;

        const action = item.dataset.menuAction;
        if (action === 'tools') {
          closeDropdowns();
          openToolSettings(window.chat);
          return;
        }
        if (action === 'ultra-think') {
          window.chat?.toggleUltraThinkMode?.();
          closeDropdowns();
          return;
        }
        console.log('[UI] Input action menu clicked:', action);

        if (action === 'new-chat') {
          closeDropdowns();
          window.chat?.clearChat?.();
        } else if (action === 'attach') {
          closeDropdowns();
          window.fileAttachmentHandler?.openFilePicker?.();
        } else if (action === 'sessions') {
          console.log('[UI] Sessions button clicked, contextHandler exists:', !!window.contextHandler);
          closeDropdowns();
          closeFloatingWindows();
          if (window.contextHandler) {
            console.log('[UI] Calling toggleWindow(true)...');
            window.contextHandler.toggleWindow(true);
          } else {
            console.error('[UI] contextHandler not available!');
          }
        } else if (action === 'memory') {
          // handled above, but keep menu open for toggle feedback
        }
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('#bottom-ui-container')) {
          closeAllModalsAndMenus();
        }
        if (!e.target.closest('.top-bar-action')) {
          newChatBtn?.setAttribute('aria-expanded', 'false');
          newChatMenu?.classList.add('hidden');
        }
      });

      document.getElementById('plan-mode-btn')?.addEventListener('click', () => {
        window.chat?.togglePlanMode?.();
      });

      sendBtn?.addEventListener('click', () => {
        const action = sendBtn.dataset.action;
        if (action === 'smart-voice' || action === 'stop-smart-voice') {
          window.voiceInputHandler?.toggleIntelligentListening();
          return;
        }
        if (action === 'none') return;
        if (window.chat?.isSessionActive?.()) {
          window.chat.stopCurrentResponse?.();
          return;
        }
        window.chat.handleSendMessage();
      });

      input?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          window.chat.handleSendMessage();
        }
      });

      input?.addEventListener('input', () => {
        // Close the plus button menu when user starts typing
        closeDropdowns();

        // Use requestAnimationFrame to batch layout changes and prevent jank
        requestAnimationFrame(() => {
          input.style.height = 'auto';
          input.style.height = `${input.scrollHeight}px`;
        });
      });

      input?.addEventListener('focus', () => {
        // Close the plus button menu when input is focused
        closeDropdowns();
      });

      // ── Desktop sidebar wiring (>=1024px) ─────────────────
      bindDesktopSidebar();
    }

    function bindDesktopSidebar() {
      const profileBtn = document.getElementById('sidebar-profile-btn');
      const tasksBtn = document.getElementById('sidebar-tasks-btn');
      const projectBtn = document.getElementById('sidebar-project-btn');

      // On desktop (>=1024px), the top-bar is display:none which hides #profile-dropdown.
      // Move the dropdown to body so it remains visible when toggled.
      if (window.matchMedia('(min-width: 1024px)').matches) {
        const profileDropdown = document.getElementById('profile-dropdown');
        if (profileDropdown && profileDropdown.parentElement) {
          document.body.appendChild(profileDropdown);
        }
      }

      const setActive = (btn) => {
        document.querySelectorAll('.desktop-sidebar-icon').forEach((el) => el.classList.remove('active'));
        btn?.classList.add('active');
      };

      profileBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.aios?.toggleProfileMenu) {
          window.aios.toggleProfileMenu();
        }
        setActive(profileBtn);
      });

      tasksBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const todo = window.todo;
        if (!todo?.toggleWindow) return;
        const isOpen = todo.elements?.container && !todo.elements.container.classList.contains('hidden');
        todo.toggleWindow(!isOpen);
        setActive(isOpen ? null : tasksBtn);
      });

      projectBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.projectWorkspace?.toggleFromMenu) {
          window.projectWorkspace.toggleFromMenu();
          setActive(window.projectWorkspace?.state?.active ? projectBtn : null);
        }
      });

      // Close active state when clicking elsewhere on the page
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.desktop-sidebar') &&
            !e.target.closest('#profile-dropdown') &&
            !e.target.closest('#to-do-list-container') &&
            !e.target.closest('#context-window')) {
          // No-op: we only mark active on open. Real close paths drop active via state listener below.
        }
      });

      // Sync sidebar avatar with profile photo if present
      const updateAvatar = () => {
        const profilePhoto = document.getElementById('profile-photo');
        const sidebarAvatar = document.getElementById('sidebar-profile-avatar');
        if (!sidebarAvatar) return;
        if (profilePhoto && !profilePhoto.classList.contains('hidden') && profilePhoto.src) {
          sidebarAvatar.innerHTML = `<img src="${profilePhoto.src}" alt="Profile" />`;
          sidebarAvatar.classList.remove('hidden');
        } else {
          sidebarAvatar.classList.add('hidden');
          sidebarAvatar.innerHTML = '';
        }
      };
      updateAvatar();
      // Re-check shortly after init so it picks up async profile loads
      setTimeout(updateAvatar, 1500);
      setTimeout(updateAvatar, 4000);
    }
