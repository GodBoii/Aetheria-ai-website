/**
 * Security Utilities for Aetheria AI
 * Provides debouncing, button locking, input sanitization, and rate limiting
 */

/**
 * Debounce utility - prevents rapid-fire function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle utility - ensures function is called at most once per interval
 * @param {Function} func - Function to throttle
 * @param {number} limit - Minimum time between calls in milliseconds
 * @returns {Function} Throttled function
 */
export function throttle(func, limit = 1000) {
    let inThrottle;
    return function executedFunction(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * ButtonLock - Prevents double-clicks and concurrent operations
 * Usage:
 *   const buttonLock = new ButtonLock();
 *   button.addEventListener('click', () => {
 *     buttonLock.execute('my-button', async () => {
 *       await doSomething();
 *     });
 *   });
 */
export class ButtonLock {
    constructor() {
        this.locks = new Map();
    }
    
    /**
     * Execute an async function with button locking
     * @param {string} buttonId - Unique identifier for the button
     * @param {Function} asyncFn - Async function to execute
     * @returns {Promise} Result of asyncFn
     */
    async execute(buttonId, asyncFn) {
        if (this.locks.get(buttonId)) {
            console.warn(`[ButtonLock] Button ${buttonId} is already locked`);
            return null;
        }
        
        this.locks.set(buttonId, true);
        const button = document.getElementById(buttonId);
        const originalDisabled = button?.disabled;
        const originalHTML = button?.innerHTML;
        
        if (button) {
            button.disabled = true;
            button.classList.add('button-locked');
        }
        
        try {
            return await asyncFn();
        } catch (error) {
            console.error(`[ButtonLock] Error in ${buttonId}:`, error);
            throw error;
        } finally {
            this.locks.delete(buttonId);
            if (button) {
                button.disabled = originalDisabled || false;
                button.classList.remove('button-locked');
                if (originalHTML) {
                    button.innerHTML = originalHTML;
                }
            }
        }
    }
    
    /**
     * Check if a button is currently locked
     * @param {string} buttonId - Button identifier
     * @returns {boolean} True if locked
     */
    isLocked(buttonId) {
        return this.locks.has(buttonId);
    }
    
    /**
     * Manually unlock a button (use with caution)
     * @param {string} buttonId - Button identifier
     */
    unlock(buttonId) {
        this.locks.delete(buttonId);
        const button = document.getElementById(buttonId);
        if (button) {
            button.disabled = false;
            button.classList.remove('button-locked');
        }
    }
}

/**
 * Input Sanitization Utilities
 */
export const sanitizeInput = {
    /**
     * Sanitize text input (escape HTML)
     * @param {string} input - Input to sanitize
     * @returns {string} Sanitized input
     */
    text(input) {
        if (typeof input !== 'string') return '';
        const div = document.createElement('div');
        div.textContent = input;
        return div.innerHTML;
    },
    
    /**
     * Validate and sanitize URL
     * @param {string} input - URL to validate
     * @returns {string} Validated URL
     * @throws {Error} If URL is invalid
     */
    url(input) {
        try {
            const url = new URL(input);
            // Only allow http and https protocols
            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error('Invalid protocol');
            }
            return url.href;
        } catch {
            throw new Error('Invalid URL format');
        }
    },
    
    /**
     * Validate GitHub repository URL
     * @param {string} input - GitHub URL to validate
     * @returns {string} Validated GitHub URL
     * @throws {Error} If URL is invalid
     */
    githubUrl(input) {
        const pattern = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/;
        if (!pattern.test(input)) {
            throw new Error('Invalid GitHub URL format. Expected: https://github.com/owner/repo');
        }
        return input;
    },
    
    /**
     * Validate branch name (alphanumeric, hyphens, underscores, dots)
     * @param {string} input - Branch name to validate
     * @returns {string} Validated branch name
     * @throws {Error} If branch name is invalid
     */
    branchName(input) {
        if (typeof input !== 'string' || input.length === 0) {
            throw new Error('Branch name cannot be empty');
        }
        
        if (!/^[\w.-]+$/.test(input)) {
            throw new Error('Branch name can only contain letters, numbers, hyphens, underscores, and dots');
        }
        
        if (input.length > 255) {
            throw new Error('Branch name is too long');
        }
        
        return input;
    },
    
    /**
     * Validate email address
     * @param {string} input - Email to validate
     * @returns {string} Validated email
     * @throws {Error} If email is invalid
     */
    email(input) {
        const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!pattern.test(input)) {
            throw new Error('Invalid email format');
        }
        return input.toLowerCase().trim();
    },
    
    /**
     * Sanitize filename (remove path traversal attempts)
     * @param {string} input - Filename to sanitize
     * @returns {string} Sanitized filename
     */
    filename(input) {
        if (typeof input !== 'string') return '';
        
        // Remove path traversal attempts
        let sanitized = input.replace(/\.\./g, '');
        sanitized = sanitized.replace(/[\/\\]/g, '');
        
        // Remove null bytes
        sanitized = sanitized.replace(/\0/g, '');
        
        return sanitized.trim();
    }
};

/**
 * Rate Limiter - Prevents too many operations in a time window
 * Usage:
 *   const limiter = new RateLimiter(5, 60000); // 5 requests per minute
 *   if (limiter.tryAcquire('user-action')) {
 *     // Perform action
 *   } else {
 *     // Show rate limit error
 *   }
 */
export class RateLimiter {
    /**
     * @param {number} maxRequests - Maximum requests allowed
     * @param {number} windowMs - Time window in milliseconds
     */
    constructor(maxRequests = 10, windowMs = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.requests = new Map();
    }
    
    /**
     * Try to acquire a token for an action
     * @param {string} key - Unique key for the action
     * @returns {boolean} True if action is allowed
     */
    tryAcquire(key) {
        const now = Date.now();
        const timestamps = this.requests.get(key) || [];
        
        // Remove old timestamps outside the window
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
        
        if (validTimestamps.length >= this.maxRequests) {
            console.warn(`[RateLimiter] Rate limit exceeded for ${key}`);
            return false;
        }
        
        validTimestamps.push(now);
        this.requests.set(key, validTimestamps);
        return true;
    }
    
    /**
     * Get remaining requests in current window
     * @param {string} key - Action key
     * @returns {number} Remaining requests
     */
    getRemaining(key) {
        const now = Date.now();
        const timestamps = this.requests.get(key) || [];
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
        return Math.max(0, this.maxRequests - validTimestamps.length);
    }
    
    /**
     * Reset rate limit for a key
     * @param {string} key - Action key
     */
    reset(key) {
        this.requests.delete(key);
    }
}

/**
 * Idempotency Key Generator
 * Generates unique keys to prevent duplicate operations
 */
export class IdempotencyKeyGenerator {
    /**
     * Generate a unique idempotency key
     * @param {string} prefix - Optional prefix for the key
     * @returns {string} Unique key
     */
    static generate(prefix = '') {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
    }
    
    /**
     * Generate a key based on operation parameters
     * @param {string} operation - Operation name
     * @param {Object} params - Operation parameters
     * @returns {string} Deterministic key
     */
    static generateFromParams(operation, params) {
        const paramsStr = JSON.stringify(params);
        const hash = this.simpleHash(paramsStr);
        return `${operation}-${hash}`;
    }
    
    /**
     * Simple hash function for strings
     * @param {string} str - String to hash
     * @returns {string} Hash
     */
    static simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }
}

/**
 * Content Security - XSS Prevention
 */
export const contentSecurity = {
    /**
     * Sanitize HTML content using DOMPurify
     * @param {string} html - HTML to sanitize
     * @param {Object} options - DOMPurify options
     * @returns {string} Sanitized HTML
     */
    sanitizeHTML(html, options = {}) {
        const defaultOptions = {
            ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel'],
            ALLOW_DATA_ATTR: false,
            ALLOW_UNKNOWN_PROTOCOLS: false,
            SAFE_FOR_TEMPLATES: true
        };

        const mergedOptions = { ...defaultOptions, ...options };

        if (typeof DOMPurify !== 'undefined') {
            return DOMPurify.sanitize(html, mergedOptions);
        }

        return this.sanitizeHTMLFallback(html, mergedOptions);
    },

    sanitizeHTMLFallback(html, options = {}) {
        const template = document.createElement('template');
        template.innerHTML = String(html ?? '');

        const allowedTags = new Set((options.ALLOWED_TAGS || []).map((tag) => tag.toUpperCase()));
        const allowedAttrs = new Set(options.ALLOWED_ATTR || []);
        const blockedTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'META', 'LINK']);

        const sanitizeNode = (node) => {
            if (node.nodeType === Node.COMMENT_NODE) {
                node.remove();
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return;

            if (blockedTags.has(node.tagName)) {
                node.remove();
                return;
            }

            if (!allowedTags.has(node.tagName)) {
                node.replaceWith(document.createTextNode(node.textContent || ''));
                return;
            }

            Array.from(node.attributes).forEach((attr) => {
                const name = attr.name.toLowerCase();
                const value = attr.value || '';
                const isDataAttr = name.startsWith('data-');
                const isEventHandler = name.startsWith('on');
                const isAllowed = allowedAttrs.has(name) || (options.ALLOW_DATA_ATTR && isDataAttr);

                if (!isAllowed || isEventHandler || /javascript:/i.test(value) || /data:text\/html/i.test(value)) {
                    node.removeAttribute(attr.name);
                    return;
                }

                if (name === 'href') {
                    try {
                        const url = new URL(value, window.location.origin);
                        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
                            node.removeAttribute(attr.name);
                        }
                    } catch {
                        node.removeAttribute(attr.name);
                    }
                }
            });

            Array.from(node.childNodes).forEach(sanitizeNode);
        };

        Array.from(template.content.childNodes).forEach(sanitizeNode);
        return template.innerHTML;
    },
    
    /**
     * Strip all HTML tags (fallback if DOMPurify not available)
     * @param {string} html - HTML to strip
     * @returns {string} Plain text
     */
    stripHTML(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.textContent || div.innerText || '';
    },
    
    /**
     * Validate that content doesn't contain dangerous patterns
     * @param {string} content - Content to validate
     * @returns {boolean} True if safe
     */
    isSafeContent(content) {
        const dangerousPatterns = [
            /<script/i,
            /javascript:/i,
            /on\w+\s*=/i, // Event handlers like onclick=
            /<iframe/i,
            /<object/i,
            /<embed/i,
            /data:text\/html/i
        ];
        
        return !dangerousPatterns.some(pattern => pattern.test(content));
    }
};

/**
 * Session Security
 */
export class SessionSecurity {
    constructor(timeoutMinutes = 30) {
        this.timeoutMs = timeoutMinutes * 60 * 1000;
        this.lastActivity = Date.now();
        this.warningShown = false;
        this.setupActivityListeners();
    }
    
    setupActivityListeners() {
        const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
        events.forEach(event => {
            document.addEventListener(event, () => this.updateActivity(), { passive: true });
        });
        
        // Check for timeout every minute
        setInterval(() => this.checkTimeout(), 60000);
    }
    
    updateActivity() {
        this.lastActivity = Date.now();
        this.warningShown = false;
    }
    
    checkTimeout() {
        const inactive = Date.now() - this.lastActivity;
        const warningThreshold = this.timeoutMs - (5 * 60 * 1000); // 5 minutes before timeout
        
        if (inactive >= this.timeoutMs) {
            this.handleTimeout();
        } else if (inactive >= warningThreshold && !this.warningShown) {
            this.showWarning();
            this.warningShown = true;
        }
    }
    
    showWarning() {
        document.dispatchEvent(new CustomEvent('session:warning', {
            detail: { remainingMinutes: 5 }
        }));
    }
    
    handleTimeout() {
        document.dispatchEvent(new CustomEvent('session:timeout'));
    }
    
    getInactiveTime() {
        return Date.now() - this.lastActivity;
    }
}

/**
 * Global security utilities instance
 */
export const security = {
    buttonLock: new ButtonLock(),
    rateLimiter: new RateLimiter(10, 60000), // 10 requests per minute
    sessionSecurity: new SessionSecurity(30), // 30 minute timeout
    
    // Convenience methods
    debounce,
    throttle,
    sanitizeInput,
    contentSecurity,
    IdempotencyKeyGenerator
};

// Export default
export default security;
