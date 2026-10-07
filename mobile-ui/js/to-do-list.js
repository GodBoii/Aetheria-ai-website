// js/to-do-list.js
import NotificationService from './notification-service.js';
import { supabase } from './supabase-client.js';

export class ToDoList {
    constructor() {
        this.tasks = [];
        this.elements = {};
        this.triggerButton = null;
        this.notificationService = new NotificationService();
        this.subscription = null;
        this.bootstrapPromise = null;
        this._currentOutputTask = null;
    }

    async init() {
        this.cacheElements();
        this.setupEventListeners();
        this.registerFloatingWindow();

        if (this.bootstrapPromise) {
            return this.bootstrapPromise;
        }

        this.bootstrapPromise = this.initializeDataInBackground();
        return this.bootstrapPromise;
    }

    async initializeDataInBackground() {
        try {
            const isReady = await this.waitForAppReady();
            if (!isReady) return false;

            await this.fetchTasks();
            this.setupRealtimeSubscription();
            return true;
        } catch (error) {
            console.error('ToDoList background initialization failed:', error);
            return false;
        }
    }

    async waitForAppReady() {
        let attempts = 0;
        while (attempts < 30) {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) return true;
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }
        console.warn('ToDoList: Auth session not found after waiting.');
        return false;
    }

    cacheElements() {
        this.elements = {
            container: document.getElementById('to-do-list-container'),
            closeBtn: document.querySelector('.task-close-btn'),
            taskGrid: document.getElementById('task-grid'),
            emptyState: document.getElementById('task-empty-state'),
            addFab: document.getElementById('add-task-fab'),

            // New Task Modal
            newTaskModal: document.getElementById('new-task-modal'),
            taskNameInput: document.getElementById('task-name'),
            taskDescriptionInput: document.getElementById('task-description'),
            taskTimeInput: document.getElementById('task-time'),
            taskDateInput: document.getElementById('task-date'),
            taskRepeatSelect: document.getElementById('task-repeat'),
            customIntervalGroup: document.getElementById('custom-interval-group'),
            taskIntervalValue: document.getElementById('task-interval-value'),
            taskIntervalUnit: document.getElementById('task-interval-unit'),
            taskInstructions: document.getElementById('task-instructions'),
            taskPriorityInput: document.getElementById('task-priority'),
            taskTagsInput: document.getElementById('task-tags'),
            saveTaskBtn: document.getElementById('save-task-btn'),
            cancelTaskBtn: document.getElementById('cancel-task-btn'),

            // Output Panel
            outputBackdrop: document.getElementById('task-output-backdrop'),
            outputPanel: document.getElementById('task-output-panel'),
            outputTitle: document.getElementById('task-output-title'),
            outputMeta: document.getElementById('task-output-meta'),
            outputContent: document.getElementById('task-output-content'),
            outputDownload: document.getElementById('task-output-download'),
            outputClose: document.getElementById('task-output-close'),

            // Detail Modal (Bottom Sheet)
            detailOverlay: document.getElementById('task-detail-modal'),
            detailTitle: document.getElementById('task-detail-title'),
            detailBody: document.getElementById('task-detail-body'),
            detailClose: document.querySelector('.task-detail-close'),
        };
    }

    setupEventListeners() {
        // Panel close
        this.elements.closeBtn?.addEventListener('click', () => this.toggleWindow(false));

        // FAB
        this.elements.addFab?.addEventListener('click', () => this.openNewTaskModal());

        // Task creation
        this.elements.saveTaskBtn?.addEventListener('click', () => this.saveNewTask());
        this.elements.cancelTaskBtn?.addEventListener('click', () => this.closeNewTaskModal());

        // Repeat selector — toggle custom interval
        this.elements.taskRepeatSelect?.addEventListener('change', (e) => {
            const show = e.target.value === 'custom';
            this.elements.customIntervalGroup?.classList.toggle('hidden', !show);
        });

        // Output panel close
        this.elements.outputClose?.addEventListener('click', () => this.closeOutputPanel());
        this.elements.outputBackdrop?.addEventListener('click', () => this.closeOutputPanel());
        this.elements.outputDownload?.addEventListener('click', () => this.downloadOutput());

        // Detail bottom sheet close
        this.elements.detailClose?.addEventListener('click', () => this.closeDetailModal());
        this.elements.detailOverlay?.addEventListener('click', (e) => {
            // Close only if tapping the backdrop (not the sheet itself)
            if (e.target === this.elements.detailOverlay) {
                this.closeDetailModal();
            }
        });

        // Close new task modal on backdrop click
        this.elements.newTaskModal?.addEventListener('click', (e) => {
            if (e.target === this.elements.newTaskModal) this.closeNewTaskModal();
        });
    }

    toggleWindow(show, buttonElement = null) {
        if (!this.elements.container) return;

        if (show && buttonElement) {
            this.triggerButton = buttonElement;
        }

        if (show) {
            this.elements.container.classList.add('visible');
            document.body.classList.add('tasks-panel-open');
        } else {
            this.elements.container.classList.remove('visible');
            document.body.classList.remove('tasks-panel-open');
        }

        if (!show && this.triggerButton) {
            this.triggerButton.classList.remove('active');
            this.triggerButton = null;
        }

        if (window.chat?.setTasksVisibility) {
            window.chat.setTasksVisibility(show, { source: 'tasksModal' });
        }
    }

    setupRealtimeSubscription() {
        this.subscription = supabase
            .channel('tasks_channel')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
                this.fetchTasks();
            })
            .subscribe();
    }

    async fetchTasks() {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { data, error } = await supabase
                .from('tasks')
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) throw error;

            this.tasks = data || [];
            this.renderTasks();
        } catch (err) {
            console.error('Error fetching tasks:', err);
            this.showNotification('Failed to fetch tasks', 'error');
        }
    }

    async saveNewTask() {
        const taskName = this.elements.taskNameInput?.value.trim();
        if (!taskName) {
            this.showNotification('Task name is required.', 'warning');
            return;
        }

        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                this.showNotification('You must be logged in to create tasks.', 'error');
                return;
            }

            const rawTags = this.elements.taskTagsInput?.value || '';
            const tagsArray = rawTags.split(',').map(t => t.trim()).filter(t => t);

            // Build schedule (convert local time to UTC)
            const time = this.elements.taskTimeInput?.value;
            const date = this.elements.taskDateInput?.value;
            let deadline = null;
            let nextRunAt = null;

            if (time && date) {
                const localIso = new Date(`${date}T${time}:00`).toISOString();
                deadline = localIso;
                nextRunAt = localIso;
            } else if (time) {
                const today = new Date().toISOString().split('T')[0];
                const localIso = new Date(`${today}T${time}:00`).toISOString();
                deadline = localIso;
                nextRunAt = localIso;
            }

            // Repeat config
            const repeat = this.elements.taskRepeatSelect?.value || 'none';
            let customInterval = null;
            if (repeat === 'custom') {
                customInterval = {
                    value: parseInt(this.elements.taskIntervalValue?.value) || 1,
                    unit: this.elements.taskIntervalUnit?.value || 'days'
                };
            }

            // Tools
            const toolCheckboxes = document.querySelectorAll('input[name="task-tools"]:checked');
            const tools = Array.from(toolCheckboxes).map(cb => cb.value);

            // Custom instructions
            const customInstructions = this.elements.taskInstructions?.value.trim() || null;

            const taskId = crypto.randomUUID();
            const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const tzOffsetMinutes = new Date().getTimezoneOffset();

            const newTask = {
                id: taskId,
                user_id: user.id,
                text: taskName,
                description: this.elements.taskDescriptionInput?.value.trim() || null,
                priority: this.elements.taskPriorityInput?.value || 'medium',
                status: 'pending',
                deadline: deadline,
                tags: tagsArray,
                created_at: new Date().toISOString(),
                metadata: {
                    source: 'pwa',
                    tools: tools,
                    custom_instructions: customInstructions,
                    repeat: repeat !== 'none' ? repeat : null,
                    custom_interval: customInterval,
                    next_run_at: nextRunAt,
                    user_timezone: userTimezone,
                    tz_offset_minutes: tzOffsetMinutes
                }
            };

            const { error } = await supabase
                .from('tasks')
                .insert([newTask])
                .select();

            if (error) throw error;

            this.showNotification('Task created successfully', 'success');
            this.closeNewTaskModal();
            await this.fetchTasks();

        } catch (err) {
            console.error('Error creating task:', err);
            this.showNotification('Failed to create task: ' + err.message, 'error');
        }
    }

    async toggleTaskCompletion(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;

        const newStatus = task.status === 'completed' ? 'pending' : 'completed';
        const completedAt = newStatus === 'completed' ? new Date().toISOString() : null;

        try {
            const { error } = await supabase
                .from('tasks')
                .update({ status: newStatus, completed_at: completedAt })
                .eq('id', taskId);

            if (error) throw error;

            task.status = newStatus;
            this.renderTasks();
        } catch (err) {
            console.error('Error updating task:', err);
            this.showNotification('Failed to update task', 'error');
            await this.fetchTasks();
        }
    }

    async deleteTask(taskId) {
        if (!confirm('Delete this task?')) return;

        try {
            const { error } = await supabase
                .from('tasks')
                .delete()
                .eq('id', taskId);

            if (error) throw error;
            this.showNotification('Task deleted', 'info');
            // Close detail if it was open for this task
            this.closeDetailModal();
        } catch (err) {
            console.error('Error deleting task:', err);
            this.showNotification('Failed to delete task', 'error');
        }
    }

    // --- Rendering ---

    renderTasks() {
        const grid = this.elements.taskGrid;
        const emptyState = this.elements.emptyState;
        if (!grid) return;

        grid.innerHTML = '';

        if (this.tasks.length === 0) {
            emptyState?.classList.remove('hidden');
            return;
        }

        emptyState?.classList.add('hidden');

        this.tasks.forEach((task, index) => {
            const card = this.createTaskCard(task, index);
            grid.appendChild(card);
        });
    }

    createTaskCard(task, index) {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.style.animationDelay = `${index * 55}ms`;
        card.dataset.id = task.id;

        // Tap card body (not actions) to show detail bottom sheet
        card.addEventListener('click', (e) => {
            if (e.target.closest('.task-card-actions')) return;
            this.showDetailModal(task);
        });

        // Title
        const title = document.createElement('h4');
        title.className = 'task-card-title';
        title.textContent = this.escapeHtml(task.text);
        card.appendChild(title);

        // Description (2-line clamp)
        if (task.description) {
            const desc = document.createElement('p');
            desc.className = 'task-card-description';
            desc.textContent = task.description;
            card.appendChild(desc);
        }

        // Meta row
        const meta = document.createElement('div');
        meta.className = 'task-card-meta';

        // Status badge
        const statusBadge = document.createElement('span');
        const statusClass = task.status === 'in_progress' ? 'in_progress' : task.status;
        statusBadge.className = `task-status-badge ${statusClass}`;
        const statusIcon = task.status === 'in_progress' ? '<i class="fas fa-circle-notch"></i> ' :
                           task.status === 'completed' ? '<i class="fas fa-check"></i> ' : '';
        statusBadge.innerHTML = `${statusIcon}${task.status.replace('_', ' ')}`;
        meta.appendChild(statusBadge);

        // Schedule badge
        const nextRun = task.metadata?.next_run_at || task.deadline;
        if (nextRun) {
            const scheduleBadge = document.createElement('span');
            scheduleBadge.className = 'task-schedule-badge';
            scheduleBadge.innerHTML = `<i class="fas fa-clock"></i> ${this.formatSchedule(nextRun)}`;
            meta.appendChild(scheduleBadge);
        }

        // Priority dot
        if (task.priority) {
            const dot = document.createElement('span');
            dot.className = `task-priority-dot ${task.priority}`;
            dot.title = `${task.priority} priority`;
            meta.appendChild(dot);
        }

        card.appendChild(meta);

        // Tool badges
        const tools = task.metadata?.tools;
        if (tools && tools.length > 0) {
            const toolsDiv = document.createElement('div');
            toolsDiv.className = 'task-card-tools';
            tools.forEach(tool => {
                const badge = document.createElement('span');
                badge.className = 'task-tool-badge';
                badge.textContent = this.getToolLabel(tool);
                toolsDiv.appendChild(badge);
            });
            card.appendChild(toolsDiv);
        }

        // --- Action buttons (ALWAYS visible for mobile) ---
        const actions = document.createElement('div');
        actions.className = 'task-card-actions';

        // View output button (only if task_work exists)
        if (task.task_work && task.task_work.trim().length > 0) {
            const viewBtn = document.createElement('button');
            viewBtn.className = 'task-card-action-btn output-action';
            viewBtn.innerHTML = '<i class="fas fa-file-lines"></i> Output';
            viewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showOutputPanel(task);
            });
            actions.appendChild(viewBtn);
        }

        // Complete toggle
        const completeBtn = document.createElement('button');
        const isCompleted = task.status === 'completed';
        completeBtn.className = `task-card-action-btn complete-action ${isCompleted ? 'is-completed' : ''}`;
        completeBtn.innerHTML = isCompleted
            ? '<i class="fas fa-rotate-left"></i> Undo'
            : '<i class="fas fa-check"></i> Done';
        completeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleTaskCompletion(task.id);
        });
        actions.appendChild(completeBtn);

        // Delete
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'task-card-action-btn delete-action';
        deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteTask(task.id);
        });
        actions.appendChild(deleteBtn);

        card.appendChild(actions);

        return card;
    }

    // --- Output Panel ---

    showOutputPanel(task) {
        this._currentOutputTask = task;

        if (this.elements.outputTitle) {
            this.elements.outputTitle.textContent = task.text;
        }

        if (this.elements.outputMeta) {
            let metaHtml = `<span class="task-status-badge ${task.status}">${task.status.replace('_', ' ')}</span>`;
            const nextRun = task.metadata?.next_run_at || task.deadline;
            if (nextRun) {
                metaHtml += `<span class="task-schedule-badge"><i class="fas fa-clock"></i> ${this.formatSchedule(nextRun)}</span>`;
            }
            const tools = task.metadata?.tools;
            if (tools && tools.length > 0) {
                tools.forEach(t => {
                    metaHtml += `<span class="task-tool-badge">${this.getToolLabel(t)}</span>`;
                });
            }
            this.elements.outputMeta.innerHTML = metaHtml;
        }

        if (this.elements.outputContent) {
            const content = task.task_work || 'No output available.';
            if (typeof marked !== 'undefined') {
                this.elements.outputContent.innerHTML = marked.parse(content);
                if (typeof hljs !== 'undefined') {
                    this.elements.outputContent.querySelectorAll('pre code').forEach((block) => {
                        hljs.highlightElement(block);
                    });
                }
            } else {
                this.elements.outputContent.textContent = content;
            }
        }

        this.elements.outputBackdrop?.classList.remove('hidden');
        this.elements.outputBackdrop?.classList.add('visible');
        this.elements.outputPanel?.classList.remove('hidden');
        this.elements.outputPanel?.classList.add('visible');
    }

    closeOutputPanel() {
        this.elements.outputBackdrop?.classList.remove('visible');
        this.elements.outputPanel?.classList.remove('visible');
        // Allow transition to finish before adding hidden
        setTimeout(() => {
            this.elements.outputBackdrop?.classList.add('hidden');
            this.elements.outputPanel?.classList.add('hidden');
        }, 300);
        this._currentOutputTask = null;
    }

    downloadOutput() {
        const task = this._currentOutputTask;
        if (!task || !task.task_work) return;

        const sanitizedTitle = task.text.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
        const filename = `${sanitizedTitle || 'task-output'}.md`;

        const header = `# ${task.text}\n\n` +
            `**Status:** ${task.status}\n` +
            (task.deadline ? `**Schedule:** ${new Date(task.deadline).toLocaleString()}\n` : '') +
            (task.metadata?.tools?.length ? `**Tools:** ${task.metadata.tools.map(t => this.getToolLabel(t)).join(', ')}\n` : '') +
            `**Generated:** ${new Date().toLocaleString()}\n\n---\n\n`;

        const content = header + task.task_work;
        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // --- Detail Modal (Bottom Sheet — overlays ON TOP of task panel) ---

    showDetailModal(task) {
        if (!this.elements.detailOverlay || !this.elements.detailBody) return;

        this.elements.detailTitle.textContent = task.text;

        let html = '';

        // Status
        html += `<div class="task-detail-row">
            <span class="task-detail-label">Status</span>
            <span class="task-detail-value"><span class="task-status-badge ${task.status}">${task.status.replace('_', ' ')}</span></span>
        </div>`;

        // Priority
        html += `<div class="task-detail-row">
            <span class="task-detail-label">Priority</span>
            <span class="task-detail-value" style="display:flex;align-items:center;gap:0.4rem;"><span class="task-priority-dot ${task.priority}"></span> ${task.priority}</span>
        </div>`;

        // Description
        if (task.description) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Details</span>
                <span class="task-detail-value">${this.escapeHtml(task.description)}</span>
            </div>`;
        }

        // Schedule
        const nextRun = task.metadata?.next_run_at || task.deadline;
        if (nextRun) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Schedule</span>
                <span class="task-detail-value">${new Date(nextRun).toLocaleString()}</span>
            </div>`;
        }

        // Repeat
        const repeat = task.metadata?.repeat;
        if (repeat) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Repeat</span>
                <span class="task-detail-value">${repeat}</span>
            </div>`;
        }

        // Tools
        const tools = task.metadata?.tools;
        if (tools && tools.length > 0) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Tools</span>
                <span class="task-detail-value">${tools.map(t => this.getToolLabel(t)).join(', ')}</span>
            </div>`;
        }

        // Custom instructions
        const instructions = task.metadata?.custom_instructions;
        if (instructions) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Instruct.</span>
                <span class="task-detail-value">${this.escapeHtml(instructions)}</span>
            </div>`;
        }

        // Timezone
        if (task.metadata?.user_timezone) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Timezone</span>
                <span class="task-detail-value">${task.metadata.user_timezone}</span>
            </div>`;
        }

        // Created
        html += `<div class="task-detail-row">
            <span class="task-detail-label">Created</span>
            <span class="task-detail-value">${new Date(task.created_at).toLocaleString()}</span>
        </div>`;

        // Completed
        if (task.completed_at) {
            html += `<div class="task-detail-row">
                <span class="task-detail-label">Completed</span>
                <span class="task-detail-value">${new Date(task.completed_at).toLocaleString()}</span>
            </div>`;
        }

        // Action buttons in the detail sheet
        html += `<div class="task-detail-actions">`;
        if (task.task_work && task.task_work.trim().length > 0) {
            html += `<button class="task-detail-action-btn primary-action" data-action="view-output" data-task-id="${task.id}">
                <i class="fas fa-file-lines"></i> View Output
            </button>`;
        }
        html += `<button class="task-detail-action-btn danger-action" data-action="delete" data-task-id="${task.id}">
            <i class="fas fa-trash-alt"></i> Delete
        </button>`;
        html += `</div>`;

        this.elements.detailBody.innerHTML = html;

        // Bind detail action buttons
        this.elements.detailBody.querySelector('[data-action="view-output"]')?.addEventListener('click', () => {
            this.closeDetailModal();
            setTimeout(() => this.showOutputPanel(task), 200);
        });
        this.elements.detailBody.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            this.deleteTask(task.id);
        });

        // Show the overlay (does NOT close the task panel)
        this.elements.detailOverlay.classList.remove('hidden');
        // Trigger reflow for animation
        void this.elements.detailOverlay.offsetHeight;
        this.elements.detailOverlay.classList.add('visible');
    }

    closeDetailModal() {
        if (!this.elements.detailOverlay) return;
        this.elements.detailOverlay.classList.remove('visible');
        setTimeout(() => {
            this.elements.detailOverlay.classList.add('hidden');
        }, 350);
    }

    // --- Modals ---

    openNewTaskModal() {
        this.elements.newTaskModal?.classList.remove('hidden');
    }

    closeNewTaskModal() {
        this.elements.newTaskModal?.classList.add('hidden');
        const modal = this.elements.newTaskModal;
        if (modal) {
            modal.querySelectorAll('input[type="text"], input[type="time"], input[type="date"], input[type="number"], textarea').forEach(el => {
                el.value = '';
            });
            modal.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
            if (this.elements.taskRepeatSelect) this.elements.taskRepeatSelect.value = 'none';
            if (this.elements.taskPriorityInput) this.elements.taskPriorityInput.value = 'medium';
            this.elements.customIntervalGroup?.classList.add('hidden');
        }
    }

    // --- Helpers ---

    formatSchedule(isoString) {
        try {
            const d = new Date(isoString);
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const isTomorrow = d.toDateString() === tomorrow.toDateString();

            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            if (isToday) return `Today ${time}`;
            if (isTomorrow) return `Tomorrow ${time}`;
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`;
        } catch {
            return isoString;
        }
    }

    getToolLabel(tool) {
        const labels = {
            'internet_search': 'Web Search',
            'browser': 'Browser',
            'email': 'Email',
            'google_drive': 'Drive',
            'google_sheets': 'Sheets',
            'github': 'GitHub'
        };
        return labels[tool] || tool;
    }

    registerFloatingWindow() {
        if (this.elements.container && window.chat?.registerFloatingWindow) {
            window.chat.registerFloatingWindow('tasks', this.elements.container);
        }
    }

    showNotification(message, type = 'info', duration = 3000) {
        if (this.notificationService) {
            this.notificationService.show(message, type, duration);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
