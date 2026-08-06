import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Send, X } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { cancelTelegramLogin, startTelegramLogin, submitTelegramCode, submitTelegramPassword } from "../../api/vault";

export default function TelegramLoginModal({ mode, open, onClose, onLinked }) {
  const { userId } = useAuth();
  const [step, setStep] = useState("phone"); // phone | code | password | success
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loginId, setLoginId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setStep("phone");
    setPhoneNumber("");
    setCode("");
    setPassword("");
    setLoginId(null);
    setError(null);
  }, [open]);

  if (!open) return null;

  const handleClose = () => {
    if (loginId && step !== "success") {
      cancelTelegramLogin(loginId).catch(() => {});
    }
    onClose();
  };

  const handlePhoneSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await startTelegramLogin(userId, phoneNumber.trim());
      if (res.status === "bot_success") {
        setStep("success");
        onLinked?.();
      } else {
        setLoginId(res.login_id);
        setStep("code");
      }
    } catch (err) {
      setError(err.message || "Failed to send a login code — check the phone number and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCodeSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await submitTelegramCode(userId, loginId, code.trim());
      if (res.status === "needs_password") {
        setStep("password");
      } else {
        setStep("success");
        onLinked?.();
      }
    } catch (err) {
      setError(err.message || "That code didn't work — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await submitTelegramPassword(userId, loginId, password);
      setStep("success");
      onLinked?.();
    } catch (err) {
      setError(err.message || "Incorrect password — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative glass-panel w-full max-w-sm p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Connect {mode === "bot" ? "Telegram Bot" : "Telegram Personal Account"}</h2>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {step === "success" ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 text-emerald-500">
              <CheckCircle2 size={32} />
            </div>
            <p className="font-medium text-sm">🟢 Connected</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
              Your Telegram account is linked. VoxAgent can now detect and send messages in any chat, including
              Saved Messages.
            </p>
          </div>
        ) : step === "phone" ? (
          <form onSubmit={handlePhoneSubmit} className="flex flex-col gap-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {mode === "bot" ? (
                <>
                  Paste your Telegram Bot Token (e.g. <span className="font-mono text-slate-400">123456:ABC-DEF1234ghIkl</span>).<br/>
                  In Telegram, message @BotFather and send /newbot (or /token for existing bots) to get it.
                </>
              ) : (
                <>
                  Enter your Telegram phone number (with country code) to connect your personal account.
                </>
              )}
            </p>
            <input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              type="text"
              required
              autoFocus
              placeholder={mode === "bot" ? "123456789:ABCDefgh..." : "+15551234567"}
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
            {error && <ErrorNote message={error} />}
            <SubmitButton submitting={submitting} label="Continue" />
          </form>
        ) : step === "code" ? (
          <form onSubmit={handleCodeSubmit} className="flex flex-col gap-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Enter the code Telegram just sent to {phoneNumber}.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              type="text"
              inputMode="numeric"
              required
              autoFocus
              placeholder="12345"
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
            {error && <ErrorNote message={error} />}
            <SubmitButton submitting={submitting} label="Confirm Code" />
          </form>
        ) : (
          <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              This account has two-factor authentication enabled — enter your Telegram password.
            </p>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              autoFocus
              placeholder="••••••••"
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
            {error && <ErrorNote message={error} />}
            <SubmitButton submitting={submitting} label="Confirm Password" />
          </form>
        )}
      </div>
    </div>
  );
}

function ErrorNote({ message }) {
  return (
    <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
      <AlertCircle size={14} className="shrink-0" />
      {message}
    </div>
  );
}

function SubmitButton({ submitting, label }) {
  return (
    <button
      type="submit"
      disabled={submitting}
      className="flex items-center justify-center gap-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
    >
      {submitting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
      {submitting ? "Please wait…" : label}
    </button>
  );
}
