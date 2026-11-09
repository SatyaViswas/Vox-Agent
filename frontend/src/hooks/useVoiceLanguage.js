import { useCallback, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import { getLanguageBySpeechCode } from "../i18n/languages";

const PROMPT_LANG_STORAGE_KEY = "voxagent_prompt_speech_lang";

function getStoredPromptSpeechCode(defaultSpeechCode) {
  try {
    const stored = localStorage.getItem(PROMPT_LANG_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // ignore
  }
  return defaultSpeechCode || "indic-auto";
}

/**
 * Prompt Input Language Hook.
 *
 * Exclusively determines the language used for:
 * 1. Listening to / transcribing the user's spoken prompt via SpeechRecognition (Prisma STT).
 * 2. Translating non-English prompt inputs into English before planning.
 *
 * CRITICAL INVARIANT: Selecting a language here NEVER alters the website UI language
 * or the voice language spoken by VoxAgent (which are strictly driven by Settings).
 */
export function useVoiceLanguage() {
  const { currentLanguage } = useLanguage();
  const [speechCode, setSpeechCodeState] = useState(() => getStoredPromptSpeechCode(currentLanguage?.speechCode));

  const setVoiceLanguage = useCallback((code) => {
    setSpeechCodeState(code);
    try {
      localStorage.setItem(PROMPT_LANG_STORAGE_KEY, code);
    } catch {
      // ignore
    }
  }, []);

  const language = getLanguageBySpeechCode(speechCode);

  return { voiceLanguage: language, setVoiceLanguage };
}
