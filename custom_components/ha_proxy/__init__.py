"""HA Proxy — generic server-side reverse proxy integration for Home Assistant.

Proxies any internal web service (HTTP + WebSocket) through HA with session-
cookie auth, adding it as a first-class sidebar panel.  Supports multiple
independent instances (one config entry per service).

Auth flow mirrors HA Supervisor's ingress mechanism:
  1. panel JS calls POST /api/ha_proxy_session/{slug} with a bearer token
  2. Server sets an HttpOnly session cookie scoped to /api/ha_proxy/{slug}
  3. iframe loads /api/ha_proxy/{slug}/ — browser sends cookie automatically
  4. Proxy view validates cookie and forwards to the upstream server
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.components.frontend import (
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    CONF_PANEL_ICON,
    CONF_SEND_INGRESS_PATH,
    CONF_SERVER,
    CONF_SLUG,
    CONF_SSL_VERIFICATION,
    DEFAULT_PANEL_ICON,
    DEFAULT_SEND_INGRESS_PATH,
    DEFAULT_SSL_VERIFICATION,
    DOMAIN,
    PANEL_ELEMENT_NAME,
    PANEL_JS_FILENAME,
    PANEL_STATIC_URL,
)
from .proxy import HAProxySessionView, HAProxyView, IngressSessions

_LOGGER = logging.getLogger(__name__)
_FRONTEND_DIR = Path(__file__).parent / "frontend"


def _opt(entry: ConfigEntry, key: str, default: Any) -> Any:
    return entry.options.get(key, entry.data.get(key, default))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a proxy instance from a config entry."""
    hass.data.setdefault(DOMAIN, {"instances": {}, "views_registered": False})

    # ------------------------------------------------------------------
    # Register shared HTTP views and static path exactly once.
    # aiohttp routes cannot be removed; guard prevents double-registration
    # across config-entry reloads.
    # ------------------------------------------------------------------
    if not hass.data[DOMAIN]["views_registered"]:
        hass.http.register_view(HAProxySessionView(hass))
        hass.http.register_view(HAProxyView(hass))
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_STATIC_URL, str(_FRONTEND_DIR), cache_headers=False)]
        )
        hass.data[DOMAIN]["views_registered"] = True
        _LOGGER.debug("Registered HA Proxy HTTP views and static path")

    # ------------------------------------------------------------------
    # Register this instance in the shared instances dict.
    # ------------------------------------------------------------------
    slug: str = entry.data[CONF_SLUG]
    hass.data[DOMAIN]["instances"][slug] = {
        "server": _opt(entry, CONF_SERVER, "").rstrip("/"),
        "ssl_verification": _opt(entry, CONF_SSL_VERIFICATION, DEFAULT_SSL_VERIFICATION),
        "send_ingress_path": _opt(entry, CONF_SEND_INGRESS_PATH, DEFAULT_SEND_INGRESS_PATH),
        "sessions": IngressSessions(),
    }

    def _remove_instance() -> None:
        hass.data[DOMAIN]["instances"].pop(slug, None)

    entry.async_on_unload(_remove_instance)

    # ------------------------------------------------------------------
    # Register sidebar panel (removable, so done every setup/reload).
    # frontend_url_path = slug so the panel lives at /<slug> in the UI.
    # ------------------------------------------------------------------
    _register_panel(hass, entry, slug)
    entry.async_on_unload(
        lambda: async_remove_panel(hass, slug, warn_if_unknown=False)
    )
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    return True


def _register_panel(hass: HomeAssistant, entry: ConfigEntry, slug: str) -> None:
    title = entry.title
    icon = _opt(entry, CONF_PANEL_ICON, DEFAULT_PANEL_ICON)
    js_url = f"{PANEL_STATIC_URL}/{PANEL_JS_FILENAME}"

    async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=title,
        sidebar_icon=icon,
        frontend_url_path=slug,
        config={
            "_panel_custom": {
                "name": PANEL_ELEMENT_NAME,
                "js_url": js_url,
            },
            "slug": slug,
        },
        require_admin=False,
        config_panel_domain=DOMAIN,
        update=True,
    )
    _LOGGER.debug("Registered HA Proxy panel: slug=%s title=%s", slug, title)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    slug: str = entry.data[CONF_SLUG]
    # Update instance config with new options
    if slug in hass.data.get(DOMAIN, {}).get("instances", {}):
        hass.data[DOMAIN]["instances"][slug].update(
            {
                "server": _opt(entry, CONF_SERVER, "").rstrip("/"),
                "ssl_verification": _opt(entry, CONF_SSL_VERIFICATION, DEFAULT_SSL_VERIFICATION),
                "send_ingress_path": _opt(entry, CONF_SEND_INGRESS_PATH, DEFAULT_SEND_INGRESS_PATH),
            }
        )
    _register_panel(hass, entry, slug)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a proxy instance. Cleanup via async_on_unload callbacks."""
    return True
