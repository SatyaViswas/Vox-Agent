import os
import asyncio
from app.config import settings

try:
    from composio import Composio
except ImportError:
    from composio_langchain import ComposioToolSet as Composio

# Initialize Composio safely
composio = None
if settings.COMPOSIO_API_KEY:
    try:
        composio = Composio(api_key=settings.COMPOSIO_API_KEY)
    except Exception as e:
        print(f"Warning: Failed to initialize Composio: {e}")

async def execute_composio_action(app: str, action: str, parameters: dict, entity_id: str = "default") -> dict:
    if not composio:
        return {"status": "error", "message": "COMPOSIO_API_KEY is not configured or Composio client is uninitialized."}
    
    try:
        # Execute tool via composio.tools.execute wrapped in thread for async safety
        result = await asyncio.to_thread(
            composio.tools.execute,
            action,
            parameters,
            user_id=entity_id
        )
        return {"status": "success", "output": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}

