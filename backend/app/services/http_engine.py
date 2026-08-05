import httpx

async def execute_http_webhook(url: str, method: str = "POST", headers: dict = None, payload: dict = None) -> dict:
    if not headers:
        headers = {"Content-Type": "application/json"}
        
    try:
        async with httpx.AsyncClient() as client:
            request_kwargs = {"headers": headers}
            if payload is not None:
                request_kwargs["json"] = payload
                
            response = await client.request(method.upper(), url, **request_kwargs)
            
            try:
                data = response.json()
            except Exception:
                data = response.text

            if response.status_code >= 400:
                return {
                    "status": "error",
                    "response_code": response.status_code,
                    "error": f"Webhook returned HTTP {response.status_code}",
                    "data": data,
                }

            return {
                "status": "success",
                "response_code": response.status_code,
                "data": data
            }
    except Exception as e:
        return {"status": "error", "error": str(e)}
