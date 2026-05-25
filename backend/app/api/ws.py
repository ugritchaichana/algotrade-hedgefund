from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import json
import asyncio
import logging
from typing import List

log = logging.getLogger(__name__)
router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        text_data = json.dumps(message)
        dead: List[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_text(text_data)
            except Exception:
                dead.append(connection)
        for d in dead:
            self.disconnect(d)


manager = ConnectionManager()


async def _authenticate(websocket: WebSocket, query_pin: str | None) -> bool:
    """Two-path authentication for WS:

    1) Query param (?pin=...) — backward compat with current frontend
    2) Handshake message {"type": "AUTH", "pin": "..."} — PIN not in URL/logs

    Rate-limited via the same `_pin_*` helpers used by /api/auth/pin to prevent brute force.
    """
    from app.main import (
        get_setting,
        _pin_attempt_allowed,
        _pin_record_failure,
        _pin_clear_failures,
    )

    client_ip = websocket.client.host if websocket.client else "unknown"
    allowed, reason = _pin_attempt_allowed(client_ip)
    if not allowed:
        log.warning(f"WS auth blocked: ip={client_ip} reason={reason}")
        await websocket.close(code=1008, reason=f"rate_limited:{reason}")
        return False

    correct_pin = get_setting("access_pin", "130944")

    # Path 1: query param
    if query_pin is not None:
        if query_pin == correct_pin:
            _pin_clear_failures(client_ip)
            return True
        _pin_record_failure(client_ip)
        await websocket.close(code=1008, reason="bad_pin_query")
        return False

    # Path 2: post-accept handshake — wait up to 5s for AUTH message
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        try:
            msg = json.loads(raw)
        except Exception:
            msg = {}
        if not isinstance(msg, dict) or msg.get("type") != "AUTH" or msg.get("pin") != correct_pin:
            _pin_record_failure(client_ip)
            await websocket.close(code=1008, reason="bad_handshake")
            return False
        _pin_clear_failures(client_ip)
        await websocket.send_text(json.dumps({"type": "AUTH_OK"}))
        return True
    except asyncio.TimeoutError:
        await websocket.close(code=1008, reason="auth_timeout")
        return False


@router.websocket("/ws/market")
async def websocket_endpoint(websocket: WebSocket, pin: str = None):
    # Path 1 (query param) handles accept itself only on success.
    # Path 2 (handshake) calls accept inside _authenticate before reading the AUTH frame.
    if pin is not None:
        ok = await _authenticate(websocket, query_pin=pin)
        if not ok:
            return
        await websocket.accept()
    else:
        ok = await _authenticate(websocket, query_pin=None)
        if not ok:
            return

    manager.active_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        log.warning(f"WS unexpected close: {e}")
        manager.disconnect(websocket)
