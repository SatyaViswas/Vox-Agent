import base64
import glob
import os
import time
import traceback
import uuid
from playwright.async_api import async_playwright
from app.services.vault import save_app_credentials

WHATSAPP_URL = "https://web.whatsapp.com"
SESSION_TTL_SECONDS = 5 * 60  # abandon a session nobody has polled in 5 minutes

# In-memory registry of in-flight QR-link sessions. Each entry owns a real
# headless browser tab pointed at web.whatsapp.com; a session lives only as
# long as it takes the user to scan (or cancel/expire).
_sessions: dict[str, dict] = {}


def _find_local_chromium() -> str | None:
    patterns = [
        os.path.expanduser(
            "~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        ),
        os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
    ]
    for pattern in patterns:
        matches = glob.glob(pattern)
        if matches:
            return matches[0]
    return None


async def _capture_qr(page) -> str | None:
    """Screenshot just the QR canvas WhatsApp Web renders and return it as a
    base64 data URI the frontend can drop straight into an <img src>."""
    try:
        canvas = page.locator("canvas").first
        await canvas.wait_for(state="visible", timeout=5000)
        screenshot_bytes = await canvas.screenshot()
        return "data:image/png;base64," + base64.b64encode(screenshot_bytes).decode()
    except Exception:
        return None


async def _is_logged_in(page) -> bool:
    """WhatsApp Web swaps the QR canvas for the chat list once a scan
    succeeds. Absence of the QR alone isn't reliable (it also disappears
    during WhatsApp's own internal transitions), so confirm by waiting
    briefly for a chat-list landmark to actually show up."""
    try:
        qr_visible = await page.locator("canvas").first.is_visible()
    except Exception:
        qr_visible = False

    if qr_visible:
        return False

    try:
        await page.wait_for_selector('[aria-label="Chat list"], #pane-side', timeout=8000)
        return True
    except Exception:
        return False


async def _cleanup_session(session_id: str) -> None:
    session = _sessions.pop(session_id, None)
    if not session:
        return
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


async def start_whatsapp_qr_session(user_id: str) -> dict:
    """Launches a real headless browser against web.whatsapp.com and
    captures its live QR code — no placeholder, this is the actual code the
    user's phone needs to scan."""
    await _sweep_expired_sessions()

    playwright = await async_playwright().start()
    launch_kwargs = {"headless": True}
    executable_path = _find_local_chromium()
    if executable_path:
        launch_kwargs["executable_path"] = executable_path

    try:
        browser = await playwright.chromium.launch(**launch_kwargs)
        # WhatsApp Web's own browser-compatibility check rejects Playwright's
        # default UA (it includes a "HeadlessChrome/" token) with a "please
        # update Chrome" wall instead of ever showing a QR code. Presenting
        # as a normal desktop Chrome UA — and hiding navigator.webdriver,
        # which several sites treat as an automation signal — is what
        # actually gets the real QR to render.
        normal_ua = (
            f"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            f"(KHTML, like Gecko) Chrome/{browser.version} Safari/537.36"
        )
        context = await browser.new_context(user_agent=normal_ua, viewport={"width": 1280, "height": 900})
        await context.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
        page = await context.new_page()
        await page.goto(WHATSAPP_URL, wait_until="domcontentloaded", timeout=30000)

        session_id = str(uuid.uuid4())
        _sessions[session_id] = {
            "playwright": playwright,
            "browser": browser,
            "context": context,
            "page": page,
            "user_id": user_id,
            "created_at": time.time(),
        }

        qr_image = await _capture_qr(page)
        if not qr_image:
            await _cleanup_session(session_id)
            raise Exception("WhatsApp Web didn't show a QR code — it may already consider this session logged in, or the page failed to load.")

        return {"session_id": session_id, "status": "waiting", "qr_image": qr_image}
    except Exception:
        try:
            await playwright.stop()
        except Exception:
            pass
        raise


async def poll_whatsapp_qr_session(session_id: str) -> dict:
    session = _sessions.get(session_id)
    if not session:
        return {"status": "expired"}

    page = session["page"]
    user_id = session["user_id"]

    try:
        logged_in = await _is_logged_in(page)
    except Exception as e:
        traceback.print_exc()
        await _cleanup_session(session_id)
        return {"status": "error", "error": f"Lost connection to the WhatsApp Web page: {e}"}

    if logged_in:
        try:
            storage_state = await session["context"].storage_state()
            save_app_credentials(user_id, "WhatsApp Web", "session_cookie", storage_state)
        except Exception as e:
            traceback.print_exc()
            await _cleanup_session(session_id)
            return {"status": "error", "error": f"Scanned successfully, but failed to save the session: {e}"}

        await _cleanup_session(session_id)
        return {"status": "linked"}

    qr_image = await _capture_qr(page)
    if qr_image is None:
        await _cleanup_session(session_id)
        return {"status": "error", "error": "Lost the QR code and never reached the chat list — try linking again."}

    return {"status": "waiting", "qr_image": qr_image}


async def cancel_whatsapp_qr_session(session_id: str) -> None:
    await _cleanup_session(session_id)
