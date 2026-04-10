# HA Proxy

A Home Assistant custom integration that reverse-proxies any internal web
service through Home Assistant, gating access behind HA authentication and
displaying it as a first-class sidebar panel.

## Why this exists

Some web services (Frigate NVR, code-server, Grafana, etc.) are only reachable
on internal networks — not from browsers on the open internet. HA Proxy lets
you access them through HA without ever exposing them directly, using the same
session-cookie ingress mechanism that HA Supervisor uses for its add-ons.

## How it works

1. **Panel JS** calls `POST /api/ha_proxy_session/{slug}` with the HA bearer
   token → server validates and sets an `HttpOnly` session cookie scoped to
   `/api/ha_proxy/{slug}`.
2. An `<iframe>` loads `/api/ha_proxy/{slug}/` — the browser sends the cookie
   automatically (no JS involved from this point).
3. The **proxy view** validates the cookie, strips hop-by-hop and encoding
   headers, and streams the upstream response back to the browser.
4. WebSocket connections are relayed transparently.

## Installation

### HACS (recommended)

Add this repo as a custom HACS repository (type: Integration), then install
**HA Proxy**.

### Manual

Copy `custom_components/ha_proxy/` into your HA `config/custom_components/`
directory and restart Home Assistant.

### Kubernetes / Helm

See the `HomeNet` Helm chart — an init container installs the component from a
ConfigMap before HA starts.

## Configuration

After installation:

1. Go to **Settings → Devices & Services → Add Integration → HA Proxy**.
2. Enter a display name (e.g. "Frigate NVR"), the internal URL
   (e.g. `http://frigate:5000`), and optional icon.
3. The integration creates a sidebar panel at `/{slug}` (e.g. `/frigate-nvr`).
4. Repeat for each service you want to proxy.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| Server URL | — | Internal URL of the service, reachable by HA |
| Sidebar icon | `mdi:web` | MDI icon for the sidebar entry |
| Verify SSL | `true` | Validate the upstream TLS certificate |
| Send X-Ingress-Path | `false` | Forwards the proxy base path as `X-Ingress-Path` — enable for Frigate and other apps that support HA Supervisor's ingress header |

## Multiple instances

Each integration entry is independent. Add as many as you need — each gets its
own URL path, sidebar entry, and session cookie.

## Notes

- Sessions are stored in memory and cleared on HA restart — users will need to
  load the panel once after each restart to refresh the cookie (this happens
  automatically).
- The upstream service must be reachable from the HA container/pod. It does
  **not** need to be reachable from user browsers.
- Bearer tokens never leave the HA server; the browser only ever sees session
  cookies scoped to the proxy paths.
