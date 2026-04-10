"""Constants for the HA Proxy integration."""
from __future__ import annotations

from typing import Final

DOMAIN: Final = "ha_proxy"

# Config keys
CONF_NAME: Final = "name"
CONF_SERVER: Final = "server"
CONF_SLUG: Final = "slug"
CONF_PANEL_ICON: Final = "panel_icon"
CONF_SSL_VERIFICATION: Final = "ssl_verification"
CONF_SEND_INGRESS_PATH: Final = "send_ingress_path"

# Defaults
DEFAULT_PANEL_ICON: Final = "mdi:web"
DEFAULT_SSL_VERIFICATION: Final = True
DEFAULT_SEND_INGRESS_PATH: Final = False

# Session
SESSION_TTL: Final = 86400  # 24 hours

# URL paths — all instance-specific paths include {slug} as a path segment
PROXY_API_BASE: Final = "/api/ha_proxy"        # /api/ha_proxy/{slug}/{path}
SESSION_API_BASE: Final = "/api/ha_proxy_session"  # /api/ha_proxy_session/{slug}
PANEL_STATIC_URL: Final = "/api/ha_proxy_panel"
PANEL_ELEMENT_NAME: Final = "ha-proxy-panel"
PANEL_JS_FILENAME: Final = "ha-proxy-panel.js"
