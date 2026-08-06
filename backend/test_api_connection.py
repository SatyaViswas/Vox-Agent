import asyncio
import os
import time
import httpx
from typing import Dict, Any

async def verify_external_service_connection(
    api_token: str,
    base_url: str = "https://api.example.com",
    ping_endpoint: str = "/health"
) -> Dict[str, Any]:
    """
    Initializes HTTP client with Bearer authentication and verifies external API connection.
    
    Returns structured status dictionary indicating connectivity and auth status.
    """
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Accept": "application/json",
        "User-Agent": "VoxAgent-VerifyConnection/1.0"
    }

    start_time = time.perf_counter()

    async with httpx.AsyncClient(base_url=base_url, headers=headers, timeout=5.0) as client:
        try:
            # Send lightweight ping/health check
            response = await client.get(ping_endpoint)
            latency_ms = round((time.perf_counter() - start_time) * 1000, 2)

            if response.status_code == 200:
                return {
                    "success": True,
                    "status_code": 200,
                    "authenticated": True,
                    "latency_ms": latency_ms,
                    "message": "Successfully connected and authenticated with external service."
                }
            elif response.status_code in (401, 403):
                return {
                    "success": False,
                    "status_code": response.status_code,
                    "authenticated": False,
                    "latency_ms": latency_ms,
                    "error": "Authentication failed. Invalid or expired token."
                }
            else:
                return {
                    "success": False,
                    "status_code": response.status_code,
                    "authenticated": False,
                    "latency_ms": latency_ms,
                    "error": f"Received unexpected HTTP status code {response.status_code}."
                }

        except httpx.ConnectError:
            return {
                "success": False,
                "status_code": None,
                "authenticated": False,
                "error": f"Failed to connect to host '{base_url}'. Check network or host URL."
            }
        except httpx.TimeoutException:
            return {
                "success": False,
                "status_code": None,
                "authenticated": False,
                "error": "Connection timed out (exceeded 5.0s threshold)."
            }
        except Exception as e:
            return {
                "success": False,
                "status_code": None,
                "authenticated": False,
                "error": f"Unexpected error during connection test: {str(e)}"
            }

async def main():
    token = os.getenv("EXTERNAL_APP_API_TOKEN", "mock_demo_token_12345")
    # Using postman-echo for reliable live HTTP testing
    result = await verify_external_service_connection(
        api_token=token,
        base_url="https://postman-echo.com",
        ping_endpoint="/get"
    )
    print("Verification Result:", result)

if __name__ == "__main__":
    asyncio.run(main())
