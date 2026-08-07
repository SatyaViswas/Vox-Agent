import { useCallback, useState } from "react";
import { useLanguage, VOICE_LANG_STORAGE_KEY } from "../context/LanguageContext";
import { getLanguageBySpeechCode } from "../i18n/languages";

const OVERRIDE_KEY = "voxagent_voice_lang_overridden";

function getStoredVoiceSpeechCode(siteSpeechCode) {
  try {
    const stored = localStorage.getItem(VOICE_LANG_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // ignore
  }
  return siteSpeechCode;
}

// Voice-mode language picker used by both Studio and Knowledge Hub. Defaults
// to the site-wide language (see LanguageContext) but can be overridden
// per-session; once overridden, it stops following site-language changes
// until the user clears it by picking a language again from the dropdown.
export function useVoiceLanguage() {
  const { currentLanguage } = useLanguage();
  const [speechCode, setSpeechCodeState] = useState(() => getStoredVoiceSpeechCode(currentLanguage.speechCode));

  const setVoiceLanguage = useCallback((code) => {
    setSpeechCodeState(code);
    try {
      localStorage.setItem(VOICE_LANG_STORAGE_KEY, code);
      localStorage.setItem(OVERRIDE_KEY, "true");
    } catch {
      // ignore
    }
  }, []);

  const language = getLanguageBySpeechCode(speechCode);

  return { voiceLanguage: language, setVoiceLanguage };
}
