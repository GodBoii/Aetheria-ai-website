// js/to-do-list.js — Task System Redesign (Card Grid + Output Panel + Amber Design)
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
        this.currentOutputTask = null;
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
            closeBtn: document.querySelector('.task-panel-close-btn'),
            taskGrid: document.getElementById('task-grid'),
            emptyState: document.getElementById('task-empty-state'),
            addTaskFab: document.getElementById('add-task-fab'),

            // Create Modal
            newTaskModal: document.getElementById('new-task-modal'),
            taskNameInput: document.getElementById('task-name'),
            taskDescriptionInput: document.getElementById('task-description'),
            taskPriorityInput: document.getElementById('task-priority'),
            taskTagsInput: document.getElementById('task-tags'),
            taskScheduleTime: document.getElementById('task-schedule-time'),
            taskScheduleDate: document.getElementById('task-schedule-date'),
            taskRepeat: document.getElementById('task-repeat'),
            customIntervalGroup: document.getElementById('custom-interval-group'),
            customIntervalValue: document.getElementById('task-custom-interval-value'),
            customIntervalUnit: document.getElementById('task-custom-interval-unit'),
            taskInstructions: document.getElementById('task-instructions'),
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

            // Detail Modal
            detailModal: document.getElementById('task-detail-modal'),
            detailTitle: document.getElementById('task-detail-title'),
            detailBody: document.getElementById('task-detail-body'),
            detailCloseBtn: document.querySelector('.task-detail-close-btn'),
        };
    }

    setupEventListeners() {
        // Panel close
        this.elements.closeBtn?.addEventListener('click', () => this.toggleWindow(false));

        // FAB
        this.elements.addTaskFab?.addEventListener('click', () => this.openNewTaskModal());

        // Create Modal
        this.elements.saveTaskBtn?.addEventListener('click', () => this.saveNewTask());
        this.elements.cancelTaskBtn?.addEventListener('click', () => this.closeNewTaskModal());
        this.elements.newTaskModal?.addEventListener('click', (e) => {
            if (e.target === this.elements.newTaskModal) this.closeNewTaskModal();
        });

        // Repeat → custom interval toggle
        this.elements.taskRepeat?.addEventListener('change', (e) => {
            const show = e.target.value === 'custom';
            this.elements.customIntervalGroup?.classList.toggle('hidden', !show);
        });

        // Output Panel
        this.elements.outputClose?.addEventListener('click', () => this.closeOutputPanel());
        this.elements.outputBackdrop?.addEventListener('click', () => this.closeOutputPanel());
        this.elements.outputDownload?.addEventListener('click', () => this.downloadOutput());

        // Detail Modal
        this.elements.detailCloseBtn?.addEventListener('click', () => this.closeDetailModal());
        this.elements.detailModal?.addEventListener('click', (e) => {
            if (e.target === this.elements.detailModal) this.closeDetailModal();
        });
    }

    toggleWindow(show, buttonElement = null) {
        if (!this.elements.container) return;

        if (show && buttonElement) {
            this.triggerButton = buttonElement;
        }

        this.elements.container.classList.toggle('hidden', !show);

        // Toggle body class
        if (show) {
            document.body.classList.add('tasks-panel-open');
        } else {
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

    // ================================================================
    // TASK CREATION
    // ================================================================

    openNewTaskModal() {
        this.elements.newTaskModal?.classList.remove('hidden');
        this.elements.taskNameInput?.focus();
    }

    closeNewTaskModal() {
        this.elements.newTaskModal?.classList.add('hidden');
        // Reset form
        if (this.elements.taskNameInput) this.elements.taskNameInput.value = '';
        if (this.elements.taskDescriptionInput) this.elements.taskDescriptionInput.value = '';
        if (this.elements.taskPriorityInput) this.elements.taskPriorityInput.value = 'medium';
        if (this.elements.taskTagsInput) this.elements.taskTagsInput.value = '';
        if (this.elements.taskScheduleTime) this.elements.taskScheduleTime.value = '';
        if (this.elements.taskScheduleDate) this.elements.taskScheduleDate.value = '';
        if (this.elements.taskRepeat) this.elements.taskRepeat.value = 'none';
        if (this.elements.customIntervalValue) this.elements.customIntervalValue.value = '1';
        if (this.elements.customIntervalUnit) this.elements.customIntervalUnit.value = 'hours';
        if (this.elements.taskInstructions) this.elements.taskInstructions.value = '';
        this.elements.customIntervalGroup?.classList.add('hidden');
        // Uncheck all tool chips
        document.querySelectorAll('#tool-chips input[type="checkbox"]').forEach(cb => cb.checked = false);
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
                this.showNotification('You must be logged in.', 'error');
                return;
            }

            // Gather tools
            const tools = [];
            document.querySelectorAll('#tool-chips input[type="checkbox"]:checked').forEach(cb => {
                tools.push(cb.value);
            });

            // Gather schedule
            const scheduleTime = this.elements.taskScheduleTime?.value || '';
            const scheduleDate = this.elements.taskScheduleDate?.value || '';
            let deadline = null;
            let nextRunAt = null;

            if (scheduleTime && scheduleDate) {
                // Convert local time to UTC ISO string
                const localDatetime = new Date(`${scheduleDate}T${scheduleTime}:00`);
                deadline = localDatetime.toISOString();
                nextRunAt = deadline;
            } else if (scheduleDate) {
                const localDatetime = new Date(`${scheduleDate}T00:00:00`);
                deadline = localDatetime.toISOString();
                nextRunAt = deadline;
            }

            // Gather repeat
            const repeat = this.elements.taskRepeat?.value || 'none';
            let customInterval = null;
            if (repeat === 'custom') {
                customInterval = {
                    value: parseInt(this.elements.customIntervalValue?.value) || 1,
                    unit: this.elements.customIntervalUnit?.value || 'hours'
                };
            }

            // Tags
            const rawTags = this.elements.taskTagsInput?.value || '';
            const tagsArray = rawTags.split(',').map(t => t.trim()).filter(t => t);

            // Build metadata
            const metadata = {
                source: 'pwa',
                tools: tools,
                custom_instructions: this.elements.taskInstructions?.value.trim() || null,
                repeat: repeat !== 'none' ? repeat : null,
                custom_interval: customInterval,
                next_run_at: nextRunAt,
                user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                tz_offset_minutes: -new Date().getTimezoneOffset()
            };

            const taskId = crypto.randomUUID();

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
                metadata: metadata
            };

            const { error } = await supabase
                .from('tasks')
                .insert([newTask])
                .select();

            if (error) throw error;

            this.showNotification('Task created — AI will process it', 'success');
            this.closeNewTaskModal();
            await this.fetchTasks();

        } catch (err) {
            console.error('Error creating task:', err);
            this.showNotification('Failed to create task: ' + err.message, 'error');
        }
    }

    // ================================================================
    // CARD GRID RENDERING
    // ================================================================

    renderTasks() {
        if (!this.elements.taskGrid) return;
        this.elements.taskGrid.innerHTML = '';

        if (this.tasks.length === 0) {
            this.elements.emptyState?.classList.remove('hidden');
            return;
        }

        this.elements.emptyState?.classList.add('hidden');

        this.tasks.forEach((task, index) => {
            const card = this.createTaskCard(task, index);
            this.elements.taskGrid.appendChild(card);
        });
    }

    createTaskCard(task, index) {
        const card = document.createElement('div');
        card.className = `task-card${task.status === 'completed' ? ' completed' : ''}`;
        card.style.animationDelay = `${index * 55}ms`;
        card.dataset.id = task.id;

        // Click card to open detail
        card.addEventListener('click', (e) => {
            if (e.target.closest('.task-card-action-btn')) return;
            this.openDetailModal(task);
        });

        // Priority dot + Title
        const header = document.createElement('div');
        header.className = 'task-card-header';

        const dot = document.createElement('div');
        dot.className = `task-card-priority-dot ${task.priority || 'medium'}`;
        header.appendChild(dot);

        const title = document.createElement('div');
        title.className = 'task-card-title';
        title.textContent = task.text;
        header.appendChild(title);

        card.appendChild(header);

        // Status badge
        const statusBadge = document.createElement('div');
        statusBadge.className = `task-card-status ${task.status || 'pending'}`;
        statusBadge.textContent = this.formatStatus(task.status);
        card.appendChild(statusBadge);

        // Description (2-line clamp)
        if (task.description) {
            const desc = document.createElement('div');
            desc.className = 'task-card-desc';
            desc.textContent = task.description;
            card.appendChild(desc);
        }

        // Schedule badge
        const schedule = this.getScheduleDisplay(task);
        if (schedule) {
            const schedBadge = document.createElement('div');
            schedBadge.className = 'task-card-schedule';
            schedBadge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${schedule}`;
            card.appendChild(schedBadge);
        }

        // Tool badges
        const tools = task.metadata?.tools;
        if (tools && tools.length > 0) {
            const toolsDiv = document.createElement('div');
            toolsDiv.className = 'task-card-tools';
            tools.forEach(tool => {
                const badge = document.createElement('span');
                badge.className = 'task-card-tool-badge';
                badge.textContent = this.formatToolName(tool);
                toolsDiv.appendChild(badge);
            });
            card.appendChild(toolsDiv);
        }

        // Action buttons (hover reveal on desktop, always on mobile)
        const actions = document.createElement('div');
        actions.className = 'task-card-actions';

        // View output (only if has task_work)
        if (task.task_work && task.task_work.trim().length > 0) {
            const viewBtn = document.createElement('button');
            viewBtn.className = 'task-card-action-btn view-output';
            viewBtn.title = 'View Output';
            viewBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
            viewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openOutputPanel(task);
            });
            actions.appendChild(viewBtn);
        }

        // Complete toggle
        const completeBtn = document.createElement('button');
        completeBtn.className = `task-card-action-btn complete-toggle${task.status === 'completed' ? ' is-completed' : ''}`;
        completeBtn.title = task.status === 'completed' ? 'Mark Pending' : 'Mark Complete';
        completeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        completeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleTaskCompletion(task.id, task.status !== 'completed');
        });
        actions.appendChild(completeBtn);

        // Delete
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'task-card-action-btn delete';
        deleteBtn.title = 'Delete';
        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteTask(task.id);
        });
        actions.appendChild(deleteBtn);

        card.appendChild(actions);

        return card;
    }

    // ================================================================
    // OUTPUT PANEL
    // ================================================================

    openOutputPanel(task) {
        this.currentOutputTask = task;

        // Set title
        if (this.elements.outputTitle) {
            this.elements.outputTitle.textContent = task.text;
        }

        // Set meta
        if (this.elements.outputMeta) {
            let metaHtml = '';
            metaHtml += `<span class="task-output-meta-badge">${this.formatStatus(task.status)}</span>`;
            if (task.deadline) {
                metaHtml += `<span class="task-output-meta-badge">${new Date(task.deadline).toLocaleString()}</span>`;
            }
            const tools = task.metadata?.tools;
            if (tools && tools.length > 0) {
                tools.forEach(t => {
                    metaHtml += `<span class="task-output-meta-badge">${this.formatToolName(t)}</span>`;
                });
            }
            this.elements.outputMeta.innerHTML = metaHtml;
        }

        // Parse and render content
        if (this.elements.outputContent) {
            const content = task.task_work || '';
            if (typeof marked !== 'undefined') {
                this.elements.outputContent.innerHTML = marked.parse(content);
                // Highlight code
                if (typeof hljs !== 'undefined') {
                    this.elements.outputContent.querySelectorAll('pre code').forEach(block => {
                        hljs.highlightElement(block);
                    });
                }
            } else {
                this.elements.outputContent.textContent = content;
            }
        }

        // Show
        this.elements.outputBackdrop?.classList.remove('hidden');
        this.elements.outputPanel?.classList.remove('hidden');
    }

    closeOutputPanel() {
        this.elements.outputBackdrop?.classList.add('hidden');
        this.elements.outputPanel?.classList.add('hidden');
        this.currentOutputTask = null;
    }

    downloadOutput() {
        if (!this.currentOutputTask) return;
        const task = this.currentOutputTask;

        // Build markdown content
        const sanitizedTitle = task.text.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');
        let mdContent = `# ${task.text}\n\n`;
        mdContent += `**Status:** ${this.formatStatus(task.status)}\n`;
        if (task.deadline) mdContent += `**Schedule:** ${new Date(task.deadline).toLocaleString()}\n`;
        const tools = task.metadata?.tools;
        if (tools && tools.length > 0) mdContent += `**Tools:** ${tools.map(t => this.formatToolName(t)).join(', ')}\n`;
        mdContent += `**Generated:** ${new Date().toLocaleString()}\n\n---\n\n`;
        mdContent += task.task_work || '';

        const blob = new Blob([mdContent], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sanitizedTitle || 'task_output'}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ================================================================
    // TASK DETAIL MODAL (COMPACT)
    // ================================================================

    openDetailModal(task) {
        if (!this.elements.detailModal || !this.elements.detailBody) return;

        if (this.elements.detailTitle) {
            this.elements.detailTitle.textContent = task.text;
        }

        let rows = '';

        // Status + Priority row
        rows += this.detailRow('Status', `<span class="task-card-status ${task.status}">${this.formatStatus(task.status)}</span>`);
        rows += this.detailRow('Priority', this.capitalize(task.priority || 'medium'));

        // Description
        if (task.description) {
            rows += this.detailRow('Desc', this.escapeHtml(task.description));
        }

        // Schedule
        if (task.deadline) {
            rows += this.detailRow('Schedule', new Date(task.deadline).toLocaleString());
        }

        // Repeat
        const repeat = task.metadata?.repeat;
        if (repeat) {
            let repeatText = this.capitalize(repeat);
            if (repeat === 'custom' && task.metadata?.custom_interval) {
                const ci = task.metadata.custom_interval;
                repeatText = `Every ${ci.value} ${ci.unit}`;
            }
            rows += this.detailRow('Repeat', repeatText);
        }

        // Tools
        const tools = task.metadata?.tools;
        if (tools && tools.length > 0) {
            rows += this.detailRow('Tools', tools.map(t => this.formatToolName(t)).join(', '));
        }

        // Instructions
        if (task.metadata?.custom_instructions) {
            rows += this.detailRow('Instruct', this.escapeHtml(task.metadata.custom_instructions));
        }

        // Tags
        if (task.tags && task.tags.length > 0) {
            rows += this.detailRow('Tags', task.tags.join(', '));
        }

        // Timezone
        if (task.metadata?.user_timezone) {
            rows += this.detailRow('TZ', task.metadata.user_timezone);
        }

        // Created
        rows += this.detailRow('Created', new Date(task.created_at).toLocaleString());

        this.elements.detailBody.innerHTML = rows;
        this.elements.detailModal.classList.remove('hidden');
    }

    closeDetailModal() {
        this.elements.detailModal?.classList.add('hidden');
    }

    detailRow(label, value) {
        return `<div class="task-detail-row"><div class="task-detail-label">${label}</div><div class="task-detail-value">${value}</div></div>`;
    }

    // ================================================================
    // TASK ACTIONS
    // ================================================================

    async toggleTaskCompletion(taskId, markComplete) {
        const newStatus = markComplete ? 'completed' : 'pending';
        const completedAt = markComplete ? new Date().toISOString() : null;

        try {
            const { error } = await supabase
                .from('tasks')
                .update({ status: newStatus, completed_at: completedAt })
                .eq('id', taskId);

            if (error) throw error;

            const task = this.tasks.find(t => t.id === taskId);
            if (task) {
                task.status = newStatus;
                this.renderTasks();
            }
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
        } catch (err) {
            console.error('Error deleting task:', err);
            this.showNotification('Failed to delete task', 'error');
        }
    }

    // ================================================================
    // HELPERS
    // ================================================================

    formatStatus(status) {
        const map = {
            pending: 'Pending',
            in_progress: 'Processing',
            completed: 'Completed'
        };
        return map[status] || 'Pending';
    }

    formatToolName(tool) {
        const map = {
            internet_search: 'Web Search',
            browser: 'Browser',
            email: 'Email',
            google_drive: 'Drive',
            google_sheets: 'Sheets',
            github: 'GitHub'
        };
        return map[tool] || tool;
    }

    getScheduleDisplay(task) {
        const deadline = task.deadline;
        const nextRun = task.metadata?.next_run_at;
        const target = nextRun || deadline;
        if (!target) return null;

        try {
            const d = new Date(target);
            const now = new Date();
            const diffMs = d - now;

            // If in the past, show date
            if (diffMs < 0) {
                return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            }

            // If within 24 hours
            if (diffMs < 86400000) {
                return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            }

            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch {
            return null;
        }
    }

    capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
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
}
