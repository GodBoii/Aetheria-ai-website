import { authService } from './auth-service.js';
import { supabase } from './supabase-client.js';

class AuthGate {
  constructor() {
    this.root = null;
    this.state = 'loading';
    this.completed = false;
    this.unsubscribeAuth = null;
  }

  async init() {
    this.completed = false;
    this.render();
    this.setMode('loading');

    if (!this.unsubscribeAuth) {
      this.unsubscribeAuth = authService.onAuthChange((user) => {
        if (user) this.completeAuth();
      });
    }

    const initialized = await authService.init();
    if (initialized && authService.isAuthenticated()) {
      this.completeAuth();
      return;
    }

    requestAnimationFrame(() => this.setMode('login'));
  }

  reinit() {
    this.completed = false;
    this.render();
    this.root.classList.remove('hidden');
    this.setMode('loading');
    requestAnimationFrame(() => this.setMode('login'));
  }

  completeAuth() {
    if (this.completed) return;
    this.completed = true;

    if (this.root) {
      this.root.classList.add('hidden');
      window.setTimeout(() => {
        this.root?.remove();
        this.root = null;
      }, 520);
    }

    window.dispatchEvent(new CustomEvent('auth-gate:authenticated'));
  }

  setMode(mode) {
    if (!this.root) return;
    this.state = mode;

    const loadingOverlay = this.root.querySelector('.auth-loading-overlay');
    loadingOverlay?.classList.toggle('hidden', mode !== 'loading');
    if (mode === 'loading') return;

    const isSignup = mode === 'signup';
    this.root.querySelector('.auth-glass-card')?.setAttribute('data-mode', mode);
    this.root.querySelector('#auth-name-field')?.classList.toggle('hidden', !isSignup);
    this.root.querySelector('#auth-phone-field')?.classList.toggle('hidden', !isSignup);
    this.root.querySelector('#auth-name')?.toggleAttribute('required', isSignup);
    this.root.querySelector('#auth-phone')?.toggleAttribute('required', isSignup);
    this.setText('.auth-header h2', isSignup ? 'Create an account' : 'Welcome back');
    this.setText('.auth-header p', isSignup ? 'Begin your Aetheria workspace.' : 'Enter your details to access your workspace.');
    this.setText('#auth-submit-label', isSignup ? 'Sign up' : 'Sign in');
    this.setText('#auth-footer-copy', isSignup ? 'Already have an account?' : "Don't have an account?");
    this.setText('#auth-toggle-mode', isSignup ? 'Sign in' : 'Sign up');
    this.setText('#auth-error-msg', '');
  }

  setText(selector, value) {
    const element = this.root?.querySelector(selector);
    if (element) element.textContent = value;
  }

  async handleSubmit(event) {
    event.preventDefault();

    const email = this.root.querySelector('#auth-email').value.trim();
    const password = this.root.querySelector('#auth-password').value;
    const name = this.root.querySelector('#auth-name').value.trim();
    const phoneNumber = this.root.querySelector('#auth-phone').value.trim();
    const errorMsg = this.root.querySelector('#auth-error-msg');
    const submitBtn = this.root.querySelector('#auth-submit-btn');

    errorMsg.textContent = '';
    submitBtn.disabled = true;

    try {
      if (this.state === 'signup' && !name) {
        errorMsg.textContent = 'Name is required for sign up.';
        return;
      }

      if (this.state === 'signup' && !phoneNumber) {
        errorMsg.textContent = 'Mobile number is required for sign up.';
        return;
      }

      const result = this.state === 'signup'
        ? await authService.signUp(email, password, name, phoneNumber)
        : await authService.signIn(email, password);

      if (!result.success) {
        errorMsg.textContent = result.error || 'Authentication failed.';
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (data.session) {
        this.completeAuth();
      } else if (this.state === 'signup') {
        this.setMode('login');
        errorMsg.textContent = 'Signup successful. Please check your email, then sign in.';
      } else {
        errorMsg.textContent = 'Sign-in did not create a session. Please try again.';
      }
    } catch (error) {
      console.error('[AuthGate] Form auth failed:', error);
      errorMsg.textContent = error.message || 'An unexpected error occurred.';
    } finally {
      submitBtn.disabled = false;
    }
  }

  async handleGoogleLogin() {
    const errorMsg = this.root.querySelector('#auth-error-msg');
    const googleBtn = this.root.querySelector('#auth-google-btn');
    errorMsg.textContent = '';
    googleBtn.disabled = true;

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}${window.location.pathname}`,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      if (error) throw error;
    } catch (error) {
      console.error('[AuthGate] Google auth failed:', error);
      errorMsg.textContent = `${error.message || 'Google login failed.'} Make sure your Supabase Authentication Redirect URLs include this production domain, for example https://<your-app>.vercel.app/**.`;
    } finally {
      googleBtn.disabled = false;
    }
  }

  render() {
    if (this.root) return;

    this.root = document.createElement('div');
    this.root.id = 'auth-gate-root';
    this.root.innerHTML = `
      <div class="auth-global-bg">
        <div class="auth-nebula-bg"></div>
        <div class="auth-stars"></div>
        <div class="auth-glow-orb orb-1"></div>
        <div class="auth-glow-orb orb-2"></div>
        <div class="auth-glow-orb orb-3"></div>
        <div class="auth-noise-overlay"></div>
      </div>
      <div class="auth-split-layout">
        <section class="auth-illustration-pane" aria-label="Aetheria AI">
          <div class="auth-branding">
            <h1>AETHERIA AI</h1>
            <p>ELEVATE YOURSELF WITH AETHERIA AI</p>
          </div>
        </section>
        <section class="auth-form-pane" aria-label="Authentication">
          <div class="auth-loading-overlay">
            <div class="auth-spinner" aria-hidden="true"></div>
            <p>Initializing secure connection...</p>
          </div>
          <div class="auth-glass-card" data-mode="login">
            <div class="auth-header">
              <h2>Welcome back</h2>
              <p>Enter your details to access your workspace.</p>
            </div>
            <form class="auth-form" id="auth-main-form">
              <div class="auth-input-group hidden" id="auth-name-field">
                <label for="auth-name">Full name</label>
                <input type="text" id="auth-name" autocomplete="name" placeholder="Your name">
              </div>
              <div class="auth-input-group hidden" id="auth-phone-field">
                <label for="auth-phone">Mobile number</label>
                <input type="tel" id="auth-phone" autocomplete="tel" inputmode="tel" placeholder="+919876543210">
              </div>
              <div class="auth-input-group">
                <label for="auth-email">Email</label>
                <input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" required>
              </div>
              <div class="auth-input-group">
                <label for="auth-password">Password</label>
                <input type="password" id="auth-password" autocomplete="current-password" placeholder="Password" required>
              </div>
              <div class="auth-error" id="auth-error-msg" aria-live="polite"></div>
              <button type="submit" class="auth-btn auth-btn-primary" id="auth-submit-btn">
                <span id="auth-submit-label">Sign in</span>
              </button>
            </form>
            <div class="auth-divider">or continue with</div>
            <button class="auth-btn auth-btn-google" id="auth-google-btn" type="button">
              <i class="fab fa-google"></i>
              <span>Google</span>
            </button>
            <div class="auth-footer">
              <span id="auth-footer-copy">Don't have an account?</span>
              <button id="auth-toggle-mode" type="button">Sign up</button>
            </div>
          </div>
        </section>
      </div>
    `;

    document.body.appendChild(this.root);
    this.root.querySelector('#auth-main-form').addEventListener('submit', (event) => this.handleSubmit(event));
    this.root.querySelector('#auth-toggle-mode').addEventListener('click', () => {
      this.setMode(this.state === 'login' ? 'signup' : 'login');
    });
    this.root.querySelector('#auth-google-btn').addEventListener('click', () => this.handleGoogleLogin());
  }
}

export const authGate = new AuthGate();
