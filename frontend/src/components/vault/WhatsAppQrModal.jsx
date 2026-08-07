import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, X } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { cancelWhatsAppQrSession, pollWhatsAppQrSession, startWhatsAppQrSession } from "../../api/vault";

const POLL_MS = 3000;

export default function WhatsAppQrModal({ open, onClose, onLinked }) {
  const { userId } = useAuth();
  const { t } = useTranslation();
  const [status, setStatus] = useState("starting"); // starting | waiting | linked | error
  const [qrImage, setQrImage] = useState(null);
  const [error, setError] = useState(null);

  const sessionIdRef = useRef(null);
  const pollRef = useRef(null);

  // Keep the latest onLinked without making the effect below depend on it —
  // onLinked is a fresh function identity on every parent render, and
  // calling it from inside the poll loop would otherwise re-trigger the
  // effect and reset state right after it flips to "linked".
  const onLinkedRef = useRef(onLinked);
  useEffect(() => {
    onLinkedRef.current = onLinked;
  }, [onLinked]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startSession = useCallback(async () => {
    stopPolling();
    setStatus("starting");
    setError(null);
    setQrImage(null);
    sessionIdRef.current = null;

    try {
      const res = await startWhatsAppQrSession(userId);
      sessionIdRef.current = res.session_id;
      setQrImage(res.qr_image);
      setStatus("waiting");

      pollRef.current = setInterval(async () => {
        const id = sessionIdRef.current;
        if (!id) return;
        try {
          const poll = await pollWhatsAppQrSession(id);
          if (poll.status === "linked") {
            stopPolling();
            setStatus("linked");
            onLinkedRef.current?.();
          } else if (poll.status === "waiting") {
            if (poll.qr_image) setQrImage(poll.qr_image);
          } else {
            // "expired" or "error" — the server-side session is gone either way.
            stopPolling();
            setStatus("error");
            setError(poll.error || t("vault.whatsappModal.sessionExpired"));
          }
        } catch (err) {
          stopPolling();
          setStatus("error");
          setError(err.message || t("vault.whatsappModal.lostConnection"));
        }
      }, POLL_MS);
    } catch (err) {
      setStatus("error");
      setError(err.message || t("vault.whatsappModal.startFailed"));
    }
  }, [userId, stopPolling]);

  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    startSession();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = () => {
    stopPolling();
    if (sessionIdRef.current && status !== "linked") {
      // Best-effort cleanup of the server-side browser session — don't block closing on it.
      cancelWhatsAppQrSession(sessionIdRef.current).catch(() => {});
    }
    sessionIdRef.current = null;
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative glass-panel w-full max-w-sm p-6 flex flex-col items-center gap-4">
        <div className="flex items-center justify-between w-full">
          <h2 className="font-semibold">{t("vault.whatsappModal.title")}</h2>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        {status === "linked" ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 text-emerald-500">
              <CheckCircle2 size={32} />
            </div>
            <p className="font-medium text-sm">{t("vault.whatsappModal.activeSession")}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
              {t("vault.whatsappModal.linkedDesc")}
            </p>
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 text-red-500">
              <AlertCircle size={28} />
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center">{error}</p>
            <button
              onClick={startSession}
              className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2 transition-colors"
            >
              <RefreshCw size={14} />
              {t("vault.whatsappModal.tryAgain")}
            </button>
          </div>
        ) : status === "starting" ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <Loader2 size={28} className="animate-spin text-brand-500" />
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("vault.whatsappModal.opening")}</p>
          </div>
        ) : (
          <>
            <div className="w-44 h-44 rounded-lg bg-white flex items-center justify-center overflow-hidden">
              {qrImage ? (
                <img src={qrImage} alt={t("vault.whatsappModal.qrAlt")} className="w-full h-full object-contain" />
              ) : (
                <Loader2 size={20} className="animate-spin text-brand-500" />
              )}
            </div>
            <p className="text-sm font-medium">{t("vault.whatsappModal.waitingForScan")}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
              {t("vault.whatsappModal.scanInstructions")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
