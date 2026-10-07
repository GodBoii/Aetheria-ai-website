// js/welcome-display.js
// Lightweight welcome message controller for the PWA with pills & expanded context panels (No Carousel version)

import UserProfileService from './user-profile-service.js';
import {
  PRESENTATION_TEMPLATES,
  getSelectedPresentationTemplate,
  setSelectedPresentationTemplate,
  clearSelectedPresentationTemplate
} from './presentation-templates.js';
import { supabase } from './supabase-client.js';

const PILL_CONFIG = [
  { key: 'templates', icon: 'fa-solid fa-wand-magic-sparkles', label: 'Create slides' },
  { key: 'website', icon: 'fa-solid fa-window-maximize', label: 'Build website' },
  { key: 'sessions', icon: 'fa-solid fa-clock-rotate-left', label: 'Past Chats' },
  { key: 'tasks', icon: 'fa-solid fa-list-check', label: 'Tasks' },
  { key: 'design', icon: 'fa-solid fa-swatchbook', label: 'Design' }
];

const WEBSITE_PROMPTS = [
  { title: "SaaS Landing Page", desc: "Clean layout with pricing tiers & features grid.", prompt: "Create a SaaS landing page with a hero section, pricing table, and testimonials.", icon: "fa-solid fa-rocket" },
  { title: "Portfolio Website", desc: "Premium dark-mode developer/designer showcase.", prompt: "Build a developer portfolio website with dynamic animations and project showcases.", icon: "fa-solid fa-briefcase" },
  { title: "E-commerce Catalog", desc: "Grid-based store view with filter panels.", prompt: "Build an e-commerce catalog page with product grids and category filter sidebar.", icon: "fa-solid fa-shopping-bag" }
];

const DESIGN_PROMPTS = [
  { title: "Glassmorphism UI", desc: "Sleek card styles with frosted glass effects.", prompt: "Design a dashboard widget showing weather data with glassmorphism frosted styling.", icon: "fa-solid fa-glass-water" },
  { title: "Vibrant Gradient", desc: "Dynamic color-rich backgrounds and badges.", prompt: "Create a web panel using vibrant gradients, smooth glow outlines, and card containers.", icon: "fa-solid fa-palette" },
  { title: "Minimal Strategy", desc: "Editorial layouts focusing on text and breathing room.", prompt: "Build a minimal zen blog post layout with spacious typography and accent lines.", icon: "fa-solid fa-feather" }
];

class WelcomeDisplay {
  constructor({
    element = null,
    containerSelector = '.welcome-container',
    messageContainer = null,
    messageContainerSelector = '#chat-messages',
  } = {}) {
    this.initialized = false;
    this.isVisible = false;
    this.hiddenByFloatingWindow = false;
    this.username = 'there';

    this.element = element;
    this.containerSelector = containerSelector;
    this.messageContainer = messageContainer;
    this.messageContainerSelector = messageContainerSelector;

    this.userProfileService = new UserProfileService();

    this.onMessageAdded = this.updateDisplay.bind(this);
    this.onConversationCleared = this.handleConversationCleared.bind(this);

    this.activePillKey = null;
  }

  initialize() {
    if (this.initialized) return;

    this.ensureElement();
    this.ensureMessageContainer();
    this.createPillsElements();
    this.bindEvents();

    this.initialized = true;

    void this.refreshUsername();
    requestAnimationFrame(() => this.updateDisplay());
    console.log('WelcomeDisplay initialized.');
  }

  ensureElement() {
    if (this.element && this.element instanceof HTMLElement) {
      this.element.classList.add('welcome-container');
      return;
    }

    const existing = document.querySelector(this.containerSelector);
    if (existing) {
      this.element = existing;
      return;
    }

    // Create fallback element if markup missing
    const appContainer = document.querySelector('.app-container') || document.body;
    const wrapper = document.createElement('div');
    wrapper.className = 'welcome-container hidden';
    wrapper.setAttribute('role', 'banner');
    wrapper.setAttribute('aria-live', 'polite');

    wrapper.innerHTML = `
      <div class="welcome-content">
        <h1 class="welcome-heading">Hello there</h1>
        <h2 class="welcome-secondary-heading">What can I do for you?</h2>
      </div>
    `;

    appContainer.appendChild(wrapper);
    this.element = wrapper;
  }

  ensureMessageContainer() {
    if (this.messageContainer && this.messageContainer instanceof HTMLElement) {
      return;
    }
    this.messageContainer = document.querySelector(this.messageContainerSelector);
  }

  createPillsElements() {
    if (this.element.querySelector('.home-pills-container')) return;

    // Create pills container
    const pillsContainer = document.createElement('div');
    pillsContainer.className = 'home-pills-container';
    
    // Populate pills
    pillsContainer.innerHTML = PILL_CONFIG.map(pill => `
      <button class="home-pill" data-pill-key="${pill.key}">
        <i class="${pill.icon}"></i>
        <span>${pill.label}</span>
      </button>
    `).join('');

    // Create expanded panel
    const contentPanel = document.createElement('div');
    contentPanel.className = 'home-pill-content-panel hidden';
    contentPanel.innerHTML = `
      <div class="home-pill-content-header">
        <button class="close-pill-content-btn">
          <i class="fas fa-arrow-left"></i> Back
        </button>
        <span class="home-pill-content-title"></span>
      </div>
      <div class="home-pill-content-body"></div>
    `;

    this.element.appendChild(pillsContainer);
    this.element.appendChild(contentPanel);

    // Bind click events on pills
    pillsContainer.querySelectorAll('.home-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.pillKey;
        this.onPillClick(key);
      });
    });

    // Bind back button click
    contentPanel.querySelector('.close-pill-content-btn').addEventListener('click', () => {
      this.closeActivePill();
    });
  }

  bindEvents() {
    document.addEventListener('messageAdded', this.onMessageAdded);
    document.addEventListener('conversationCleared', this.onConversationCleared);
    
    // Listen for template selection event to synchronize badge state
    window.addEventListener('presentation-template:selected', (e) => {
      const selected = e.detail?.template;
      const templatesList = this.element.querySelector('.templates-scroller');
      if (templatesList) {
        templatesList.querySelectorAll('.ppt-template-card').forEach(card => {
          const isSelected = selected && card.dataset.templateId === selected.id;
          card.classList.toggle('selected', isSelected);
          const badge = card.querySelector('.selected-check-badge');
          if (badge) badge.style.display = isSelected ? 'flex' : 'none';
        });
      }
    });
  }

  async refreshUsername() {
    try {
      const name = await this.userProfileService.getUserName();
      this.updateUsername(name);
    } catch (error) {
      console.warn('WelcomeDisplay: failed to fetch username', error);
      this.updateUsername('there');
    }
  }

  updateUsername(name) {
    this.username = name || 'there';
    const heading = this.element?.querySelector('.welcome-heading');
    if (heading) {
      heading.textContent = `Hello ${this.username}`;
    }
  }

  onPillClick(key) {
    if (this.activePillKey === key) {
      this.closeActivePill();
      return;
    }

    this.activePillKey = key;

    // Toggle active classes on pill buttons
    this.element.querySelectorAll('.home-pill').forEach(btn => {
      const isActive = btn.dataset.pillKey === key;
      btn.classList.toggle('active', isActive);
    });

    // Render expanded contents
    this.renderPillContent(key);

    // Show panel
    const panel = this.element.querySelector('.home-pill-content-panel');
    if (panel) {
      panel.classList.remove('hidden');
      panel.classList.add('visible');
    }

    // Hide welcome content and pills row using panel-active container class
    this.element.classList.add('panel-active');
  }

  closeActivePill() {
    this.activePillKey = null;
    
    // Clear active classes
    this.element.querySelectorAll('.home-pill').forEach(btn => btn.classList.remove('active'));

    // Hide panel
    const panel = this.element.querySelector('.home-pill-content-panel');
    if (panel) {
      panel.classList.remove('visible');
      panel.classList.add('hidden');
    }

    // Restore welcome content and pills row by removing panel-active class
    this.element.classList.remove('panel-active');
  }

  renderPillContent(key) {
    const panel = this.element.querySelector('.home-pill-content-panel');
    if (!panel) return;
    const titleSpan = panel.querySelector('.home-pill-content-title');
    const body = panel.querySelector('.home-pill-content-body');

    const config = PILL_CONFIG.find(p => p.key === key);
    titleSpan.textContent = config ? config.label : '';
    body.innerHTML = ''; // Clear

    if (key === 'templates') {
      this.renderTemplatesPill(body);
    } else if (key === 'website') {
      this.renderPromptStarterGrid(body, WEBSITE_PROMPTS);
    } else if (key === 'design') {
      this.renderPromptStarterGrid(body, DESIGN_PROMPTS);
    } else if (key === 'sessions') {
      this.renderSessionsPill(body);
    } else if (key === 'tasks') {
      this.renderTasksPill(body);
    }
  }

  renderTemplatesPill(container) {
    const scroller = document.createElement('div');
    scroller.className = 'templates-scroller';

    const selected = getSelectedPresentationTemplate();

    Object.values(PRESENTATION_TEMPLATES).forEach(tpl => {
      const card = document.createElement('div');
      card.className = `ppt-template-card ${selected && selected.id === tpl.id ? 'selected' : ''}`;
      card.dataset.templateId = tpl.id;

      card.innerHTML = `
        <div class="selected-check-badge" style="display: ${selected && selected.id === tpl.id ? 'flex' : 'none'};">
          <i class="fas fa-check"></i>
        </div>
        <div class="ppt-template-card-header">
          <span class="ppt-template-name">${tpl.name}</span>
          <button class="template-preview-btn" title="Preview Slides">
            <i class="fas fa-eye"></i>
          </button>
        </div>
        <p class="ppt-template-desc">${tpl.description}</p>
        <div class="ppt-template-color-row">
          <span class="color-dot" style="background: ${tpl.colors.accent};" title="Accent"></span>
          <span class="color-dot" style="background: ${tpl.colors.accent2};" title="Accent 2"></span>
          <span class="color-dot" style="background: ${tpl.colors.accent3};" title="Accent 3"></span>
        </div>
      `;

      // Eyeball preview handler
      card.querySelector('.template-preview-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openTemplatePreview(tpl.id);
      });

      // Card selection handler
      card.addEventListener('click', () => {
        if (card.classList.contains('selected')) {
          clearSelectedPresentationTemplate();
        } else {
          setSelectedPresentationTemplate(tpl.id);
        }
      });

      scroller.appendChild(card);
    });

    container.appendChild(scroller);

    // Add scrolling arrows if container overflow
    this.setupHorizontalScrollControls(scroller, container);
  }

  setupHorizontalScrollControls(scroller, container) {
    const prevBtn = document.createElement('button');
    prevBtn.className = 'scroller-arrow-btn scroller-arrow-left hidden';
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'scroller-arrow-btn scroller-arrow-right';
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';

    container.style.position = 'relative';
    container.appendChild(prevBtn);
    container.appendChild(nextBtn);

    const updateArrows = () => {
      const scrollLeft = scroller.scrollLeft;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      
      prevBtn.classList.toggle('hidden', scrollLeft <= 5);
      nextBtn.classList.toggle('hidden', scrollLeft >= maxScroll - 5);
    };

    scroller.addEventListener('scroll', updateArrows);
    window.addEventListener('resize', updateArrows);

    prevBtn.addEventListener('click', () => {
      scroller.scrollBy({ left: -200, behavior: 'smooth' });
    });
    nextBtn.addEventListener('click', () => {
      scroller.scrollBy({ left: 200, behavior: 'smooth' });
    });

    // Trigger check
    setTimeout(updateArrows, 100);
  }

  renderPromptStarterGrid(container, prompts) {
    const grid = document.createElement('div');
    grid.className = 'prompts-grid';

    prompts.forEach(p => {
      const card = document.createElement('div');
      card.className = 'prompt-starter-card';
      card.innerHTML = `
        <div class="prompt-starter-icon">
          <i class="${p.icon}"></i>
        </div>
        <div class="prompt-starter-text">
          <span class="prompt-starter-title">${p.title}</span>
          <p class="prompt-starter-desc">${p.desc}</p>
        </div>
      `;

      card.addEventListener('click', () => {
        const input = document.getElementById('floating-input');
        if (input) {
          input.value = p.prompt;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
          this.closeActivePill();
        }
      });

      grid.appendChild(card);
    });

    container.appendChild(grid);
  }

  async renderSessionsPill(container) {
    const loader = document.createElement('div');
    loader.className = 'pill-loading-state';
    loader.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Loading chats...</span>';
    container.appendChild(loader);

    try {
      const sessions = await this.fetchRecentSessions();
      loader.remove();

      if (sessions.length === 0) {
        container.innerHTML = `
          <div class="pill-empty-state">
            <i class="fas fa-comments"></i>
            <p>No recent past chats found</p>
          </div>
        `;
        return;
      }

      const list = document.createElement('div');
      list.className = 'sessions-pill-list';

      sessions.forEach(session => {
        const item = document.createElement('div');
        item.className = 'session-pill-item';
        item.innerHTML = `
          <i class="fa-solid fa-message"></i>
          <span class="session-pill-title">${session.title}</span>
          <i class="fas fa-chevron-right arrow"></i>
        `;

        item.addEventListener('click', () => {
          if (window.contextHandler) {
            // Push to contextHandler.loadedSessions if not present so showSessionDetails doesn't fail
            const exists = window.contextHandler.loadedSessions.find(s => s.session_id === session.session_id);
            if (!exists) {
              window.contextHandler.loadedSessions.push({
                session_id: session.session_id,
                title: session.title,
                created_at: Math.floor(Date.now() / 1000),
                runs: []
              });
            }
            window.contextHandler.showSessionDetails(session.session_id);
          }
        });

        list.appendChild(item);
      });

      container.appendChild(list);
    } catch (e) {
      console.error(e);
      loader.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span>Failed to load chats</span>';
    }
  }

  async fetchRecentSessions() {
    const { data: authData } = await supabase.auth.getSession();
    const session = authData?.session;
    if (!session) return [];
    const userId = session.user.id;

    // Get recent 6 sessions
    const { data: sessionRows, error } = await supabase
      .from('agno_sessions')
      .select('session_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(6);

    if (error) throw error;
    if (!sessionRows || sessionRows.length === 0) return [];

    const sessionIds = sessionRows.map(row => row.session_id);
    const { data: titlesData, error: titlesError } = await supabase
      .from('session_titles')
      .select('session_id, tittle')
      .eq('user_id', userId)
      .in('session_id', sessionIds);

    if (titlesError) {
      console.warn('Failed to load session titles in pills', titlesError);
    }

    const titlesMap = new Map((titlesData || []).map(t => [t.session_id, t.tittle]));

    return sessionRows.map(row => ({
      session_id: row.session_id,
      title: titlesMap.get(row.session_id) || `Chat ${row.session_id.substring(0, 8)}...`
    }));
  }

  renderTasksPill(container) {
    if (!window.todo) {
      container.innerHTML = `
        <div class="pill-loading-state">
          <i class="fas fa-spinner fa-spin"></i>
          <span>Deferred modules loading...</span>
        </div>
      `;
      // Check again after 1s
      setTimeout(() => this.renderPillContent('tasks'), 1000);
      return;
    }

    const tasksList = window.todo.tasks || [];
    const recentTasks = tasksList.slice(0, 3);

    if (recentTasks.length === 0) {
      container.innerHTML = `
        <div class="pill-empty-state">
          <i class="fas fa-clipboard-check"></i>
          <p>No active tasks found</p>
          <button class="home-tasks-btn">
            <i class="fas fa-plus"></i> Open Tasks Panel
          </button>
        </div>
      `;
      container.querySelector('.home-tasks-btn').addEventListener('click', () => {
        window.todo.toggleWindow(true);
      });
      return;
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'tasks-pill-list';

    recentTasks.forEach(task => {
      const isCompleted = task.status === 'completed';
      const item = document.createElement('div');
      item.className = `task-pill-item ${isCompleted ? 'completed' : ''}`;
      item.dataset.priority = task.priority || 'medium';

      item.innerHTML = `
        <div class="checkbox-wrapper">
          <input type="checkbox" id="pill-task-${task.id}" ${isCompleted ? 'checked' : ''}>
          <label class="checkmark" for="pill-task-${task.id}">
            <i class="fas fa-check"></i>
          </label>
        </div>
        <div class="task-pill-text-content">
          <span class="task-pill-title-text">${task.text}</span>
          ${task.description ? `<p class="task-pill-desc-text">${task.description}</p>` : ''}
        </div>
        <i class="fas fa-chevron-down toggle-accordion-icon"></i>
        <div class="task-pill-details hidden">
          ${task.deadline ? `<span class="deadline"><i class="fas fa-clock"></i> ${new Date(task.deadline).toLocaleDateString()}</span>` : ''}
          ${task.tags && task.tags.length > 0 ? `<div class="tags">${task.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
        </div>
      `;

      // Checkbox click
      const cb = item.querySelector('input');
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        window.todo.toggleTaskCompletion(task.id, cb.checked);
        item.classList.toggle('completed', cb.checked);
      });

      // Accordion click
      item.addEventListener('click', (e) => {
        if (e.target.closest('.checkbox-wrapper')) return;
        const details = item.querySelector('.task-pill-details');
        const icon = item.querySelector('.toggle-accordion-icon');
        if (details) {
          const isHidden = details.classList.contains('hidden');
          details.classList.toggle('hidden', !isHidden);
          icon.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
        }
      });

      listDiv.appendChild(item);
    });

    const openBtn = document.createElement('button');
    openBtn.className = 'home-tasks-btn';
    openBtn.innerHTML = '<i class="fas fa-tasks"></i> Open Tasks Panel';
    openBtn.addEventListener('click', () => {
      window.todo.toggleWindow(true);
    });

    container.appendChild(listDiv);
    container.appendChild(openBtn);
  }

  openTemplatePreview(templateId) {
    const template = PRESENTATION_TEMPLATES[templateId];
    if (!template) return;

    let previewModal = document.getElementById('ppt-template-preview-modal');
    if (!previewModal) {
      previewModal = document.createElement('div');
      previewModal.id = 'ppt-template-preview-modal';
      previewModal.className = 'modal-overlay hidden';
      previewModal.innerHTML = `
        <div class="ppt-preview-modal-panel">
          <div class="ppt-preview-modal-header">
            <h3>Template Preview: ${template.name}</h3>
            <button class="close-ppt-preview-btn">×</button>
          </div>
          <div class="ppt-preview-modal-body"></div>
        </div>
      `;
      document.body.appendChild(previewModal);

      previewModal.querySelector('.close-ppt-preview-btn').addEventListener('click', () => {
        previewModal.classList.add('hidden');
      });
      previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) previewModal.classList.add('hidden');
      });
    } else {
      previewModal.querySelector('h3').textContent = `Template Preview: ${template.name}`;
    }

    const modalBody = previewModal.querySelector('.ppt-preview-modal-body');
    modalBody.innerHTML = ''; // Clear

    // Visual layouts definitions
    const layouts = [
      {
        title: "Introduction to Mobile AI",
        type: "cover",
        subtitle: "Aetheria Platform Strategy",
        metrics: [
          { value: "01", label: "Executive Summary" },
          { value: "02", label: "Market Architecture" },
          { value: "03", label: "Operational Roadmap" }
        ]
      },
      {
        title: "Key Infrastructure Comparison",
        type: "two_column",
        left: { title: "Legacy Stack", bullets: ["Monolithic services", "Manual DB migrations", "Delayed messages"] },
        right: { title: "Aetheria Platform", bullets: ["Serverless execution", "Automated Supabase sync", "Low-latency sockets"] }
      },
      {
        title: "Core Platform Metrics",
        type: "metrics",
        metrics: [
          { value: "98.7%", label: "Accuracy Index" },
          { value: "40ms", label: "Response Latency" },
          { value: "5.8x", label: "Operational Boost" }
        ]
      }
    ];

    const colors = template.colors;
    const styleString = `
      --ppt-bg: ${colors.bg};
      --ppt-surface: ${colors.surface};
      --ppt-ink: ${colors.ink};
      --ppt-muted: ${colors.muted};
      --ppt-accent: ${colors.accent};
      --ppt-accent2: ${colors.accent2};
      --ppt-accent3: ${colors.accent3};
    `;

    layouts.forEach(slide => {
      const slideDiv = document.createElement('div');
      slideDiv.className = 'mini-slide-preview';
      slideDiv.style.cssText = styleString;

      if (slide.type === 'cover') {
        slideDiv.innerHTML = `
          <div class="mini-slide-accent-line" style="background: var(--ppt-accent);"></div>
          <div class="mini-slide-cover-layout">
            <div class="mini-slide-cover-left">
              <span class="mini-slide-kicker" style="color: var(--ppt-accent2);">Cover Layout</span>
              <h4 class="mini-slide-title" style="color: var(--ppt-ink);">${slide.title}</h4>
              <p class="mini-slide-subtitle" style="color: var(--ppt-muted);">${slide.subtitle}</p>
              <div class="mini-slide-cover-metrics">
                ${slide.metrics.map(m => `
                  <div class="mini-slide-cover-metric-item" style="border-left: 2px solid var(--ppt-accent);">
                    <span style="color: var(--ppt-accent);">${m.value}</span>
                    <span style="color: var(--ppt-muted);">${m.label}</span>
                  </div>
                `).join('')}
              </div>
            </div>
            <div class="mini-slide-cover-right" style="border: 1px solid var(--ppt-accent); background: var(--ppt-surface);">
              <div class="mini-slide-abstract-shape" style="background: var(--ppt-accent); opacity: 0.15;"></div>
              <div class="mini-slide-abstract-dot" style="background: var(--ppt-accent2);"></div>
              <div class="mini-slide-abstract-dot2" style="background: var(--ppt-accent3);"></div>
            </div>
          </div>
        `;
      } else if (slide.type === 'two_column') {
        slideDiv.innerHTML = `
          <div class="mini-slide-accent-line" style="background: var(--ppt-accent);"></div>
          <span class="mini-slide-kicker" style="color: var(--ppt-accent3);">Two Column Layout</span>
          <h4 class="mini-slide-title" style="color: var(--ppt-ink);">${slide.title}</h4>
          <div class="mini-slide-two-col-layout">
            <div class="mini-slide-col" style="border: 1px solid rgba(0,0,0,0.1); background: var(--ppt-surface);">
              <div class="mini-slide-col-header" style="background: var(--ppt-accent); color: #fff;">${slide.left.title}</div>
              <ul class="mini-slide-col-bullets" style="color: var(--ppt-ink);">
                ${slide.left.bullets.map(b => `<li><span class="dot" style="background: var(--ppt-accent);"></span>${b}</li>`).join('')}
              </ul>
            </div>
            <div class="mini-slide-col" style="border: 1px solid rgba(0,0,0,0.1); background: var(--ppt-surface);">
              <div class="mini-slide-col-header" style="background: var(--ppt-accent2); color: #fff;">${slide.right.title}</div>
              <ul class="mini-slide-col-bullets" style="color: var(--ppt-ink);">
                ${slide.right.bullets.map(b => `<li><span class="dot" style="background: var(--ppt-accent2);"></span>${b}</li>`).join('')}
              </ul>
            </div>
          </div>
        `;
      } else if (slide.type === 'metrics') {
        slideDiv.innerHTML = `
          <div class="mini-slide-accent-line" style="background: var(--ppt-accent);"></div>
          <span class="mini-slide-kicker" style="color: var(--ppt-accent);">Metrics Layout</span>
          <h4 class="mini-slide-title" style="color: var(--ppt-ink);">${slide.title}</h4>
          <div class="mini-slide-metrics-layout">
            ${slide.metrics.map(m => `
              <div class="mini-slide-metric-card" style="background: var(--ppt-surface); border: 1px solid rgba(0,0,0,0.08);">
                <div class="mini-slide-metric-value" style="color: var(--ppt-accent);">${m.value}</div>
                <div class="mini-slide-metric-label" style="color: var(--ppt-muted);">${m.label}</div>
              </div>
            `).join('')}
          </div>
        `;
      }

      modalBody.appendChild(slideDiv);
    });

    previewModal.classList.remove('hidden');
  }

  handleConversationCleared() {
    this.hiddenByFloatingWindow = false;
    requestAnimationFrame(() => this.updateDisplay());
  }

  shouldShow() {
    if (!this.messageContainer) return true;
    return this.messageContainer.children.length === 0;
  }

  updateDisplay() {
    if (!this.element) return;
    if (this.hiddenByFloatingWindow) {
      this.hide();
      return;
    }

    if (this.shouldShow()) {
      this.show();
    } else {
      this.hide();
    }
  }

  show() {
    if (!this.element || this.isVisible) return;
    this.element.classList.remove('hidden');
    this.element.classList.add('visible');
    this.isVisible = true;
  }

  hide() {
    if (!this.element || !this.isVisible) return;
    this.element.classList.remove('visible');
    this.element.classList.add('hidden');
    this.isVisible = false;
    this.closeActivePill();
  }

  hideForFloatingWindow() {
    this.hiddenByFloatingWindow = true;
    this.hide();
  }

  showAfterFloatingWindow() {
    this.hiddenByFloatingWindow = false;
    this.updateDisplay();
  }

  destroy() {
    document.removeEventListener('messageAdded', this.onMessageAdded);
    document.removeEventListener('conversationCleared', this.onConversationCleared);
    this.initialized = false;
  }
}

export default WelcomeDisplay;
