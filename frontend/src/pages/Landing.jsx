import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Mic, Moon, Sparkles, Sun, Zap } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

const FEATURES = [
  {
    icon: Zap,
    title: "Natural Language Automation",
    description: "Type or speak a goal — VoxAgent plans the steps and executes them across any web portal.",
  },
  {
    icon: Sparkles,
    title: "Visual Blueprint Graphs",
    description: "Watch a live flowchart of every action your agent takes, in real time, before it runs.",
  },
  {
    icon: Mic,
    title: "Voice-First Control",
    description: "Speak your instructions and let VoxAgent transcribe, plan, and act — hands-free.",
  },
];

export default function Landing() {
  const [prompt, setPrompt] = useState("");
  const navigate = useNavigate();
  const { startGuestSession } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const handleTryGuest = () => {
    startGuestSession();
    navigate("/studio");
  };

  const handleQuickPrompt = (e) => {
    e.preventDefault();
    startGuestSession();
    navigate("/studio", { state: { initialPrompt: prompt } });
  };

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-40 w-[32rem] h-[32rem] rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute top-1/3 -right-40 w-[28rem] h-[28rem] rounded-full bg-fuchsia-500/20 blur-3xl" />
      </div>

      <header className="flex items-center justify-between px-6 md:px-10 h-20">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white">
            <Sparkles size={18} />
          </div>
          <span className="font-semibold text-lg tracking-tight">
            VoxAgent<span className="text-brand-500">.</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="flex items-center justify-center w-9 h-9 rounded-full text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button 
            onClick={() => navigate("/auth")}
            className="rounded-full border border-slate-300/70 dark:border-white/15 px-4 py-2 text-sm font-medium hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
          >
            Sign In
          </button>
        </div>
      </header>

      <main className="px-6 md:px-10 pt-16 md:pt-24 pb-20 flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 mb-6">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          No signup required — instant guest access
        </div>

        <h1 className="text-4xl md:text-6xl font-bold tracking-tight max-w-3xl leading-tight">
          Automate Any Web Portal or App with <span className="text-gradient">Voice &amp; AI</span>
        </h1>

        <p className="mt-5 max-w-xl text-base md:text-lg text-slate-600 dark:text-slate-400">
          Describe what you want done in plain English. VoxAgent plans it, shows you the steps, and drives the
          browser or API for you.
        </p>

        <form onSubmit={handleQuickPrompt} className="mt-10 w-full max-w-xl">
          <div className="glass-panel flex items-center gap-2 p-2 pl-4">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              type="text"
              placeholder="e.g. Book me a table for 2 at 7pm on OpenTable"
              className="flex-1 bg-transparent outline-none text-sm md:text-base placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2.5 transition-colors shrink-0"
            >
              <span className="hidden sm:inline">Run it</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </form>

        <button
          onClick={handleTryGuest}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-500 to-fuchsia-500 text-white font-semibold px-7 py-3.5 shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 hover:scale-[1.02] transition-all"
        >
          <Zap size={18} />
          Try Instant Guest Mode
        </button>

        <div className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-5 w-full max-w-4xl text-left">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div key={title} className="glass-panel p-6">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-500/10 text-brand-500 mb-4">
                <Icon size={20} />
              </div>
              <h3 className="font-semibold mb-1.5">{title}</h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">{description}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
