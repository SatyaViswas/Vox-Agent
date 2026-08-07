import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import i18n, { STORAGE_KEY } from "../i18n";
import { getLanguageByUiCode, LANGUAGES } from "../i18n/languages";

export const VOICE_LANG_STORAGE_KEY = "voxagent_voice_lang";
const VOICE_LANG_OVERRIDE_KEY = "voxagent_voice_lang_overridden";

const LanguageContext = createContext(null);

function getInitialSiteLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LANGUAGES.some((l) => l.uiCode === stored)) return stored;
  } catch {
    // ignore
  }
  return "en";
}

export function LanguageProvider({ children }) {
  const [siteLanguage, setSiteLanguageState] = useState(getInitialSiteLanguage);

  useEffect(() => {
    document.documentElement.lang = siteLanguage;
    const lang = getLanguageByUiCode(siteLanguage);
    document.documentElement.dir = lang.uiCode === "ur" || lang.uiCode === "ar" ? "rtl" : "ltr";
  }, [siteLanguage]);

  const setSiteLanguage = useCallback((uiCode) => {
    i18n.changeLanguage(uiCode);
    setSiteLanguageState(uiCode);
    try {
      localStorage.setItem(STORAGE_KEY, uiCode);
    } catch {
      // ignore
    }

    // Voice mode follows the site language by default — but only until the
    // user manually overrides the voice picker themselves (tracked below).
    try {
      const overridden = localStorage.getItem(VOICE_LANG_OVERRIDE_KEY) === "true";
      if (!overridden) {
        const speechCode = getLanguageByUiCode(uiCode).speechCode;
        localStorage.setItem(VOICE_LANG_STORAGE_KEY, speechCode);
      }
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(
    () => ({ siteLanguage, setSiteLanguage, currentLanguage: getLanguageByUiCode(siteLanguage) }),
    [siteLanguage, setSiteLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within a LanguageProvider");
  return ctx;
}
