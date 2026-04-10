"""Multi-instance ingress session management and reverse proxy views."""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import TYPE_CHECKING

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    DOMAIN,
    PROXY_API_BASE,
    SESSION_API_BASE,
    SESSION_TTL,
)

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)

# aiohttp auto-decompresses upstream responses; strip these so the browser
# doesn't see a Content-Encoding claim that no longer matches the body.
STRIP_RESPONSE_HEADERS = HOP_BY_HOP_HEADERS | frozenset(
    {"content-encoding", "content-length"}
)


class IngressSessions:
    """In-memory store of short-lived ingress session tokens for one proxy instance."""

    def __init__(self) -> None:
        self._sessions: dict[str, float] = {}  # token → expiry (monotonic)

    def create(self) -> str:
        self._purge_expired()
        token = secrets.token_hex(32)
        self._sessions[token] = time.monotonic() + SESSION_TTL
        return token

    def is_valid(self, token: str) -> bool:
        expiry = self._sessions.get(token)
        if expiry is None:
            return False
        if time.monotonic() > expiry:
            del self._sessions[token]
            return False
        return True

    def _purge_expired(self) -> None:
        now = time.monotonic()
        for t in [t for t, exp in self._sessions.items() if now > exp]:
            del self._sessions[t]


def _cookie_name(slug: str) -> str:
    """Return a valid cookie name for the given slug."""
    return f"ha_proxy_{slug.replace('-', '_')}"


def _get_instance(hass: HomeAssistant, slug: str) -> dict | None:
    return hass.data.get(DOMAIN, {}).get("instances", {}).get(slug)


class HAProxySessionView(HomeAssistantView):
    """POST /api/ha_proxy_session/{slug} — exchanges a bearer token for a session cookie."""

    url = f"{SESSION_API_BASE}/{{slug}}"
    name = "api:ha_proxy:session"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def post(self, request: web.Request, slug: str) -> web.Response:  # type: ignore[override]
        instance = _get_instance(self._hass, slug)
        if instance is None:
            return web.Response(status=404, text=f"No proxy instance '{slug}'")

        token = instance["sessions"].create()
        response = web.Response(status=200, text="OK")
        response.set_cookie(
            _cookie_name(slug),
            token,
            path=f"{PROXY_API_BASE}/{slug}",
            httponly=True,
            samesite="Lax",
            max_age=SESSION_TTL,
            secure=request.secure,
        )
        return response


class HAProxyView(HomeAssistantView):
    """Reverse proxy for /api/ha_proxy/{slug}/{path} — HTTP and WebSocket."""

    url = f"{PROXY_API_BASE}/{{slug}}/{{path:.*}}"
    name = "api:ha_proxy"
    requires_auth = False
    cors_allowed = False

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    def _check_session(self, request: web.Request, slug: str, instance: dict) -> bool:
        token = request.cookies.get(_cookie_name(slug))
        return token is not None and instance["sessions"].is_valid(token)

    async def _handle(self, request: web.Request, slug: str, path: str) -> web.StreamResponse:
        instance = _get_instance(self._hass, slug)
        if instance is None:
            return web.Response(status=404, text=f"No proxy instance '{slug}'")
        if not self._check_session(request, slug, instance):
            return web.Response(status=401, text="Unauthorized — no valid session")

        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await self._proxy_websocket(request, slug, path, instance)
        return await self._proxy_http(request, slug, path, instance)

    get = _handle
    post = _handle
    put = _handle
    patch = _handle
    delete = _handle

    async def _proxy_http(
        self,
        request: web.Request,
        slug: str,
        path: str,
        instance: dict,
    ) -> web.StreamResponse:
        server = instance["server"]
        target_url = f"{server}/{path}"
        if request.query_string:
            target_url = f"{target_url}?{request.query_string}"

        req_headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP_HEADERS and k.lower() != "host"
        }
        if instance["send_ingress_path"]:
            req_headers["X-Ingress-Path"] = f"{PROXY_API_BASE}/{slug}"
        req_headers["X-Forwarded-For"] = request.remote or ""

        ssl = None if instance["ssl_verification"] else False

        try:
            session = async_get_clientsession(self._hass, verify_ssl=instance["ssl_verification"])
            resp = await session.request(
                method=request.method,
                url=target_url,
                headers=req_headers,
                data=request.content if request.can_read_body else None,
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=300),
                ssl=ssl,
            )
        except aiohttp.ClientError as err:
            _LOGGER.error("[ha_proxy/%s] Upstream request failed: %s", slug, err)
            return web.Response(status=502, text=f"Bad Gateway: {err}")

        resp_headers = {
            k: v
            for k, v in resp.headers.items()
            if k.lower() not in STRIP_RESPONSE_HEADERS
        }

        stream = web.StreamResponse(status=resp.status, headers=resp_headers)
        await stream.prepare(request)
        async for chunk in resp.content.iter_chunked(65536):
            await stream.write(chunk)
        await stream.write_eof()
        return stream

    async def _proxy_websocket(
        self,
        request: web.Request,
        slug: str,
        path: str,
        instance: dict,
    ) -> web.WebSocketResponse:
        server = instance["server"]
        ws_url = (
            server.replace("http://", "ws://").replace("https://", "wss://")
        )
        target_url = f"{ws_url}/{path}"
        if request.query_string:
            target_url = f"{target_url}?{request.query_string}"

        req_headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in HOP_BY_HOP_HEADERS and k.lower() != "host"
        }

        ssl = None if instance["ssl_verification"] else False
        ws_client = web.WebSocketResponse()
        await ws_client.prepare(request)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(target_url, headers=req_headers, ssl=ssl) as ws_server:
                    async def c2s() -> None:
                        async for msg in ws_client:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await ws_server.send_str(msg.data)
                            elif msg.type == aiohttp.WSMsgType.BINARY:
                                await ws_server.send_bytes(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                                break

                    async def s2c() -> None:
                        async for msg in ws_server:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await ws_client.send_str(msg.data)
                            elif msg.type == aiohttp.WSMsgType.BINARY:
                                await ws_client.send_bytes(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                                break

                    tasks = [asyncio.ensure_future(c2s()), asyncio.ensure_future(s2c())]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for t in pending:
                        t.cancel()
                        try:
                            await t
                        except asyncio.CancelledError:
                            pass
        except aiohttp.ClientError as err:
            _LOGGER.error("[ha_proxy/%s] WebSocket error: %s", slug, err)
            await ws_client.close(code=1011, message=b"Upstream error")

        return ws_client
