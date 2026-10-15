/**
 * ha-proxy-panel.js
 *
 * Generic HA Proxy panel element.  Reads this.panel.config.slug to know
 * which proxy instance to talk to, then:
 *   1. Exchanges a bearer token for a session cookie via
 *      POST /api/ha_proxy_session/{slug}
 *   2. Renders a full-page iframe at /api/ha_proxy/{slug}/
 *
 * The iframe is rendered in LIGHT DOM (this element's own tree, no shadow
 * root) so that the panel container's flex layout sizes it directly.
 * ha-panel-custom lays its children out with display:flex;
 * flex-direction:column and (since 2026.8) applies safe-area padding on the
 * container.  A child with flex:1 + min-height:0 then fills exactly the
 * remaining space — no 100vh/dvh fallback needed, and safe-area insets are
 * handled by the container for us.
 *
 * (With shadow DOM, :host lives inside that flex container, where
 * height:100% resolves to auto and the iframe collapses to its 150px
 * default intrinsic height.)
 */

// Bump when this file changes (must match PANEL_JS_REV in const.py); the panel
// JS compares its own copy to the rev shipped in the panel config and
// force-reloads the page once when it is running a stale cached copy.
const PANEL_JS_REV = 1;

class HAProxyPanel extends HTMLElement {
  constructor() {
    super();
    this._initialized = false;
    this._hass = null;
    this._panel = null;
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
    // Self-heal stale JS: HA serves this file with cache-control:
    // no-cache, so a re-fetch always gets the current bytes from the server.
    // If the server-side integration is newer than this copy (e.g. after an
    // update + HA restart where the browser kept an old copy), reload once so
    // the fresh file (and this check) runs.
    const serverRev = Number(this._panel?.config?.js_rev);
    if (serverRev && serverRev > PANEL_JS_REV) {
      console.warn(`[ha-proxy] Panel JS rev ${PANEL_JS_REV} is outdated (server ${serverRev}); reloading.`);
      window.location.reload();
      return;
    }
    this._maybeInit();
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

  // Clear the light-DOM children, then inject our own <style> + content.
  // (innerHTML on this element is safe: we only ever write our own markup.)
  _setHtml(html) {
    this.innerHTML = html;
  }

  _renderLoading() {
    this._setHtml(`
      <style>
        ha-proxy-panel > * { display: block; width: 100%; }
        .ha-proxy-spinner {
          flex: 1; min-height: 0;
          display: flex; align-items: center; justify-content: center;
          width: 100%;
          background: var(--primary-background-color, #fff);
        }
        .ha-proxy-spinner .spinner {
          width: 48px; height: 48px;
          border: 5px solid var(--divider-color, #ccc);
          border-top-color: var(--primary-color, #03a9f4);
          border-radius: 50%;
          animation: ha-proxy-spin 0.8s linear infinite;
        }
        @keyframes ha-proxy-spin { to { transform: rotate(360deg); } }
      </style>
      <div class="ha-proxy-spinner"><div class="spinner"></div></div>
    `);
  }

  _renderIframe() {
    const slug = this._slug;
    this._setHtml(`
      <style>
        .ha-proxy-iframe {
          flex: 1; min-height: 0;
          width: 100%; border: none; display: block;
        }
      </style>
      <iframe
        class="ha-proxy-iframe"
        src="/api/ha_proxy/${slug}/"
        allow="autoplay; fullscreen"
      ></iframe>
    `);
  }

  _renderError(message) {
    const slug = this._slug;
    this._setHtml(`
      <style>
        .ha-proxy-error {
          flex: 1; min-height: 0;
          display: flex; flex-direction: column; align-items: center;
          justify-content: center;
          width: 100%;
          background: var(--primary-background-color, #fff);
          font-family: var(--paper-font-body1_-_font-family, sans-serif);
          color: var(--primary-text-color, #212121);
          gap: 16px; padding: 24px; box-sizing: border-box;
        }
        .ha-proxy-error ha-icon { --mdc-icon-size: 48px; color: var(--error-color, #db4437); }
        .ha-proxy-error p { margin: 0; text-align: center; max-width: 480px; opacity: 0.8; }
        .ha-proxy-error button {
          padding: 8px 20px;
          background: var(--primary-color, #03a9f4); color: #fff;
          border: none; border-radius: 4px; cursor: pointer;
          font-size: 14px;
        }
        .ha-proxy-error button:hover { opacity: 0.9; }
      </style>
      <div class="ha-proxy-error">
        <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
        <p><strong>Could not connect to proxy instance '${this._escapeHtml(slug)}'</strong></p>
        <p>${this._escapeHtml(message)}</p>
        <button id="retry">Retry</button>
      </div>
    `);
    this.querySelector("#retry").addEventListener("click", () => {
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
