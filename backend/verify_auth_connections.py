#!/usr/bin/env python3
"""
Standalone Authentication Verifier
===================================
A clean, self-contained Python script to test and verify:
1. Telegram Bot API Token authentication (via `getMe`).
2. OAuth 2.0 Token & Handshake connection status.

Usage:
    python verify_auth_connections.py
"""

import asyncio
import os
import sys
import httpx
from typing import Dict, Any, Optional

# ==========================================
# 1. Telegram Bot Token Verification
# ==========================================
async def verify_telegram_bot_token(bot_token: str) -> Dict[str, Any]:
    """
    Verifies a Telegram Bot Token by calling Telegram's `getMe` endpoint.
    """
    if not bot_token or bot_token == "YOUR_TELEGRAM_BOT_TOKEN":
        return {
            "service": "Telegram Bot API",
            "success": False,
            "error": "No valid Telegram Bot Token provided."
        }

    url = f"https://api.telegram.org/bot{bot_token}/getMe"
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(url)
            data = response.json()
            
            if response.status_code == 200 and data.get("ok"):
                bot_info = data.get("result", {})
                return {
                    "service": "Telegram Bot API",
                    "success": True,
                    "status_code": 200,
                    "bot_id": bot_info.get("id"),
                    "bot_name": bot_info.get("first_name"),
                    "username": f"@{bot_info.get('username')}",
                    "message": "Telegram Bot token authenticated successfully."
                }
            else:
                return {
                    "service": "Telegram Bot API",
                    "success": False,
                    "status_code": response.status_code,
                    "error": data.get("description", "Authentication failed.")
                }
        except httpx.RequestError as exc:
            return {
                "service": "Telegram Bot API",
                "success": False,
                "error": f"Network error contacting Telegram API: {exc}"
            }

# ==========================================
# 2. OAuth 2.0 Handshake & Token Verification
# ==========================================
async def verify_oauth_connection(
    token_or_code: str,
    token_endpoint: str = "https://oauth2.googleapis.com/token",
    client_id: Optional[str] = None,
    client_secret: Optional[str] = None,
    grant_type: str = "authorization_code",
    userinfo_endpoint: Optional[str] = None
) -> Dict[str, Any]:
    """
    Verifies an OAuth 2.0 handshake (exchanging code/credentials or validating an access token).
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            # Case A: If userinfo_endpoint is provided, test an existing Access Token
            if userinfo_endpoint:
                headers = {"Authorization": f"Bearer {token_or_code}"}
                response = await client.get(userinfo_endpoint, headers=headers)
                
                if response.status_code == 200:
                    return {
                        "service": "OAuth 2.0 Verification",
                        "success": True,
                        "status_code": 200,
                        "user_data": response.json(),
                        "message": "OAuth access token successfully validated."
                    }
                else:
                    return {
                        "service": "OAuth 2.0 Verification",
                        "success": False,
                        "status_code": response.status_code,
                        "error": f"OAuth token invalid or expired (HTTP {response.status_code})."
                    }

            # Case B: Standard OAuth 2.0 Token Exchange / Verification Handshake
            payload = {
                "grant_type": grant_type,
                "client_id": client_id,
                "client_secret": client_secret,
            }

            if grant_type == "authorization_code":
                payload["code"] = token_or_code
            elif grant_type == "refresh_token":
                payload["refresh_token"] = token_or_code

            response = await client.post(token_endpoint, data=payload)
            data = response.json()

            if response.status_code == 200 and "access_token" in data:
                return {
                    "service": "OAuth 2.0 Handshake",
                    "success": True,
                    "status_code": 200,
                    "token_type": data.get("token_type", "Bearer"),
                    "expires_in": data.get("expires_in"),
                    "message": "OAuth 2.0 token handshake completed successfully."
                }
            else:
                return {
                    "service": "OAuth 2.0 Handshake",
                    "success": False,
                    "status_code": response.status_code,
                    "error": data.get("error_description") or data.get("error") or "OAuth handshake failed."
                }

        except httpx.RequestError as exc:
            return {
                "service": "OAuth 2.0 Verification",
                "success": False,
                "error": f"Network error during OAuth handshake: {exc}"
            }

# ==========================================
# Main Execution Runner
# ==========================================
async def main():
    print("=" * 60)
    print("      AUTH & API CONNECTION VERIFICATION SUITE")
    print("=" * 60)

    # 1. Telegram Bot Token from environment or sample fallback
    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN", "")

    print("\n[1/2] Verifying Telegram Bot API Token...")
    if not telegram_token:
        print("  -> TELEGRAM_BOT_TOKEN environment variable not set.")
        print("  -> Testing placeholder token response...")
        telegram_token = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"

    tg_result = await verify_telegram_bot_token(telegram_token)
    if tg_result["success"]:
        print(f"  [SUCCESS] {tg_result['message']}")
        print(f"            Bot: {tg_result['bot_name']} ({tg_result['username']}) | ID: {tg_result['bot_id']}")
    else:
        print(f"  [FAILED]  Status: {tg_result.get('status_code', 'N/A')} | Error: {tg_result['error']}")

    # 2. OAuth Verification Test (using public postman-echo for clean demo)
    print("\n[2/2] Testing OAuth 2.0 Access Token Check...")
    oauth_result = await verify_oauth_connection(
        token_or_code="test_access_token_abc123",
        userinfo_endpoint="https://postman-echo.com/get"
    )
    if oauth_result["success"]:
        print(f"  [SUCCESS] {oauth_result['message']}")
    else:
        print(f"  [FAILED]  Status: {oauth_result.get('status_code', 'N/A')} | Error: {oauth_result['error']}")

    print("\n" + "=" * 60)

if __name__ == "__main__":
    asyncio.run(main())
