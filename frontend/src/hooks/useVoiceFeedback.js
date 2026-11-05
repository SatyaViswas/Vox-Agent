import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeSpeech } from "../api/voice";

const STORAGE_KEY_ENABLED = "voxagent_tts_enabled";
const STORAGE_KEY_VOICE = "voxagent_tts_voice";

export const TIMBRE_VOICE_OPTIONS = [
  { name: "Shivani", label: "Shivani (Warm & Empathetic)" },
  { name: "Shubham", label: "Shubham (Energetic & Action)" },
  { name: "Avinash", label: "Avinash (Deliberate & Corporate)" },
  { name: "Devansh", label: "Devansh (Conversational & Young)" },
  { name: "Kalpana", label: "Kalpana (Composed & Clear)" },
  { name: "Lakshmi", label: "Lakshmi (Expressive Narration)" },
  { name: "Riyaa", label: "Riyaa (Confident & Proactive)" },
];

/**
 * Two-way conversational voice feedback hook powered by Gnani Timbre v3.0.
 *
 * Provides spoken responses for:
 * - Blueprint confirmations & step overviews
 * - Missing parameter / disambiguation questions
 * - Real-time telemetry completions or failures
 */
export function useVoiceFeedback({ defaultLanguage = "hi-IN" } = {}) {
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

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef(null);

  const setEnabled = useCallback((value) => {
    setEnabledState(value);
    try {
      localStorage.setItem(STORAGE_KEY_ENABLED, String(value));
    } catch {
      // ignore
    }
    if (!value && audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, []);

  const setVoice = useCallback((voiceName) => {
    setVoiceState(voiceName);
    try {
      localStorage.setItem(STORAGE_KEY_VOICE, voiceName);
    } catch {
      // ignore
    }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {
        // ignore
      }
      audioRef.current = null;
    }
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  const speak = useCallback(
    async (text, { voice: overrideVoice, language: overrideLang, force = false, onEnd = null } = {}) => {
      if (!enabled && !force) return;
      if (!text || !text.trim()) return;

      stop();
      setIsLoading(true);

      try {
        const activeVoice = overrideVoice || voice || "Shivani";
        const activeLang = overrideLang || defaultLanguage || "hi-IN";

        const { audioUrl } = await synthesizeSpeech({
          text: text.trim(),
          voice: activeVoice,
          language: activeLang,
          model: "timbre-v3.0",
        });

        const audio = new Audio(audioUrl);
        audioRef.current = audio;

        audio.onended = () => {
          setIsPlaying(false);
          setIsLoading(false);
          audioRef.current = null;
          if (onEnd) {
            try {
              onEnd();
            } catch (cbErr) {
              console.error("Error in speak onEnd callback:", cbErr);
            }
          }
        };

        audio.onerror = (e) => {
          console.error("Audio playback error:", e);
          setIsPlaying(false);
          setIsLoading(false);
          audioRef.current = null;
        };

        await audio.play();
        setIsPlaying(true);
        setIsLoading(false);
      } catch (err) {
        console.error("Failed to synthesize or play Gnani Timbre speech:", err);
        setIsLoading(false);
        setIsPlaying(false);
      }
    },
    [enabled, voice, defaultLanguage, stop]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  return {
    enabled,
    setEnabled,
    voice,
    setVoice,
    isPlaying,
    isLoading,
    speak,
    stop,
  };
}

