import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Keyboard,
  Loader2,
  Lock,
  RefreshCw,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { getBrowserLoginStreamUrl } from "../../api/vault";

const ZWS = "\u200B";

export default function MobileBrowserLiveView({
  sessionId,
  appName,
  onDone,
  onCancel,
  capturing = false,
  error: parentError,
}) {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const proxyInputRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [currentUrl, setCurrentUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [touchIndicator, setTouchIndicator] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [dismissedParentError, setDismissedParentError] = useState(false);

  // Focus status & virtual keyboard tracking
  const [isKeyboardActive, setIsKeyboardActive] = useState(false);
  const [inputMeta, setInputMeta] = useState({ type: "text", input_mode: "text" });
  const [proxyVal, setProxyVal] = useState(ZWS);

  // Virtual browser viewport dimensions (tracked from server frames)
  const [vw, setVw] = useState(390);
  const [vh, setVh] = useState(844);

  // Touch tracking: distinguishing tap vs scroll
  const touchTracker = useRef({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    isScrolling: false,
    startTime: 0,
  });

  const sendWs = useCallback((payload) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    setConnecting(true);
    setLocalError(null);
    setDismissedParentError(false);

    const wsUrl = getBrowserLoginStreamUrl(sessionId);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);
      setLocalError(null); // Clear error banner on successful connection
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "frame" && msg.data) {
          // Clear any error as frames are actively arriving
          setLocalError(null);
          const img = new Image();
          img.onload = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            if (canvas.width !== img.width || canvas.height !== img.height) {
              canvas.width = img.width;
              canvas.height = img.height;
              setVw(img.width);
              setVh(img.height);
            }
            ctx.drawImage(img, 0, 0);
          };
          img.src = `data:image/jpeg;base64,${msg.data}`;
          if (msg.url) setCurrentUrl(msg.url);
          if (msg.title) setPageTitle(msg.title);
        } else if (msg.type === "focus_status") {
          if (msg.is_input) {
            setIsKeyboardActive(true);
            if (msg.meta) setInputMeta(msg.meta);
          } else {
            setIsKeyboardActive(false);
            if (proxyInputRef.current && document.activeElement === proxyInputRef.current) {
              proxyInputRef.current.blur();
            }
          }
        } else if (msg.type === "status") {
          setLocalError(null);
          if (msg.url) setCurrentUrl(msg.url);
          if (msg.title) setPageTitle(msg.title);
          if (msg.width) setVw(msg.width);
          if (msg.height) setVh(msg.height);
        }
      } catch (err) {
        console.error("[MobileBrowserLiveView] message parse error:", err);
      }
    };

    ws.onerror = (err) => {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
      console.warn("[MobileBrowserLiveView] WebSocket error:", err);
      // Only set error if not yet connected
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setLocalError("Live stream connection error. Retrying...");
      }
    };

    ws.onclose = (event) => {
      setConnected(false);
      setConnecting(false);
      // Only set error on unexpected abnormal closure
      if (event.code !== 1000 && event.code !== 1001 && event.code !== 1005) {
        setLocalError("Connection closed. Retrying...");
      }
    };

    return () => {
      // Detach event listeners to prevent unmount false-positive errors
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "unmount");
      }
    };
  }, [sessionId]);

  // Normalized coordinate translation: maps user touch client coordinates directly
  // to remote browser viewport (vw x vh) with 100% precision across any screen size
  const getCanvasCoords = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0, screenX: 0, screenY: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return { x: 0, y: 0, screenX: 0, screenY: 0 };
    }

    const normX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

    const x = Math.round(normX * vw);
    const y = Math.round(normY * vh);

    return { x, y, screenX: clientX - rect.left, screenY: clientY - rect.top };
  };

  const handleTouchStart = (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchTracker.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      isScrolling: false,
      startTime: Date.now(),
    };
  };

  const handleTouchMove = (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const tracker = touchTracker.current;
    const dist = Math.hypot(touch.clientX - tracker.startX, touch.clientY - tracker.startY);

    if (dist > 10) {
      tracker.isScrolling = true;
      const deltaX = tracker.lastX - touch.clientX;
      const deltaY = tracker.lastY - touch.clientY;
      tracker.lastX = touch.clientX;
      tracker.lastY = touch.clientY;

      sendWs({
        type: "scroll",
        delta_x: Math.round(deltaX),
        delta_y: Math.round(deltaY),
      });
    }
  };

  const handleTouchEnd = (e) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    const tracker = touchTracker.current;

    // If movement was minimal, this was an intentional tap
    if (!tracker.isScrolling) {
      const coords = getCanvasCoords(touch.clientX, touch.clientY);
      triggerTap(coords.x, coords.y, coords.screenX, coords.screenY);
    }
  };

  const handleCanvasClick = (e) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    triggerTap(coords.x, coords.y, coords.screenX, coords.screenY);
  };

  const triggerTap = (x, y, screenX, screenY) => {
    setTouchIndicator({ x: screenX, y: screenY, id: Date.now() });
    setTimeout(() => setTouchIndicator(null), 300);

    // Call focus synchronously inside the touch/click event gesture
    // so mobile Safari/Chrome opens the native virtual keyboard
    if (proxyInputRef.current) {
      proxyInputRef.current.focus();
    }

    sendWs({ type: "tap", x, y });
  };

  // Hidden proxy input handler to capture native mobile keyboard input
  const handleProxyChange = (e) => {
    const nextVal = e.target.value;
    if (nextVal.length < proxyVal.length) {
      // User pressed Backspace on their mobile keyboard
      sendWs({ type: "key", key: "Backspace" });
    } else if (nextVal.length > proxyVal.length) {
      // User typed characters, pasted, or picked autocorrect/autofill
      const inserted = nextVal.replaceAll(ZWS, "");
      if (inserted) {
        sendWs({ type: "insert_text", text: inserted });
      }
    }
    setProxyVal(ZWS);
  };

  const handleProxyKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendWs({ type: "key", key: "Enter" });
      setIsKeyboardActive(false);
      proxyInputRef.current?.blur();
    } else if (e.key === "Tab") {
      e.preventDefault();
      sendWs({ type: "key", key: "Tab" });
    }
  };

  const handleToggleKeyboard = () => {
    if (isKeyboardActive) {
      setIsKeyboardActive(false);
      proxyInputRef.current?.blur();
    } else {
      setIsKeyboardActive(true);
      proxyInputRef.current?.focus();
    }
  };

  const handleReload = () => {
    sendWs({ type: "reload" });
  };

  const handleGoBack = () => {
    sendWs({ type: "go_back" });
  };

  const handleGoForward = () => {
    sendWs({ type: "go_forward" });
  };

  const handleDismissError = () => {
    setLocalError(null);
    setDismissedParentError(true);
  };

  const displayError = (!dismissedParentError && parentError) || localError;

  return (
    <div
      className="fixed inset-0 h-[100dvh] w-screen z-[150] flex flex-col bg-slate-950 text-white select-none overflow-hidden touch-none"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {/* Invisible proxy input: receives focus on tap, triggering native mobile keyboard */}
      <input
        ref={proxyInputRef}
        type={inputMeta.type || "text"}
        inputMode={inputMeta.input_mode || "text"}
        value={proxyVal}
        onChange={handleProxyChange}
        onKeyDown={handleProxyKeyDown}
        onFocus={() => setIsKeyboardActive(true)}
        onBlur={() => setIsKeyboardActive(false)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck="false"
        style={{
          position: "fixed",
          bottom: "10px",
          left: "10px",
          width: "1px",
          height: "1px",
          opacity: 0,
          pointerEvents: "none",
          zIndex: -10,
        }}
        aria-hidden="true"
      />

      {/* Top Mobile App Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={capturing}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"
            title="Cancel"
          >
            <X size={18} />
          </button>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs truncate max-w-[130px] sm:max-w-[200px]">
                {appName || "Browser Login"}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live
              </span>
            </div>
            <span className="text-[10px] text-slate-400 truncate max-w-[160px] sm:max-w-[240px]">
              {pageTitle || currentUrl || "Loading..."}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDone}
            disabled={capturing || !connected}
            className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors shadow-sm shadow-emerald-500/20"
          >
            {capturing ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            {capturing ? "Saving..." : "Save Session"}
          </button>
        </div>
      </div>

      {/* Browser Controls / Address bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/90 border-b border-white/5 text-xs shrink-0">
        <button
          type="button"
          onClick={handleGoBack}
          className="p-1 rounded text-slate-400 hover:text-white active:bg-white/10"
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          onClick={handleGoForward}
          className="p-1 rounded text-slate-400 hover:text-white active:bg-white/10"
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={handleReload}
          className="p-1 rounded text-slate-400 hover:text-white active:bg-white/10"
          title="Reload"
        >
          <RefreshCw size={13} />
        </button>

        <div className="flex-1 flex items-center gap-1.5 px-2 py-1 bg-black/40 border border-white/10 rounded-md text-[11px] text-slate-300 truncate font-mono min-w-0">
          <Lock size={10} className="text-emerald-400 shrink-0" />
          <span className="truncate">{currentUrl || "about:blank"}</span>
        </div>

        {/* Keyboard toggle helper button */}
        <button
          type="button"
          onClick={handleToggleKeyboard}
          className={`p-1.5 rounded transition-colors ${
            isKeyboardActive
              ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
              : "text-slate-400 hover:text-white active:bg-white/10"
          }`}
          title="Toggle Mobile Keyboard"
        >
          <Keyboard size={14} />
        </button>

        <div className="flex items-center text-slate-500 pl-0.5">
          {connected ? <Wifi size={13} className="text-emerald-400" /> : <WifiOff size={13} className="text-red-400" />}
        </div>
      </div>

      {displayError && (
        <div className="px-3 py-1 bg-red-500/15 border-b border-red-500/30 text-red-300 text-xs flex items-center justify-between shrink-0">
          <span className="truncate">{displayError}</span>
          <button
            type="button"
            onClick={handleDismissError}
            className="text-red-400 font-bold ml-2 p-1"
          >
            ×
          </button>
        </div>
      )}

      {/* Full-bleed Native Live Browser Canvas */}
      <div className="flex-1 w-full h-full relative overflow-hidden flex items-center justify-center bg-black select-none touch-none">
        {connecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400 z-10 bg-slate-950/80">
            <Loader2 size={24} className="animate-spin text-brand-400" />
            <p className="text-xs">Connecting to secure mobile browser...</p>
          </div>
        )}

        <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
          <canvas
            ref={canvasRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onClick={handleCanvasClick}
            className="w-full h-full block cursor-pointer select-none"
            style={{ touchAction: "none" }}
          />

          {/* Visual tap feedback ripple */}
          {touchIndicator && (
            <div
              className="absolute pointer-events-none rounded-full border-2 border-emerald-400 bg-emerald-400/30 animate-ping"
              style={{
                left: touchIndicator.x - 14,
                top: touchIndicator.y - 14,
                width: 28,
                height: 28,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
