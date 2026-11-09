import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowRight,
  ChevronLeft,
  Loader2,
  Lock,
  Mail,
  Sparkles,
  Zap,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { apiClient } from "../api/client";

export default function Auth() {
  const { t } = useTranslation();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const navigate = useNavigate();
  const { startGuestSession } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isLogin) {
        const { error, data } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        navigate("/studio");
      } else {
        // Use custom backend endpoint to bypass Supabase email rate limits
        try {
          await apiClient.post("/auth/signup", { email, password });
        } catch (apiError) {
          throw new Error(apiError.message || t("auth.signupFailed"));
        }

        // After successful custom signup, sign in automatically
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError) throw signInError;
        navigate("/studio");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGuest = () => {
    startGuestSession();
    navigate("/studio");
  };

  return (
    <div className="min-h-[100dvh] relative flex flex-col justify-between p-4 pt-[env(safe-area-inset-top,1rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
      {/* Background ambient lighting */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -left-32 w-80 sm:w-[38rem] h-80 sm:h-[38rem] rounded-full bg-brand-500/20 blur-[90px]" />
        <div className="absolute bottom-0 right-0 w-80 sm:w-[38rem] h-80 sm:h-[38rem] rounded-full bg-fuchsia-500/20 blur-[90px]" />
      </div>

      {/* Top back navigation */}
      <div className="w-full max-w-md mx-auto flex items-center justify-between py-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-500 hover:text-brand-500 active:scale-95 transition-all touch-manipulation py-1.5 px-2 rounded-xl hover:bg-slate-900/5 dark:hover:bg-white/5"
        >
          <ChevronLeft size={16} />
          <span>Home</span>
        </Link>
      </div>

      {/* Card Container */}
      <div className="w-full max-w-md mx-auto my-auto py-4">
        {/* Header Icon & Title */}
        <div className="text-center mb-6 sm:mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white mb-4 shadow-lg shadow-brand-500/30">
            <Sparkles size={22} />
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight mb-1.5">
            {t("auth.welcome")}
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            {isLogin ? t("auth.signInSubtitle") : t("auth.signUpSubtitle")}
          </p>
        </div>

        {/* Form Card */}
        <div className="glass-panel p-6 sm:p-8 rounded-3xl shadow-xl shadow-slate-200/20 dark:shadow-none border border-slate-200/60 dark:border-white/10">
          {error && (
            <div className="mb-5 p-3.5 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 flex gap-2.5 text-xs sm:text-sm animate-fadeIn">
              <AlertCircle size={17} className="shrink-0 mt-0.5" />
              <p className="leading-relaxed">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs sm:text-sm font-medium mb-1.5 text-slate-700 dark:text-slate-300">
                {t("auth.emailLabel")}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Mail size={18} />
                </div>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-50/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-2xl py-3 pl-11 pr-4 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 transition-all placeholder:text-slate-400 min-h-[48px]"
                  placeholder={t("auth.emailPlaceholder")}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium mb-1.5 text-slate-700 dark:text-slate-300">
                {t("auth.passwordLabel")}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock size={18} />
                </div>
                <input
                  type="password"
                  required
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-50/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-2xl py-3 pl-11 pr-4 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 transition-all placeholder:text-slate-400 min-h-[48px]"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 active:scale-[0.98] text-white font-bold text-sm sm:text-base py-3.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-brand-500/25 min-h-[48px] touch-manipulation mt-2"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  <span>{isLogin ? t("auth.signIn") : t("auth.createAccount")}</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          {/* Toggle between Sign In & Sign Up */}
          <div className="mt-6 text-center text-xs sm:text-sm">
            <span className="text-slate-500 dark:text-slate-400">
              {isLogin ? t("auth.noAccount") : t("auth.hasAccount")}{" "}
            </span>
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError(null);
              }}
              className="font-bold text-brand-600 dark:text-brand-400 hover:underline active:opacity-80 py-1"
            >
              {isLogin ? t("auth.signUp") : t("auth.switchToSignIn")}
            </button>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <div className="flex-1 border-t border-slate-200 dark:border-white/10" />
            <span className="text-xs text-slate-400 uppercase tracking-wider">{t("common.or")}</span>
            <div className="flex-1 border-t border-slate-200 dark:border-white/10" />
          </div>

          {/* Full-width Instant Guest Access Button */}
          <button
            type="button"
            onClick={handleGuest}
            className="mt-5 w-full flex items-center justify-center gap-2 rounded-2xl border border-slate-300/80 dark:border-white/15 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-[0.98] text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200 py-3 min-h-[44px] transition-all touch-manipulation"
          >
            <Zap size={15} className="text-brand-500" />
            <span>{t("auth.continueAsGuest")}</span>
          </button>
        </div>
      </div>

      {/* Footer info */}
      <div className="text-center text-xs text-slate-400 py-2">
        <p>Protected by sovereign biometric and token authentication.</p>
      </div>
    </div>
  );
}
