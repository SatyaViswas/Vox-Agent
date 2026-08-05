import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Mail, Lock, ArrowRight, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";

export default function Auth() {
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
        const { error, data } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
        
        if (!data.session) {
          setError("Account created! Please check your email to verify your account before logging in.");
          setIsLogin(true);
          return;
        }
        
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
    <div className="min-h-screen relative flex items-center justify-center p-4">
      {/* Background decorations */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 -left-40 w-[40rem] h-[40rem] rounded-full bg-brand-500/20 blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-[40rem] h-[40rem] rounded-full bg-fuchsia-500/20 blur-[100px]" />
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white mb-6 shadow-xl shadow-brand-500/25">
            <Sparkles size={24} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">
            Welcome to VoxAgent
          </h1>
          <p className="text-slate-500 dark:text-slate-400">
            {isLogin ? "Sign in to continue to your workspace" : "Create an account to get started"}
          </p>
        </div>

        <div className="glass p-8 rounded-3xl shadow-xl shadow-slate-200/20 dark:shadow-none border border-slate-200/50 dark:border-white/10">
          {error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 flex gap-3 text-sm">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium mb-2 text-slate-700 dark:text-slate-300">
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                  <Mail size={18} />
                </div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-white/10 rounded-xl py-3 pl-11 pr-4 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all placeholder:text-slate-400"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2 text-slate-700 dark:text-slate-300">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                  <Lock size={18} />
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-white/10 rounded-xl py-3 pl-11 pr-4 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all placeholder:text-slate-400"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-fuchsia-500 text-white font-semibold py-3 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-brand-500/25"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  {isLogin ? "Sign In" : "Create Account"}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 text-center text-sm">
            <span className="text-slate-500 dark:text-slate-400">
              {isLogin ? "Don't have an account? " : "Already have an account? "}
            </span>
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError(null);
              }}
              className="font-medium text-brand-600 dark:text-brand-400 hover:underline"
            >
              {isLogin ? "Sign up" : "Sign in"}
            </button>
          </div>
          
          <div className="mt-6 flex items-center gap-4">
            <div className="flex-1 border-t border-slate-200 dark:border-white/10"></div>
            <span className="text-xs text-slate-400 uppercase tracking-wider">or</span>
            <div className="flex-1 border-t border-slate-200 dark:border-white/10"></div>
          </div>
          
          <div className="mt-6 text-center">
            <button 
              onClick={handleGuest}
              className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
            >
              Continue as Guest
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
