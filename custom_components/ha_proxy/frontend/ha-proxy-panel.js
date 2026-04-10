/**
 * ha-proxy-panel.js
 *
 * Generic HA Proxy panel element.  Reads this.panel.config.slug to know
 * which proxy instance to talk to, then:
 *   1. Exchanges a bearer token for a session cookie via
 *      POST /api/ha_proxy_session/{slug}
 *   2. Renders a full-page iframe at /api/ha_proxy/{slug}/
 */

class HAProxyPanel extends HTMLElement {
  constructor() {
    super();
    this._initialized = false;
    this._hass = null;
    this._panel = null;
    this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeInit();
  }

  set panel(panel) {
    this._panel = panel;
    this._maybeInit();
  }

  connectedCallback() {
    this._maybeInit();
  }

  _maybeInit() {
    if (!this._initialized && this._hass && this._panel) {
      this._initialized = true;
      this._initialize();
    }
  }

  get _slug() {
    return this._panel?.config?.slug ?? "";
  }

  async _initialize() {
    this._renderLoading();
    try {
      await this._createSession();
      this._renderIframe();
    } catch (err) {
      console.error(`[ha-proxy-panel/${this._slug}] Session creation failed:`, err);
      this._renderError(err.message || String(err));
    }
  }

  async _createSession() {
    const slug = this._slug;
    if (!slug) throw new Error("No slug in panel config — is the integration set up correctly?");

    const token = this._hass.auth.data.access_token;
    const resp = await fetch(`/api/ha_proxy_session/${slug}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) {
      throw new Error(`Session endpoint returned HTTP ${resp.status}`);
    }
  }

  _renderLoading() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: flex; align-items: center; justify-content: center;
                width: 100%; height: 100%;
                background: var(--primary-background-color, #fff); }
        .spinner { width: 48px; height: 48px;
                   border: 5px solid var(--divider-color, #ccc);
                   border-top-color: var(--primary-color, #03a9f4);
                   border-radius: 50%;
                   animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="spinner"></div>
    `;
  }

  _renderIframe() {
    const slug = this._slug;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; height: 100%; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; display: block; }
      </style>
      <iframe
        src="/api/ha_proxy/${slug}/"
        allow="autoplay; fullscreen"
      ></iframe>
    `;
  }

  _renderError(message) {
    const slug = this._slug;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: flex; flex-direction: column; align-items: center;
                justify-content: center; width: 100%; height: 100%;
                background: var(--primary-background-color, #fff);
                font-family: var(--paper-font-body1_-_font-family, sans-serif);
                color: var(--primary-text-color, #212121);
                gap: 16px; padding: 24px; box-sizing: border-box; }
        ha-icon { --mdc-icon-size: 48px; color: var(--error-color, #db4437); }
        p { margin: 0; text-align: center; max-width: 480px; opacity: 0.8; }
        button { padding: 8px 20px;
                 background: var(--primary-color, #03a9f4); color: #fff;
                 border: none; border-radius: 4px; cursor: pointer;
                 font-size: 14px; }
        button:hover { opacity: 0.9; }
      </style>
      <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
      <p><strong>Could not connect to proxy instance '${this._escapeHtml(slug)}'</strong></p>
      <p>${this._escapeHtml(message)}</p>
      <button id="retry">Retry</button>
    `;
    this.shadowRoot.getElementById("retry").addEventListener("click", () => {
      this._initialized = false;
      this._initialize();
    });
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

customElements.define("ha-proxy-panel", HAProxyPanel);
