"""Config flow for HA Proxy integration."""
from __future__ import annotations

import re
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_NAME,
    CONF_PANEL_ICON,
    CONF_SEND_INGRESS_PATH,
    CONF_SERVER,
    CONF_SLUG,
    CONF_SSL_VERIFICATION,
    DEFAULT_PANEL_ICON,
    DEFAULT_SEND_INGRESS_PATH,
    DEFAULT_SSL_VERIFICATION,
    DOMAIN,
)


def _name_to_slug(name: str) -> str:
    """Convert a display name to a URL/cookie-safe slug."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-") or "proxy"


def _schema(defaults: dict[str, Any] | None = None, include_name: bool = True) -> vol.Schema:
    d = defaults or {}
    fields: dict = {}
    if include_name:
        fields[vol.Required(CONF_NAME, default=d.get(CONF_NAME, ""))] = str
    fields.update(
        {
            vol.Required(CONF_SERVER, default=d.get(CONF_SERVER, "http://")): str,
            vol.Optional(CONF_PANEL_ICON, default=d.get(CONF_PANEL_ICON, DEFAULT_PANEL_ICON)): str,
            vol.Optional(
                CONF_SSL_VERIFICATION,
                default=d.get(CONF_SSL_VERIFICATION, DEFAULT_SSL_VERIFICATION),
            ): bool,
            vol.Optional(
                CONF_SEND_INGRESS_PATH,
                default=d.get(CONF_SEND_INGRESS_PATH, DEFAULT_SEND_INGRESS_PATH),
            ): bool,
        }
    )
    return vol.Schema(fields)


async def _test_connection(hass: Any, server: str, verify_ssl: bool) -> str | None:
    """Return an error key if the server is unreachable, else None."""
    try:
        session = async_get_clientsession(hass, verify_ssl=verify_ssl)
        async with session.get(
            server.rstrip("/") + "/",
            timeout=aiohttp.ClientTimeout(total=10),
            ssl=None if verify_ssl else False,
            allow_redirects=True,
        ):
            pass
    except aiohttp.InvalidURL:
        return "invalid_url"
    except aiohttp.ClientError:
        return "cannot_connect"
    return None


class HAProxyConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            name: str = user_input[CONF_NAME].strip()
            slug = _name_to_slug(name)
            server = user_input[CONF_SERVER].rstrip("/")
            verify_ssl = user_input.get(CONF_SSL_VERIFICATION, DEFAULT_SSL_VERIFICATION)

            await self.async_set_unique_id(slug)
            self._abort_if_unique_id_configured()

            error = await _test_connection(self.hass, server, verify_ssl)
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=name,
                    data={
                        CONF_NAME: name,
                        CONF_SLUG: slug,
                        CONF_SERVER: server,
                        CONF_PANEL_ICON: user_input.get(CONF_PANEL_ICON, DEFAULT_PANEL_ICON),
                        CONF_SSL_VERIFICATION: verify_ssl,
                        CONF_SEND_INGRESS_PATH: user_input.get(
                            CONF_SEND_INGRESS_PATH, DEFAULT_SEND_INGRESS_PATH
                        ),
                    },
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(user_input),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> HAProxyOptionsFlow:
        return HAProxyOptionsFlow(config_entry)


class HAProxyOptionsFlow(OptionsFlow):
    """Edit options for an existing proxy entry."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}
        current = {**self._config_entry.data, **self._config_entry.options}

        if user_input is not None:
            server = user_input[CONF_SERVER].rstrip("/")
            verify_ssl = user_input.get(CONF_SSL_VERIFICATION, DEFAULT_SSL_VERIFICATION)

            error = await _test_connection(self.hass, server, verify_ssl)
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title="",
                    data={
                        CONF_SERVER: server,
                        CONF_PANEL_ICON: user_input.get(CONF_PANEL_ICON, DEFAULT_PANEL_ICON),
                        CONF_SSL_VERIFICATION: verify_ssl,
                        CONF_SEND_INGRESS_PATH: user_input.get(
                            CONF_SEND_INGRESS_PATH, DEFAULT_SEND_INGRESS_PATH
                        ),
                    },
                )

        return self.async_show_form(
            step_id="init",
            data_schema=_schema(current, include_name=False),
            errors=errors,
        )
