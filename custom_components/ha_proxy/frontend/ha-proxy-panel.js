/**
 * ha-proxy-panel.js
 *
 * Generic HA Proxy panel element.  Reads this.panel.config.slug to know
 * which proxy instance to talk to, then:
 *   1. Exchanges a bearer token for a session cookie via
 *      POST /api/ha_proxy_session/{slug}
 *   2. Renders a full-page iframe at /api/ha_proxy/{slug}/
 *
 * The panel owns its layout: a viewport-height column flex container in
 * light DOM. The iframe's flex sizing only works when its immediate parent
 * (this element, NOT ha-panel-custom) is a flex container with a defined
 * height. HA's wrapper may be a block with auto height.
 *
 * Registration sets handle_safe_area=true. This element applies safe-area
 * padding inside its border-box height, avoiding double padding by HA.
 * Horizontal content insets account for safe space absorbed by the sidebar.
 *
 * Lifecycle: HA's panel resolver DETACHES this element (removes it from the
 * DOM) when the user navigates to another panel or when the app is suspended
 * (tab backgrounded >5 min, suspendWhenHidden), and RE-ATTACHES it on
 * return (panel switch or visibility return).  Re-attach must NOT re-create
 * the iframe: the iframe holds the proxied app's state (pages, in-app auth,
 * WebSocket connections) and re-creating it tears that state down.  So
 * connectedCallback keeps the existing iframe and only re-mints the session
 * cookie when the server-side in-memory session store no longer knows it
 * (e.g. HA restarted while the tab was away, which silently invalidates the
 * cookie) — otherwise a plain page reload would be needed.
 */

// Bump when this file changes (must match PANEL_JS_REV in const.py); the panel
// JS compares its own copy to the rev shipped in the panel config and
// force-reloads the page once when it is running a stale cached copy.
const PANEL_JS_REV = 3;

// How often to probe the session while the tab is hidden.  60s balances
// "notice an HA restart (and its session-store reset) soon" against "don't
// hammer the proxy".  Each probe is a cheap GET through the proxy that only
// creates a NEW session when the current one is found invalid.
const HIDDEN_PROBE_INTERVAL_MS = 60000;

class HAProxyPanel extends HTMLElement {
  constructor() {
    super();
    this._initialized = false;
    this._hass = null;
    this._panel = null;
    this._hidden = false;
    this._hiddenTimer = null;
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
    // Self-heal stale JS: HA serves this file with cache-control: no-cache,
    // so a re-fetch always gets the current bytes from the server. If the
    // server-side integration is newer than this copy (e.g. after an
    // update + HA restart where the browser kept an old copy), reload once
    // so the fresh file (and this check) runs.
    // Re-attach (panel switch, or return from the 5-min suspend):
    // keep the iframe and its app state; only re-mint the session if the
    // server forgot it (HA restarted while we were away).
    const serverRev = Number(this._panel?.config?.js_rev);
    if (serverRev && serverRev > PANEL_JS_REV) {
      console.warn(
        `[ha-proxy] Panel JS rev ${PANEL_JS_REV} is outdated (server ${serverRev}); reloading.`
      );
      window.location.reload();
      return;
    }
    if (this._initialized) {
      this._stopHiddenProbe();
      this._hidden = document.hidden;
      if (!document.hidden) {
        // Visible now (returned to this panel): refresh immediately.
        this._refreshSessionIfNeeded();
      }
      return;
    }
    this._hidden = document.hidden;
    this._maybeInit();
  }

  disconnectedCallback() {
    // ha-panel-custom removes this element from the DOM when the panel is
    // switched away from or the app is suspended (tab backgrounded >5 min),
    // and re-appends it on return (connectedCallback above).  Keep
    // _initialized so that reconnect is cheap — no iframe teardown.
    //
    // If we are being detached while the tab is hidden, the app is
    // suspending: the element will NOT be re-connected until the user comes
    // back, so start a periodic probe — if HA restarts while we're away, the
    // in-memory session store is cleared and our cookie is silently
    // invalidated; probing lets us re-mint before the user returns instead
    // of them hitting 401s.
    if (document.hidden && this._initialized) {
      this._hidden = true;
      this._startHiddenProbe();
    } else {
      // Panel switched away while still visible: the next connect (user
      // coming back) handles the refresh, so no timer needed.
      this._stopHiddenProbe();
    }
  }

  get _slug() {
    return this._panel?.config?.slug ?? "";
  }

  _maybeInit() {
    if (!this._initialized && this._hass && this._panel) {
      this._initialized = true;
      this._initialize();
    }
  }

  async _initialize() {
    this._renderLoading();
    try {
      await this._createSession();
      this._renderIframe();
      // If we were backgrounded at first init, start probing so a session
      // reset while hidden is caught without the user's interaction.
      if (document.hidden) {
        this._startHiddenProbe();
      }
    } catch (err) {
      console.error(`[ha-proxy-panel/${this._slug}] Session creation failed:`, err);
      this._renderError(err.message || String(err));
    }
  }

  // Probe whether the current session cookie is still valid on the server.
  // A GET against the proxy root: the server validates the cookie and
  // answers 401 when the in-memory session store no longer knows it (HA
  // restarted) or when there is no cookie at all.
  async _sessionValid() {
    const slug = this._slug;
    if (!slug) return false;
    try {
      const resp = await fetch(`/api/ha_proxy/${slug}/`, {
        method: "GET",
        credentials: "same-origin",
      });
      return resp.status !== 401 && resp.status !== 403;
    } catch {
      // Network error / HA unreachable: don't treat as "invalid" —
      // re-minting would fail too and we'd just churn. Keep the cookie.
      return true;
    }
  }

  // If the server no longer knows our session cookie (e.g. HA restarted
  // while the tab was hidden), mint a fresh one.  The cookie is scoped to
  // /api/ha_proxy/{slug}, so re-setting it means the iframe's next request
  // carries the new token — the proxied app keeps its state; only auth
  // changes.  No iframe reload needed.
  async _refreshSessionIfNeeded() {
    const slug = this._slug;
    if (!slug || !this._hass) return;
    if (await this._sessionValid()) return;
    console.info(`[ha-proxy/${slug}] Session expired on server — re-minting.`);
    try {
      await this._createSession();
    } catch (err) {
      // Re-mint failed (e.g. HA still down).  If the iframe is up, leave it
      // alone (the user can Retry, or the next probe tries again); otherwise
      // surface the error.
      console.warn(`[ha-proxy/${slug}] Re-mint failed:`, err);
      if (this._iframePresent()) return;
      this._renderError(err.message || String(err));
    }
  }

  _iframePresent() {
    return !!this.querySelector(".ha-proxy-iframe");
  }

  _startHiddenProbe() {
    if (this._hiddenTimer) return;
    this._hiddenTimer = window.setInterval(() => {
      if (document.hidden && this._initialized) {
        this._refreshSessionIfNeeded();
      }
    }, HIDDEN_PROBE_INTERVAL_MS);
  }

  _stopHiddenProbe() {
    if (this._hiddenTimer) {
      clearInterval(this._hiddenTimer);
      this._hiddenTimer = null;
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
    this.innerHTML = `
      <style>
        ha-proxy-panel {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100vh;
          height: 100dvh;
          min-width: 0;
          min-height: 0;
          box-sizing: border-box;
          overflow: hidden;
          padding-top: var(--safe-area-inset-top, 0px);
          padding-bottom: var(--safe-area-inset-bottom, 0px);
          padding-left: var(--safe-area-content-inset-left,
            var(--safe-area-inset-left, 0px));
          padding-right: var(--safe-area-content-inset-right,
            var(--safe-area-inset-right, 0px));
        }
        ha-proxy-panel > style { display: none; }
      </style>
      ${html}
    `;
  }

  _renderLoading() {
    this._setHtml(`
      <style>
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
        ha-proxy-panel > .ha-proxy-iframe {
          flex: 1; min-height: 0; min-width: 0;
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
