import { useCallback, useEffect, useState } from "react";
import { synthesizeSpeech, synthesizeClonedVoice } from "../api/voice";
import { useLanguage } from "../context/LanguageContext";
import { translateText } from "../api/translate";

const STORAGE_KEY_ENABLED = "voxagent_tts_enabled";
const STORAGE_KEY_VOICE = "voxagent_tts_voice";
const STORAGE_KEY_CLONED_VOICE = "voxagent_cloned_voice";

export const TIMBRE_VOICE_OPTIONS = [
  { name: "Shivani", label: "Shivani (Warm & Empathetic)" },
  { name: "Shubham", label: "Shubham (Energetic & Action)" },
  { name: "Avinash", label: "Avinash (Deliberate & Corporate)" },
  { name: "Devansh", label: "Devansh (Conversational & Young)" },
  { name: "Kalpana", label: "Kalpana (Composed & Clear)" },
  { name: "Lakshmi", label: "Lakshmi (Expressive Narration)" },
  { name: "Riyaa", label: "Riyaa (Confident & Proactive)" },
];

// In-memory instant cache for pre-translated strings and synthesized audio blobs
const speechTranslationCache = new Map();
const audioBlobCache = new Map();

// Pending notification speech queue (ensures voice completes current sentence before speaking notification)
const speechQueue = [];

// =========================================================================
// Centralized Sovereign Voice Playback Manager
//
// Guarantees:
// 1. Mobile Scroll Immunity: Unlocking uses a detached dummy Audio instance.
//    Touching or scrolling on mobile NEVER touches or interrupts the speech audio.
// 2. DOM-Attached Media Node: Audio element is appended to document.body with
//    playsinline, protecting it from mobile WebKit scroll-throttling.
// 3. Notification Speech Chaining: When a notification arrives while speech is
//    active, it waits for the current sentence to end, then announces cleanly.
// 4. Zero-Repetition Guarantee: Blobs are played once with duration known upfront.
// =========================================================================

let globalAudioElement = null;
let isAudioUnlocked = false;
let globalUtteranceId = 0;
let lastSpokenText = "";
let lastSpokenTime = 0;
let globalIsPlaying = false;
let globalIsLoading = false;
const globalStateSubscribers = new Set();

function notifySubscribers() {
  globalStateSubscribers.forEach((fn) => {
    try {
      fn({ isPlaying: globalIsPlaying, isLoading: globalIsLoading });
    } catch {
      // ignore
    }
  });
}

function getGlobalAudio() {
  if (!globalAudioElement && typeof window !== "undefined") {
    let el = document.getElementById("voxagent-global-audio");
    if (!el && document.body) {
      el = document.createElement("audio");
      el.id = "voxagent-global-audio";
      el.style.display = "none";
      el.preload = "auto";
      el.playsInline = true;
      el.setAttribute("playsinline", "true");
      el.setAttribute("webkit-playsinline", "true");
      document.body.appendChild(el);
    }
    globalAudioElement = el || new Audio();
    globalAudioElement.preload = "auto";
    try {
      globalAudioElement.playsInline = true;
    } catch {
      // ignore
    }
  }
  return globalAudioElement;
}

function unlockMobileAudio() {
  if (isAudioUnlocked || typeof window === "undefined") return;
  isAudioUnlocked = true;
  try {
    // Standalone dummy Audio object specifically for unlocking mobile browser permissions.
    // NEVER touches globalAudioElement, ensuring scrolling never stops real speech!
    const unlocker = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
    const playPromise = unlocker.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          unlocker.pause();
        })
        .catch(() => {});
    }
  } catch {
    // ignore
  }
  window.removeEventListener("touchstart", unlockMobileAudio, true);
  window.removeEventListener("touchend", unlockMobileAudio, true);
  window.removeEventListener("click", unlockMobileAudio, true);
}

if (typeof window !== "undefined") {
  window.addEventListener("touchstart", unlockMobileAudio, { passive: true, capture: true });
  window.addEventListener("click", unlockMobileAudio, { passive: true, capture: true });
}

export function stopGlobalSpeech() {
  globalUtteranceId++;
  speechQueue.length = 0; // Clear any pending queued speech
  if (globalAudioElement) {
    try {
      globalAudioElement.pause();
      globalAudioElement.currentTime = 0;
      globalAudioElement.onended = null;
      globalAudioElement.onerror = null;
      globalAudioElement.removeAttribute("src");
      globalAudioElement.load();
    } catch {
      // ignore
    }
  }
  globalIsPlaying = false;
  globalIsLoading = false;
  notifySubscribers();
}

/**
 * Queues a notification spoken update.
 * If the voice is already actively speaking, it completes the current sentence first,
 * then speaks the notification. If not speaking, it plays immediately.
 */
export function queueVoiceNotification(text, options = {}) {
  if (!text || !text.trim()) return;
  const cleanText = text.trim();

  // Deduplication Guard: Never queue or announce identical notification phrases within 10s
  const now = Date.now();
  if (lastSpokenText === cleanText && now - lastSpokenTime < 10000) {
    return;
  }
  if (speechQueue.some((item) => item.text === cleanText)) {
    return;
  }

  if (globalIsPlaying) {
    speechQueue.push({ text: cleanText, options });
    return;
  }

  speakGlobal(cleanText, { ...options, force: true });
}

/**
 * Pre-warms the top frequent status phrases in the background so they trigger in 0ms.
 */
let isPrewarming = false;
async function prewarmFrequentPhrases(voice = "Shivani", language = "en-IN") {
  if (isPrewarming || typeof window === "undefined") return;
  isPrewarming = true;
  const phrases = [
    "Drafting your workflow blueprint now...",
    "Starting your workflow now...",
    "Workflow details saved. Ready to run.",
    "Workflow execution completed successfully! All actions were carried out.",
    "The workflow encountered an error during execution.",
  ];

  for (const p of phrases) {
    const cacheKey = `${voice}:${language}:${p}`;
    if (!audioBlobCache.has(cacheKey)) {
      try {
        const res = await synthesizeSpeech({
          text: p,
          voice,
          language,
          model: "timbre-v3.0",
          speed: 1.05,
          container: "mp3",
        });
        if (res?.audioUrl) {
          audioBlobCache.set(cacheKey, res.audioUrl);
        }
      } catch {
        // best effort pre-warm
      }
    }
  }
  isPrewarming = false;
}

export async function speakGlobal(
  text,
  {
    voice = "Shivani",
    language = "en-IN",
    speed = 1.05,
    force = false,
    onEnd = null,
  } = {}
) {
  if (!text || !text.trim()) return;
  const cleanText = text.trim();

  // Deduplication Guard: Reject identical phrases spoken within 3.5 seconds unless forced
  const now = Date.now();
  if (!force && lastSpokenText === cleanText && (now - lastSpokenTime) < 3500) {
    return;
  }
  lastSpokenText = cleanText;
  lastSpokenTime = now;

  // Halt any previous audio and cancel any in-flight preparation
  stopGlobalSpeech();

  const thisUtteranceId = ++globalUtteranceId;
  globalIsLoading = true;
  globalIsPlaying = false;
  notifySubscribers();

  try {
    const activeVoice = voice || "Shivani";
    const activeLang = language || "en-IN";

    let textToSynthesize = cleanText;

    // Safety Net: Translate pure English strings to target Indic language if active site language is Indic
    const isTargetIndic = activeLang && !activeLang.toLowerCase().startsWith("en");
    const hasIndicScript = /[\u0900-\u0D7F]/.test(textToSynthesize);

    if (isTargetIndic && !hasIndicScript) {
      const transKey = `${activeLang}:${textToSynthesize}`;
      if (speechTranslationCache.has(transKey)) {
        textToSynthesize = speechTranslationCache.get(transKey);
      } else {
        try {
          const langCode = activeLang.split("-")[0];
          const localized = await translateText(textToSynthesize, "en", langCode);
          if (thisUtteranceId !== globalUtteranceId) return; // Superseded
          if (localized && localized.trim()) {
            textToSynthesize = localized.trim();
            speechTranslationCache.set(transKey, textToSynthesize);
          }
        } catch (tErr) {
          console.warn("[useVoiceFeedback] Fallback translation failed:", tErr);
        }
      }
    }

    if (thisUtteranceId !== globalUtteranceId) return;

    let audioUrl = null;
    const cacheKey = `${activeVoice}:${activeLang}:${textToSynthesize}`;

    // 1. Instant Cache Hit (0ms Latency)
    if (audioBlobCache.has(cacheKey)) {
      audioUrl = audioBlobCache.get(cacheKey);
    }

    // 2. Custom Cloned Voice Check (Gnani VC)
    if (!audioUrl && activeVoice === "custom-clone") {
      try {
        const rawClone = localStorage.getItem(STORAGE_KEY_CLONED_VOICE);
        if (rawClone) {
          const parsedClone = JSON.parse(rawClone);
          if (parsedClone?.embedding) {
            const res = await synthesizeClonedVoice({
              text: textToSynthesize,
              speaker_embedding: parsedClone.embedding,
              language: activeLang,
              container: "mp3",
            });
            if (thisUtteranceId !== globalUtteranceId) return;
            audioUrl = res?.audioUrl;
          }
        }
      } catch (cloneErr) {
        console.warn("Cloned voice synthesis failed, falling back to Timbre:", cloneErr);
      }
    }

    // 3. Fast MP3 Blob Synthesis (~600ms)
    if (!audioUrl) {
      const fallbackVoice = activeVoice === "custom-clone" ? "Shivani" : activeVoice;
      const res = await synthesizeSpeech({
        text: textToSynthesize,
        voice: fallbackVoice,
        language: activeLang,
        model: "timbre-v3.0",
        speed,
        container: "mp3",
      });

      if (thisUtteranceId !== globalUtteranceId) return;
      if (res?.audioUrl) {
        audioUrl = res.audioUrl;
        audioBlobCache.set(cacheKey, audioUrl);
      }
    }

    if (!audioUrl || thisUtteranceId !== globalUtteranceId) return;

    const audio = getGlobalAudio();
    audio.src = audioUrl;

    audio.onended = () => {
      if (thisUtteranceId === globalUtteranceId) {
        globalIsPlaying = false;
        globalIsLoading = false;
        notifySubscribers();
        if (onEnd) {
          try {
            onEnd();
          } catch (cbErr) {
            console.error("Error in onEnd callback:", cbErr);
          }
        }

        // Check if there are queued notifications waiting to be announced
        if (speechQueue.length > 0) {
          const next = speechQueue.shift();
          setTimeout(() => {
            speakGlobal(next.text, { ...next.options, force: true });
          }, 350);
        }
      }
    };

    audio.onerror = (e) => {
      // NEVER retry or replay on error!
      if (thisUtteranceId === globalUtteranceId) {
        console.warn("[useVoiceFeedback] Audio playback error:", e);
        globalIsPlaying = false;
        globalIsLoading = false;
        notifySubscribers();
      }
    };

    try {
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        await playPromise;
      }
      if (thisUtteranceId === globalUtteranceId) {
        globalIsPlaying = true;
        globalIsLoading = false;
        notifySubscribers();
      }
    } catch (playErr) {
      if (playErr.name === "AbortError") {
        return; // Interrupted by user action or subsequent speech
      }
      console.warn("[useVoiceFeedback] Audio play error:", playErr);
      if (thisUtteranceId === globalUtteranceId) {
        globalIsPlaying = false;
        globalIsLoading = false;
        notifySubscribers();
      }
    }
  } catch (err) {
    if (thisUtteranceId === globalUtteranceId) {
      console.error("[useVoiceFeedback] Failed to synthesize speech:", err);
      globalIsLoading = false;
      globalIsPlaying = false;
      notifySubscribers();
    }
  }
}

/**
 * Two-way conversational voice feedback hook powered by Gnani Timbre v3.0.
 */
export function useVoiceFeedback({ defaultLanguage } = {}) {
  const langContext = useLanguage ? useLanguage() : null;

  const resolvedSpeechLang = (() => {
    const siteUi = langContext?.siteLanguage || (() => {
      try {
        return localStorage.getItem("voxagent_site_lang");
      } catch {
        return null;
      }
    })();

    if (siteUi === "en") return "en-IN";
    if (siteUi === "te") return "te-IN";
    if (siteUi === "hi") return "hi-IN";
    if (siteUi === "ta") return "ta-IN";
    if (siteUi === "kn") return "kn-IN";
    if (siteUi === "bn") return "bn-IN";
    if (siteUi === "mr") return "mr-IN";
    if (siteUi === "gu") return "gu-IN";
    if (siteUi === "pa") return "pa-IN";
    if (siteUi === "ml") return "ml-IN";

    const code = langContext?.currentLanguage?.speechCode;
    if (code && code !== "indic-auto") {
      return code === "en-US" ? "en-IN" : code;
    }

    if (defaultLanguage && defaultLanguage !== "indic-auto") {
      return defaultLanguage === "en-US" ? "en-IN" : defaultLanguage;
    }

    return "en-IN";
  })();

  const [enabled, setEnabledState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_ENABLED);
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  const [voice, setVoiceState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_VOICE) || "Shivani";
    } catch {
      return "Shivani";
    }
  });

  const [isPlaying, setIsPlaying] = useState(globalIsPlaying);
  const [isLoading, setIsLoading] = useState(globalIsLoading);

  // Subscribe to global speech state
  useEffect(() => {
    const handleStateChange = (state) => {
      setIsPlaying(state.isPlaying);
      setIsLoading(state.isLoading);
    };
    globalStateSubscribers.add(handleStateChange);
    return () => {
      globalStateSubscribers.delete(handleStateChange);
    };
  }, []);

  // Pre-warm frequent phrases in background after mount
  useEffect(() => {
    const timer = setTimeout(() => {
      prewarmFrequentPhrases(voice, resolvedSpeechLang);
    }, 1200);
    return () => clearTimeout(timer);
  }, [voice, resolvedSpeechLang]);

  // Synchronize voice selection when changed from Settings
  useEffect(() => {
    const handleSync = () => {
      try {
        const v = localStorage.getItem(STORAGE_KEY_VOICE);
        if (v && v !== voice) setVoiceState(v);
        const e = localStorage.getItem(STORAGE_KEY_ENABLED);
        if (e !== null) setEnabledState(e === "true");
      } catch {}
    };
    window.addEventListener("storage", handleSync);
    window.addEventListener("voxagent_voice_changed", handleSync);
    return () => {
      window.removeEventListener("storage", handleSync);
      window.removeEventListener("voxagent_voice_changed", handleSync);
    };
  }, [voice]);

  const setEnabled = useCallback((value) => {
    setEnabledState(value);
    try {
      localStorage.setItem(STORAGE_KEY_ENABLED, String(value));
    } catch {}
    if (!value) {
      stopGlobalSpeech();
    }
  }, []);

  const setVoice = useCallback((voiceName) => {
    setVoiceState(voiceName);
    try {
      localStorage.setItem(STORAGE_KEY_VOICE, voiceName);
    } catch {}
  }, []);

  const stop = useCallback(() => {
    stopGlobalSpeech();
  }, []);

  const speak = useCallback(
    async (text, options = {}) => {
      if (!enabled && !options.force) return;
      return speakGlobal(text, {
        voice: options.voice || voice || "Shivani",
        language: options.language || resolvedSpeechLang || "en-IN",
        speed: options.speed || 1.05,
        ...options,
      });
    },
    [enabled, voice, resolvedSpeechLang]
  );

  return {
    enabled,
    setEnabled,
    voice,
    setVoice,
    speechLanguage: resolvedSpeechLang,
    isPlaying,
    isLoading,
    speak,
    stop,
  };
}
