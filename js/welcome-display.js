// js/welcome-display.js
// Welcome message + (on desktop only) pills/carousel/templates rail
// Mirrors the AI-OS desktop app while preserving the existing mobile UI.

import UserProfileService from './user-profile-service.js';
import {
  PRESENTATION_TEMPLATES,
  clearSelectedPresentationTemplate,
  getSelectedPresentationTemplate,
  setSelectedPresentationTemplate
} from './presentation-templates.js';

/* ═══════════════════════════════════════════════════════════════════
   PILL CONFIGURATION
   ═══════════════════════════════════════════════════════════════════ */
const PILL_CONFIG = [
  { key: 'templates', icon: 'fa-solid fa-wand-magic-sparkles', label: 'Create slides' },
  { key: 'website', icon: 'fa-solid fa-window-maximize', label: 'Build website' },
  { key: 'sessions', icon: 'fa-solid fa-clock-rotate-left', label: 'Past Chats' },
  { key: 'tasks', icon: 'fa-solid fa-list-check', label: 'Tasks' },
  { key: 'design', icon: 'fa-solid fa-swatchbook', label: 'Design' }
];

const CAROUSEL_SLIDES = [
  {
    title: 'Create Presentations',
    desc: 'Design stunning slide decks with professional templates and AI-powered content generation.',
    image: '/assets/stock1.png'
  },
  {
    title: 'Build & Deploy',
    desc: 'Full-stack web development with live preview and one-click deployment to production.',
    image: '/assets/stock3_rocket.png'
  },
  {
    title: 'Compute Anywhere',
    desc: 'Run code, automate browsers, and orchestrate agents from a single workspace.',
    image: '/assets/stock5_sandbox.png'
  },
  {
    title: 'Coder Workspace',
    desc: 'Write, debug, and ship code with an integrated cloud development environment.',
    image: '/assets/stock2_github.png'
  }
];

const WEBSITE_PROMPTS = [
  { icon: 'fa-solid fa-window-maximize', title: 'Landing Page', desc: 'Modern responsive landing page', prompt: 'Create a modern, responsive landing page with a hero section, feature highlights, testimonials, and a call-to-action footer.' },
  { icon: 'fa-solid fa-briefcase', title: 'Portfolio', desc: 'Personal portfolio website', prompt: 'Build a personal portfolio website with a project showcase grid, about section, skills display, and contact form.' },
  { icon: 'fa-solid fa-chart-line', title: 'Dashboard', desc: 'Admin analytics dashboard', prompt: 'Design an admin dashboard with interactive charts, data tables, sidebar navigation, and notification center.' },
  { icon: 'fa-solid fa-store', title: 'E-commerce', desc: 'Product catalog with cart', prompt: 'Build a product catalog page with category filters, search functionality, product cards with ratings, and a shopping cart drawer.' }
];

const DESIGN_PROMPTS = [
  { icon: 'fa-solid fa-mobile-screen', title: 'Mobile App UI', desc: 'App interface with navigation', prompt: 'Design a mobile app interface with bottom tab navigation, card-based content layout, and smooth transitions.' },
  { icon: 'fa-solid fa-right-to-bracket', title: 'Auth Flow', desc: 'Login and signup screens', prompt: 'Create a modern authentication flow with login, signup, and forgot password screens using glassmorphism design.' },
  { icon: 'fa-solid fa-sliders', title: 'Settings Page', desc: 'Clean settings with controls', prompt: 'Design a clean settings page with toggle switches, dropdown selectors, and organized preference sections.' },
  { icon: 'fa-solid fa-chart-pie', title: 'Data Visualization', desc: 'Analytics with charts', prompt: 'Create an analytics dashboard with interactive pie charts, line graphs, metric cards, and data filtering controls.' }
];

const CAROUSEL_INTERVAL_MS = 5000;
const DESKTOP_BREAKPOINT = '(min-width: 1024px)';

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

    /* Desktop rail state */
    this.suggestionsWrapper = null;
    this.pillsRow = null;
    this.carouselContainer = null;
    this.pillContentContainer = null;
    this.activePill = null;
    this.carouselIndex = 0;
    this.carouselTimer = null;

    this.recentSessions = [];
    this.recentTasks = [];

    this.desktopMQ = window.matchMedia(DESKTOP_BREAKPOINT);
    this.handleViewportChange = this.handleViewportChange.bind(this);

    this.onMessageAdded = this.handleMessageAdded.bind(this);
    this.onConversationCleared = this.handleConversationCleared.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleTemplateChange = this.handleTemplateChange.bind(this);
  }

  /* ═══════════════════════════════════════════════════════════════
     INITIALIZATION
     ═══════════════════════════════════════════════════════════════ */
  initialize() {
    if (this.initialized) return;

    this.ensureElement();
    this.ensureMessageContainer();

    if (this.isDesktop()) {
      this.createDesktopRail();
    }

    this.bindEvents();
    this.initialized = true;

    void this.refreshUsername();
    void this.loadDynamicData();
    requestAnimationFrame(() => this.updateDisplay());
    console.log('WelcomeDisplay initialized.');
  }

  isDesktop() {
    return this.desktopMQ.matches;
  }

  ensureElement() {
    if (this.element instanceof HTMLElement) {
      this.element.classList.add('welcome-container');
      return;
    }

    const existing = document.querySelector(this.containerSelector);
    if (existing) {
      this.element = existing;
      return;
    }

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
    if (this.messageContainer instanceof HTMLElement) return;
    this.messageContainer = document.querySelector(this.messageContainerSelector);
  }

  /* ═══════════════════════════════════════════════════════════════
     DESKTOP RAIL — pills + carousel + pill content area
     ═══════════════════════════════════════════════════════════════ */
  createDesktopRail() {
    if (this.suggestionsWrapper) return;

    const appContainer = document.querySelector('.app-container') || document.body;

    /* Outer wrapper: pills row + pill content */
    this.suggestionsWrapper = document.createElement('div');
    this.suggestionsWrapper.className = 'home-suggestions-wrapper hidden';
    this.suggestionsWrapper.id = 'home-suggestions-wrapper';
    this.suggestionsWrapper.setAttribute('role', 'complementary');
    this.suggestionsWrapper.setAttribute('aria-label', 'Welcome overview');

    /* Pills */
    this.pillsRow = document.createElement('div');
    this.pillsRow.className = 'home-pills-row';
    PILL_CONFIG.forEach((pill) => {
      const btn = document.createElement('button');
      btn.className = 'home-pill';
      btn.type = 'button';
      btn.dataset.pill = pill.key;
      btn.innerHTML = `<i class="${pill.icon}" aria-hidden="true"></i><span>${pill.label}</span>`;
      btn.addEventListener('click', () => this.onPillClick(pill.key));
      this.pillsRow.appendChild(btn);
    });
    this.suggestionsWrapper.appendChild(this.pillsRow);

    /* Pill content (templates / sessions / etc.) */
    this.pillContentContainer = document.createElement('div');
    this.pillContentContainer.className = 'home-pill-content hidden';
    this.suggestionsWrapper.appendChild(this.pillContentContainer);

    /* Carousel — independent fixed element near the bottom */
    this.carouselContainer = document.createElement('div');
    this.carouselContainer.className = 'home-carousel hidden';
    this.buildCarousel();

    appContainer.appendChild(this.suggestionsWrapper);
    appContainer.appendChild(this.carouselContainer);
  }

  destroyDesktopRail() {
    this.stopCarousel();
    this.suggestionsWrapper?.remove();
    this.carouselContainer?.remove();
    this.suggestionsWrapper = null;
    this.pillsRow = null;
    this.carouselContainer = null;
    this.pillContentContainer = null;
    this.activePill = null;
  }

  /* ── Carousel ──────────────────────────────────────────────── */
  buildCarousel() {
    const slidesHtml = CAROUSEL_SLIDES.map((slide, i) => `
      <div class="carousel-slide ${i === 0 ? 'active' : ''}" data-slide="${i}">
        <div class="carousel-slide-copy">
          <h4>${this.escapeHtml(slide.title)}</h4>
          <p>${this.escapeHtml(slide.desc)}</p>
        </div>
        <div class="carousel-slide-image">
          <img src="${slide.image}" alt="${this.escapeHtml(slide.title)}" onerror="this.style.display='none'" />
        </div>
      </div>
    `).join('');

    const dotsHtml = CAROUSEL_SLIDES.map((_, i) => `
      <button class="carousel-dot ${i === 0 ? 'active' : ''}" data-dot="${i}" type="button" aria-label="Go to slide ${i + 1}"></button>
    `).join('');

    this.carouselContainer.innerHTML = `
      <div class="carousel-track">${slidesHtml}</div>
      <div class="carousel-dots">${dotsHtml}</div>
    `;

    this.carouselContainer.querySelectorAll('.carousel-dot').forEach((dot) => {
      dot.addEventListener('click', () => this.goToSlide(parseInt(dot.dataset.dot, 10)));
    });
  }

  goToSlide(index) {
    if (!this.carouselContainer) return;
    this.carouselIndex = index;
    this.carouselContainer.querySelectorAll('.carousel-slide').forEach((s, i) => s.classList.toggle('active', i === index));
    this.carouselContainer.querySelectorAll('.carousel-dot').forEach((d, i) => d.classList.toggle('active', i === index));
    this.resetCarouselTimer();
  }

  startCarousel() {
    if (!this.carouselContainer || this.carouselTimer) return;
    this.carouselTimer = setInterval(() => {
      const next = (this.carouselIndex + 1) % CAROUSEL_SLIDES.length;
      this.goToSlide(next);
    }, CAROUSEL_INTERVAL_MS);
  }

  stopCarousel() {
    if (this.carouselTimer) {
      clearInterval(this.carouselTimer);
      this.carouselTimer = null;
    }
  }

  resetCarouselTimer() {
    this.stopCarousel();
    this.startCarousel();
  }

  /* ── Pills ─────────────────────────────────────────────────── */
  onPillClick(key) {
    if (!this.pillsRow || !this.pillContentContainer || !this.carouselContainer) return;

    if (this.activePill === key) {
      this.activePill = null;
      this.pillsRow.querySelectorAll('.home-pill').forEach((p) => p.classList.remove('active'));
      this.pillContentContainer.classList.add('hidden');
      this.pillContentContainer.innerHTML = '';
      this.carouselContainer.classList.remove('hidden');
      this.startCarousel();
    } else {
      this.activePill = key;
      this.pillsRow.querySelectorAll('.home-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.pill === key);
      });
      this.stopCarousel();
      this.carouselContainer.classList.add('hidden');
      this.renderPillContent(key);
      this.pillContentContainer.classList.remove('hidden');
    }
  }

  renderPillContent(key) {
    if (!this.pillContentContainer) return;

    let html = '';
    switch (key) {
      case 'templates': html = this.getTemplatesScrollHtml(); break;
      case 'website':   html = this.getWebsiteStartersHtml(); break;
      case 'design':    html = this.getDesignStartersHtml(); break;
      case 'sessions':  html = this.getSessionsListHtml(); break;
      case 'tasks':     html = this.getTasksListHtml(); break;
    }
    this.pillContentContainer.innerHTML = html;
    this.bindPillContentEvents(key);
  }

  bindPillContentEvents(key) {
    if (key === 'templates') {
      this.pillContentContainer.querySelectorAll('.template-scroll-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.template-preview-btn')) return;
          const id = card.dataset.templateId;
          const selected = getSelectedPresentationTemplate();
          if (selected?.id === id) {
            clearSelectedPresentationTemplate();
          } else {
            setSelectedPresentationTemplate(id);
            this.focusInput();
          }
        });
      });
      this.pillContentContainer.querySelectorAll('.template-preview-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.previewId;
          setSelectedPresentationTemplate(id);
          this.focusInput();
        });
      });

      const scrollRow = this.pillContentContainer.querySelector('.templates-scroll-row');
      const leftArrow = this.pillContentContainer.querySelector('.scroll-arrow-left');
      const rightArrow = this.pillContentContainer.querySelector('.scroll-arrow-right');
      if (scrollRow && leftArrow && rightArrow) {
        const scrollAmount = 280;
        leftArrow.addEventListener('click', () => scrollRow.scrollBy({ left: -scrollAmount, behavior: 'smooth' }));
        rightArrow.addEventListener('click', () => scrollRow.scrollBy({ left: scrollAmount, behavior: 'smooth' }));
        const updateArrows = () => {
          leftArrow.classList.toggle('hidden', scrollRow.scrollLeft <= 4);
          rightArrow.classList.toggle('hidden', scrollRow.scrollLeft + scrollRow.clientWidth >= scrollRow.scrollWidth - 4);
        };
        scrollRow.addEventListener('scroll', updateArrows);
        setTimeout(updateArrows, 60);
      }
    }

    if (key === 'website' || key === 'design') {
      this.pillContentContainer.querySelectorAll('.prompt-card').forEach((card) => {
        card.addEventListener('click', () => {
          const prompt = card.dataset.prompt;
          const input = document.getElementById('floating-input');
          if (input && prompt) {
            input.value = prompt;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            this.focusInput();
          }
        });
      });
    }

    if (key === 'sessions') {
      this.pillContentContainer.querySelectorAll('[data-session-id]').forEach((btn) => {
        btn.addEventListener('click', () => this.openSessionHistory(btn.dataset.sessionId));
      });
    }

    if (key === 'tasks') {
      this.pillContentContainer.querySelectorAll('[data-action="open-tasks"]').forEach((btn) => {
        btn.addEventListener('click', () => this.openTasksPanel());
      });
    }
  }

  /* ── Pill content HTML generators ──────────────────────────── */
  getTemplatesScrollHtml() {
    const selected = getSelectedPresentationTemplate();
    const cardsHtml = PRESENTATION_TEMPLATES.map((t) => {
      const isSelected = selected?.id === t.id;
      const colors = t.colors || ['#222', '#444', '#666', '#888'];
      return `
        <div class="template-scroll-card ${isSelected ? 'selected' : ''}" data-template-id="${this.escapeHtml(t.id)}">
          <div class="template-scroll-canvas-wrap">
            <span class="ppt-template-canvas" style="--ppt-bg:${colors[0]};--ppt-a:${colors[1]};--ppt-b:${colors[2]};--ppt-c:${colors[3]};">
              <span class="ppt-template-line title"></span>
              <span class="ppt-template-line short"></span>
              <span class="ppt-template-bars"><i></i><i></i><i></i></span>
            </span>
            <button class="template-preview-btn" data-preview-id="${this.escapeHtml(t.id)}" title="Use this template" type="button">
              <i class="fa-regular fa-eye" aria-hidden="true"></i>
            </button>
            ${isSelected ? '<span class="template-selected-badge"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : ''}
          </div>
          <div class="template-scroll-info">
            <strong>${this.escapeHtml(t.name)}</strong>
            <small>${this.escapeHtml(t.description || '')}</small>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="templates-scroll-wrapper">
        <button class="scroll-arrow scroll-arrow-left hidden" type="button" aria-label="Scroll left"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
        <div class="templates-scroll-row">${cardsHtml}</div>
        <button class="scroll-arrow scroll-arrow-right" type="button" aria-label="Scroll right"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
      </div>
      <div class="templates-scroll-hint">Select a template before asking for slides, or let AI choose automatically.</div>
    `;
  }

  getWebsiteStartersHtml() {
    return `<div class="prompt-grid">${WEBSITE_PROMPTS.map((p) => this.getPromptCardHtml(p)).join('')}</div>`;
  }

  getDesignStartersHtml() {
    return `<div class="prompt-grid">${DESIGN_PROMPTS.map((p) => this.getPromptCardHtml(p)).join('')}</div>`;
  }

  getPromptCardHtml(p) {
    return `
      <button class="prompt-card" data-prompt="${this.escapeHtml(p.prompt)}" type="button">
        <div class="prompt-card-icon"><i class="${p.icon}" aria-hidden="true"></i></div>
        <div class="prompt-card-copy">
          <strong>${this.escapeHtml(p.title)}</strong>
          <small>${this.escapeHtml(p.desc)}</small>
        </div>
      </button>
    `;
  }

  getSessionsListHtml() {
    if (!this.recentSessions.length) {
      return `<div class="welcome-card-empty">No recent conversations yet. Once you start chatting, your latest sessions will appear here automatically.</div>`;
    }
    return `
      <div class="welcome-list">
        ${this.recentSessions.map((session) => `
          <button type="button" class="welcome-list-item" data-session-id="${this.escapeHtml(session.session_id)}">
            <span class="welcome-list-copy">
              <span class="welcome-list-title">${this.escapeHtml(session.title || `Session ${String(session.session_id).slice(0, 8)}`)}</span>
              <span class="welcome-list-meta">${this.escapeHtml(this.getTimeAgo(session.created_at || session.updated_at))}</span>
            </span>
            <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
          </button>
        `).join('')}
      </div>
    `;
  }

  getTasksListHtml() {
    const listHtml = !this.recentTasks.length
      ? `<div class="welcome-card-empty">No recent tasks yet. Tasks will appear here once you create them.</div>`
      : `<div class="welcome-list">
          ${this.recentTasks.map((task) => `
            <button type="button" class="welcome-list-item" data-action="open-tasks">
              <span class="welcome-list-copy">
                <span class="welcome-list-title">${this.escapeHtml(task.text || task.title || 'Untitled task')}</span>
                <span class="welcome-list-meta">${this.escapeHtml(this.getTaskMeta(task))}</span>
              </span>
              <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
            </button>
          `).join('')}
        </div>`;

    return `
      <div class="home-tasks-content">
        ${listHtml}
        <div class="home-tasks-footer">
          <button type="button" class="welcome-card-action" data-action="open-tasks">Open Tasks Panel</button>
        </div>
      </div>
    `;
  }

  /* ═══════════════════════════════════════════════════════════════
     EVENTS
     ═══════════════════════════════════════════════════════════════ */
  bindEvents() {
    document.addEventListener('messageAdded', this.onMessageAdded);
    document.addEventListener('conversationCleared', this.onConversationCleared);

    const input = document.getElementById('floating-input');
    input?.addEventListener('input', this.handleInputChange);

    window.addEventListener('presentation-template:selected', this.handleTemplateChange);

    if (this.desktopMQ.addEventListener) {
      this.desktopMQ.addEventListener('change', this.handleViewportChange);
    } else if (this.desktopMQ.addListener) {
      // Safari < 14 fallback
      this.desktopMQ.addListener(this.handleViewportChange);
    }
  }

  handleViewportChange(event) {
    if (event.matches) {
      // Entered desktop range
      this.createDesktopRail();
      void this.loadDynamicData();
      this.updateDisplay();
    } else {
      // Left desktop range
      this.destroyDesktopRail();
    }
  }

  handleMessageAdded() {
    void this.loadDynamicData();
    this.updateDisplay();
  }

  handleConversationCleared() {
    this.hiddenByFloatingWindow = false;
    void this.loadDynamicData();
    requestAnimationFrame(() => this.updateDisplay());
  }

  handleInputChange() {
    if (this.activePill === 'templates') {
      this.renderPillContent('templates');
    }
  }

  handleTemplateChange() {
    if (this.activePill === 'templates') {
      this.renderPillContent('templates');
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     DATA LOADING
     ═══════════════════════════════════════════════════════════════ */
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

  async loadDynamicData() {
    if (!this.isDesktop()) return;
    await Promise.allSettled([
      this.loadRecentSessions(),
      this.loadRecentTasks()
    ]);
    if (this.activePill === 'sessions' || this.activePill === 'tasks') {
      this.renderPillContent(this.activePill);
    }
  }

  async loadRecentSessions() {
    try {
      const handler = window.contextHandler;
      if (handler?.loadedSessions?.length) {
        this.recentSessions = handler.loadedSessions.slice(0, 6);
        return;
      }
      this.recentSessions = [];
    } catch (error) {
      console.warn('WelcomeDisplay: Failed to load sessions', error);
      this.recentSessions = [];
    }
  }

  async loadRecentTasks() {
    try {
      const todo = window.todo;
      if (Array.isArray(todo?.tasks)) {
        this.recentTasks = todo.tasks.slice(0, 3);
        return;
      }
      this.recentTasks = [];
    } catch (error) {
      console.warn('WelcomeDisplay: Failed to load tasks', error);
      this.recentTasks = [];
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     ACTIONS
     ═══════════════════════════════════════════════════════════════ */
  focusInput() {
    const input = document.getElementById('floating-input');
    if (!input) return;
    input.focus();
    const length = input.value.length;
    try { input.setSelectionRange(length, length); } catch (_) { /* ignore */ }
  }

  openTasksPanel() {
    if (window.todo?.toggleWindow) {
      window.todo.toggleWindow(true);
    }
  }

  openSessionHistory(sessionId) {
    if (!sessionId) return;
    const handler = window.contextHandler;
    if (!handler) return;
    if (typeof handler.toggleWindow === 'function') {
      handler.toggleWindow(true);
    }
    if (typeof handler.showSessionDetails === 'function') {
      handler.showSessionDetails(sessionId);
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     VISIBILITY
     ═══════════════════════════════════════════════════════════════ */
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

    if (this.isDesktop() && this.suggestionsWrapper) {
      this.suggestionsWrapper.classList.remove('hidden');
      this.suggestionsWrapper.classList.add('visible');
      if (!this.activePill) {
        this.carouselContainer?.classList.remove('hidden');
        this.startCarousel();
      }
    }
  }

  hide() {
    if (!this.element || !this.isVisible) return;
    this.element.classList.remove('visible');
    this.element.classList.add('hidden');
    this.isVisible = false;

    this.suggestionsWrapper?.classList.remove('visible');
    this.suggestionsWrapper?.classList.add('hidden');
    this.carouselContainer?.classList.add('hidden');
    this.stopCarousel();
  }

  hideForFloatingWindow() {
    this.hiddenByFloatingWindow = true;
    this.hide();
  }

  showAfterFloatingWindow() {
    this.hiddenByFloatingWindow = false;
    this.updateDisplay();
  }

  /* ═══════════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════════ */
  getTimeAgo(value) {
    if (!value) return 'Recently';
    let time;
    if (typeof value === 'number') {
      time = value < 1e12 ? value * 1000 : value;
    } else {
      const parsed = Date.parse(value);
      time = Number.isNaN(parsed) ? Date.now() : parsed;
    }
    const diffMs = Math.max(0, Date.now() - time);
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(time).toLocaleDateString();
  }

  getTaskMeta(task) {
    const parts = [];
    if (task.status) parts.push(String(task.status).replace(/_/g, ' '));
    if (task.priority) parts.push(`${task.priority} priority`);
    if (task.deadline) {
      const d = new Date(task.deadline);
      if (!Number.isNaN(d.getTime())) parts.push(`due ${d.toLocaleDateString()}`);
    }
    return parts.join(' · ') || 'Open tasks to continue';
  }

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  destroy() {
    document.removeEventListener('messageAdded', this.onMessageAdded);
    document.removeEventListener('conversationCleared', this.onConversationCleared);
    window.removeEventListener('presentation-template:selected', this.handleTemplateChange);
    if (this.desktopMQ.removeEventListener) {
      this.desktopMQ.removeEventListener('change', this.handleViewportChange);
    } else if (this.desktopMQ.removeListener) {
      this.desktopMQ.removeListener(this.handleViewportChange);
    }
    this.destroyDesktopRail();
    this.initialized = false;
  }
}

export default WelcomeDisplay;
