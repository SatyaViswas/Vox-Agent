import asyncio
import time
import traceback
import uuid
from playwright.async_api import async_playwright
from app.services.browser_stealth import apply_stealth, chromium_launch_kwargs, desktop_user_agent
from app.services.vault import save_app_credentials

SESSION_TTL_SECONDS = 10 * 60  # abandon a session nobody has captured/cancelled in 10 minutes

# In-memory registry of in-flight "log in in a real browser window" sessions
# — see whatsapp_engine.py's _sessions for the pattern this mirrors. Each
# entry owns a real HEADED (visible) browser window the user interacts with
# directly: they log in exactly as they normally would (typing their real
# password, solving any CAPTCHA/2FA themselves), which is indistinguishable
# from ordinary human browsing to the target site — no automation signal at
# all during login, unlike driving the login form via an LLM agent. Once the
# user confirms they're done, capture_browser_login_session reads the
# resulting cookies straight out of the browser and stores them the exact
# same way execute_browser_action already knows how to consume them.
_sessions: dict[str, dict] = {}


async def _cleanup_session(session_id: str) -> None:
    session = _sessions.pop(session_id, None)
    if not session:
        return
    if session.get("cdp"):
        try:
            await session["cdp"].send("Page.stopScreencast")
        except Exception:
            pass
        try:
            await session["cdp"].detach()
        except Exception:
            pass
    try:
        await session["browser"].close()
    except Exception:
        traceback.print_exc()
    finally:
        try:
            await session["playwright"].stop()
        except Exception:
            traceback.print_exc()


async def _sweep_expired_sessions() -> None:
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s["created_at"] > SESSION_TTL_SECONDS]
    for sid in expired:
        await _cleanup_session(sid)


async def start_browser_login_session(user_id: str, app_name: str, login_url: str | None) -> dict:
    """Opens a real, visible Chromium window (headless=False) — nothing is
    driven automatically here; the user takes over from this point and logs
    in themselves. Returns immediately so the caller can show a "waiting on
    you" state while the window stays open on the user's own screen."""
    await _sweep_expired_sessions()

    playwright = await async_playwright().start()

    try:
        browser = await playwright.chromium.launch(**chromium_launch_kwargs(headless=False))
        context = await browser.new_context(viewport=None, user_agent=desktop_user_agent(browser.version))
        await apply_stealth(context)
        page = await context.new_page()
        if login_url:
            try:
                await page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
            except Exception:
                # Even a slow/unreachable login URL shouldn't block the
                # window from opening — the user can still navigate there
                # themselves once it's up.
                traceback.print_exc()

        session_id = str(uuid.uuid4())

        def _on_disconnected():
            # The user closed the window directly instead of clicking
            # Done/Cancel in the UI — still clean up instead of leaking the
            # in-memory session entry and its now-orphaned playwright driver
            # connection. The browser process itself is already gone by the
            # time this fires, so only stop() the driver, not close() it.
            session = _sessions.pop(session_id, None)
            if session:
                asyncio.create_task(session["playwright"].stop())

        browser.on("disconnected", lambda: _on_disconnected())

        _sessions[session_id] = {
            "playwright": playwright,
            "browser": browser,
            "context": context,
            "user_id": user_id,
            "app_name": app_name,
            "login_url": login_url,
            "created_at": time.time(),
        }

        return {"session_id": session_id, "status": "waiting"}
    except Exception:
        try:
            await playwright.stop()
        except Exception:
            pass
        raise


async def start_mobile_browser_login_session(
    user_id: str,
    app_name: str,
    login_url: str | None,
    width: int = 390,
    height: int = 844,
) -> dict:
    """Opens a headless mobile-emulated browser context with low-latency CDP
    screencasting. Runs entirely headless on the server so no desktop window
    pops up on the laptop, streaming frames and mapping touch gestures directly
    to the mobile phone over WebSocket."""
    await _sweep_expired_sessions()

    playwright = await async_playwright().start()

    try:
        browser = await playwright.chromium.launch(**chromium_launch_kwargs(headless=True))
        mobile_ua = (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
        )
        context = await browser.new_context(
            viewport={"width": width, "height": height},
            user_agent=mobile_ua,
            is_mobile=True,
            has_touch=True,
            device_scale_factor=1,
        )
        await apply_stealth(context)
        page = await context.new_page()

        if login_url:
            clean_url = login_url.strip()
            if not clean_url.startswith("http://") and not clean_url.startswith("https://"):
                clean_url = f"https://{clean_url}"
            try:
                await page.goto(clean_url, wait_until="domcontentloaded", timeout=30000)
            except Exception:
                traceback.print_exc()

        session_id = str(uuid.uuid4())
        cdp = await context.new_cdp_session(page)
        session_state = {"title": ""}

        # Explicitly lock CDP device metrics to exact mobile viewport dimensions
        # This prevents CDP from defaulting to 500x757 desktop metrics and squishing the mobile view
        await cdp.send("Emulation.setDeviceMetricsOverride", {
            "width": width,
            "height": height,
            "deviceScaleFactor": 1,
            "mobile": True,
            "fitWindow": False,
        })

        async def _update_title():
            try:
                session_state["title"] = await asyncio.wait_for(page.title(), timeout=1.0)
            except Exception:
                pass

        page.on("domcontentloaded", lambda: asyncio.create_task(_update_title()))
        page.on("load", lambda: asyncio.create_task(_update_title()))

        async def _on_screencast_frame(event):
            sess = _sessions.get(session_id)
            if not sess:
                return
            frame_session_id = event.get("sessionId")
            current_ws = sess.get("ws_client")
            if not current_ws:
                try:
                    await cdp.send("Page.screencastFrameAck", {"sessionId": frame_session_id})
                except Exception:
                    pass
                return
            data = event.get("data")
            try:
                await current_ws.send_json({
                    "type": "frame",
                    "data": data,
                    "url": getattr(page, "url", ""),
                    "title": session_state.get("title", ""),
                    "metadata": event.get("metadata", {}),
                })
            except Exception:
                pass
            finally:
                try:
                    await cdp.send("Page.screencastFrameAck", {"sessionId": frame_session_id})
                except Exception:
                    pass

        cdp.on("Page.screencastFrame", lambda e: asyncio.create_task(_on_screencast_frame(e)))

        await cdp.send("Page.startScreencast", {
            "format": "jpeg",
            "quality": 70,
            "maxWidth": width,
            "maxHeight": height,
            "everyNthFrame": 1,
        })

        def _on_disconnected():
            session = _sessions.pop(session_id, None)
            if session:
                asyncio.create_task(session["playwright"].stop())

        browser.on("disconnected", lambda: _on_disconnected())

        _sessions[session_id] = {
            "playwright": playwright,
            "browser": browser,
            "context": context,
            "page": page,
            "cdp": cdp,
            "user_id": user_id,
            "app_name": app_name,
            "login_url": login_url,
            "created_at": time.time(),
            "is_mobile": True,
            "width": width,
            "height": height,
            "ws_client": None,
            "state": session_state,
        }

        return {"session_id": session_id, "status": "waiting", "is_mobile": True}
    except Exception:
        try:
            await playwright.stop()
        except Exception:
            pass
        raise


async def handle_mobile_stream(websocket, session_id: str) -> None:
    session = _sessions.get(session_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found or expired")
        return

    await websocket.accept()
    session["ws_client"] = websocket
    cdp = session["cdp"]
    page = session["page"]

    try:
        await websocket.send_json({
            "type": "status",
            "status": "connected",
            "url": getattr(page, "url", ""),
            "title": session.get("state", {}).get("title", ""),
            "width": session.get("width", 390),
            "height": session.get("height", 844),
        })
    except Exception:
        pass

    try:
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")

            if msg_type == "tap":
                x = int(msg.get("x", 0))
                y = int(msg.get("y", 0))
                try:
                    await page.touchscreen.tap(x, y)
                except Exception:
                    try:
                        await page.mouse.click(x, y)
                    except Exception as e:
                        print(f"Error handling tap at ({x}, {y}): {e}")

                # After tapping, check if an input element is active/focused
                try:
                    focused_info = await page.evaluate("""() => {
                        const el = document.activeElement;
                        if (!el) return null;
                        const tag = (el.tagName || '').toLowerCase();
                        const isInput = tag === 'input' || tag === 'textarea' || el.isContentEditable;
                        if (!isInput) return null;
                        return {
                            is_input: true,
                            tag: tag,
                            type: el.type || 'text',
                            input_mode: el.inputMode || (el.type === 'number' ? 'numeric' : (el.type === 'email' ? 'email' : 'text')),
                            value: el.value || '',
                        };
                    }""")
                    await websocket.send_json({
                        "type": "focus_status",
                        "is_input": bool(focused_info and focused_info.get("is_input")),
                        "meta": focused_info or {},
                    })
                except Exception:
                    pass

            elif msg_type == "scroll":
                delta_x = int(msg.get("delta_x", 0))
                delta_y = int(msg.get("delta_y", 0))
                try:
                    await page.mouse.wheel(delta_x, delta_y)
                except Exception as e:
                    print(f"Error handling scroll: {e}")

            elif msg_type == "insert_text":
                text = str(msg.get("text") or "")
                if text:
                    try:
                        await page.keyboard.insert_text(text)
                    except Exception:
                        try:
                            await cdp.send("Input.insertText", {"text": text})
                        except Exception as e:
                            print(f"Error handling insert_text: {e}")

            elif msg_type == "key":
                key = str(msg.get("key") or "")
                if key:
                    try:
                        await page.keyboard.press(key)
                    except Exception as e:
                        print(f"Error handling key press: {e}")

            elif msg_type == "navigate":
                nav_url = str(msg.get("url") or "").strip()
                if nav_url:
                    if not nav_url.startswith("http://") and not nav_url.startswith("https://"):
                        nav_url = f"https://{nav_url}"
                    try:
                        await page.goto(nav_url, wait_until="domcontentloaded", timeout=30000)
                    except Exception as e:
                        print(f"Error navigating to {nav_url}: {e}")

            elif msg_type == "reload":
                try:
                    await page.reload(wait_until="domcontentloaded")
                except Exception:
                    pass

            elif msg_type == "go_back":
                try:
                    await page.go_back(wait_until="domcontentloaded")
                except Exception:
                    pass

            elif msg_type == "go_forward":
                try:
                    await page.go_forward(wait_until="domcontentloaded")
                except Exception:
                    pass

    except Exception:
        pass
    finally:
        session["ws_client"] = None


async def capture_browser_login_session(session_id: str) -> dict:
    """Called once the user says they've finished logging in. Reads the
    browser's current cookie jar and hands it to save_app_credentials in
    exactly the shape execute_browser_action already reads back out (see
    browser_engine.py: any credential with a "cookies" key is passed
    straight into Playwright's storage_state) — no new storage format, no
    changes needed on the execution side."""
    session = _sessions.get(session_id)
    if not session:
        return {"status": "error", "error": "This login session has expired or was already completed — try connecting again."}

    try:
        storage_state = await session["context"].storage_state()
        page = session.get("page")
        current_page_url = getattr(page, "url", None) if page else None
        configured_url = session.get("login_url") or current_page_url
        if configured_url:
            storage_state["url"] = configured_url
    except Exception as e:
        traceback.print_exc()
        await _cleanup_session(session_id)
        return {"status": "error", "error": f"Lost connection to the browser window: {e}"}

    if not storage_state.get("cookies"):
        # Don't cleanup — let the user go back and actually log in, then
        # click Done again, instead of forcing them to restart the whole
        # flow over a window that's still open and usable.
        return {"status": "error", "error": "No cookies were found yet — make sure you're fully logged in, then click Done again."}

    try:
        save_app_credentials(session["user_id"], session["app_name"], "session_cookie", storage_state)
    except Exception as e:
        traceback.print_exc()
        await _cleanup_session(session_id)
        return {"status": "error", "error": f"Logged in successfully, but failed to save the session: {e}"}

    await _cleanup_session(session_id)
    return {"status": "success", "cookie_count": len(storage_state.get("cookies") or [])}


async def cancel_browser_login_session(session_id: str) -> None:
    await _cleanup_session(session_id)
