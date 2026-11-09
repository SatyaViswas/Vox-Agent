// Unicode block ranges for Indic scripts (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam)
// Plus Arabic/Persian/Urdu ranges. Deliberately excludes European typographic characters like em-dash (—), curly quotes (‘’), etc.
const INDIC_AND_NON_LATIN_SCRIPT_RE = /[\u0600-\u06FF\u0900-\u0D7F\u0E00-\u0E7F]/;

export function looksNonEnglish(text) {
  if (!text) return false;
  return INDIC_AND_NON_LATIN_SCRIPT_RE.test(text);
}

// Whether the translate-before-planning step should run. Deliberately does
// NOT trust the voice/site language picker as the source of truth — a user
// can speak/type in a different language than what's selected (or forget to
// switch it), so translation is triggered by what the text actually looks
// like, with the picker only adding "always translate" for a language the
// user explicitly chose that isn't English.
export function needsTranslation(text, selectedUiCode) {
  return selectedUiCode !== "en" || looksNonEnglish(text);
}
