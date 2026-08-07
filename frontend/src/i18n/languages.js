// Single source of truth for every language the app supports — both the
// voice-mode speech picker (Studio / Knowledge Hub) and the site-wide UI
// language switcher (Settings) read from this list.
//
// speechCode: BCP-47 tag passed to the Web Speech API (SpeechRecognition.lang)
// uiCode: i18next language key (matches a file in src/i18n/locales/)

export const LANGUAGES = [
  { uiCode: "en", speechCode: "en-US", label: "English", nativeLabel: "English", group: "international" },

  // Indian regional
  { uiCode: "hi", speechCode: "hi-IN", label: "Hindi", nativeLabel: "हिंदी", group: "indian" },
  { uiCode: "bn", speechCode: "bn-IN", label: "Bengali", nativeLabel: "বাংলা", group: "indian" },
  { uiCode: "ta", speechCode: "ta-IN", label: "Tamil", nativeLabel: "தமிழ்", group: "indian" },
  { uiCode: "te", speechCode: "te-IN", label: "Telugu", nativeLabel: "తెలుగు", group: "indian" },
  { uiCode: "mr", speechCode: "mr-IN", label: "Marathi", nativeLabel: "मराठी", group: "indian" },
  { uiCode: "gu", speechCode: "gu-IN", label: "Gujarati", nativeLabel: "ગુજરાતી", group: "indian" },
  { uiCode: "kn", speechCode: "kn-IN", label: "Kannada", nativeLabel: "ಕನ್ನಡ", group: "indian" },
  { uiCode: "ml", speechCode: "ml-IN", label: "Malayalam", nativeLabel: "മലയാളം", group: "indian" },
  { uiCode: "pa", speechCode: "pa-IN", label: "Punjabi", nativeLabel: "ਪੰਜਾਬੀ", group: "indian" },
  { uiCode: "ur", speechCode: "ur-IN", label: "Urdu", nativeLabel: "اردو", group: "indian" },

  // International
  { uiCode: "es", speechCode: "es-ES", label: "Spanish", nativeLabel: "Español", group: "international" },
  { uiCode: "fr", speechCode: "fr-FR", label: "French", nativeLabel: "Français", group: "international" },
  { uiCode: "de", speechCode: "de-DE", label: "German", nativeLabel: "Deutsch", group: "international" },
  { uiCode: "pt", speechCode: "pt-BR", label: "Portuguese", nativeLabel: "Português", group: "international" },
  { uiCode: "ar", speechCode: "ar-SA", label: "Arabic", nativeLabel: "العربية", group: "international" },
  { uiCode: "zh", speechCode: "zh-CN", label: "Chinese (Simplified)", nativeLabel: "中文", group: "international" },
  { uiCode: "ja", speechCode: "ja-JP", label: "Japanese", nativeLabel: "日本語", group: "international" },
  { uiCode: "ru", speechCode: "ru-RU", label: "Russian", nativeLabel: "Русский", group: "international" },
];

export const DEFAULT_LANGUAGE = LANGUAGES[0]; // English

export function getLanguageByUiCode(uiCode) {
  return LANGUAGES.find((l) => l.uiCode === uiCode) || DEFAULT_LANGUAGE;
}

export function getLanguageBySpeechCode(speechCode) {
  return LANGUAGES.find((l) => l.speechCode === speechCode) || DEFAULT_LANGUAGE;
}

export const INDIAN_LANGUAGES = LANGUAGES.filter((l) => l.group === "indian");
export const INTERNATIONAL_LANGUAGES = LANGUAGES.filter((l) => l.group === "international" && l.uiCode !== "en");
