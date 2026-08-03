from fastapi import WebSocket
from typing import Any, Dict, List, Optional
import json
import logging

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        # Maps client_id to a list of active WebSocket connections
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        if client_id not in self.active_connections:
            self.active_connections[client_id] = []
        self.active_connections[client_id].append(websocket)

    def disconnect(self, websocket: WebSocket, client_id: str):
        if client_id in self.active_connections:
            if websocket in self.active_connections[client_id]:
                self.active_connections[client_id].remove(websocket)
            if not self.active_connections[client_id]:
                del self.active_connections[client_id]

    async def send_log(
        self,
        client_id: str,
        message: str,
        level: str = "info",
        screenshot_url: str | None = None,
        data: Optional[Dict[str, Any]] = None,
    ):
        if client_id in self.active_connections:
            payload = {
                "type": "log",
                "level": level,
                "message": message,
                "screenshot_url": screenshot_url,
                "data": data,
            }
            payload_str = json.dumps(payload)
            # Send to all connected clients listening on this client_id, pruning
            # any that have gone stale (e.g. a dropped connection the client
            # hasn't reconnected yet) so we don't keep retrying dead sockets or
            # leak connection objects across a long-running workflow.
            dead_connections = []
            for connection in self.active_connections[client_id]:
                try:
                    await connection.send_text(payload_str)
                except Exception as e:
                    logger.error(f"Error sending log to websocket, dropping stale connection: {e}")
                    dead_connections.append(connection)

            for connection in dead_connections:
                self.disconnect(connection, client_id)

telemetry_manager = ConnectionManager()
