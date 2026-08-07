// Any character outside the printable ASCII range is a strong signal the
// text isn't plain English (covers all the Indian-regional scripts plus
// accented/non-Latin international text) — used as a cheap client-side
// trigger for whether a translate call is worth making at all. Restricted
// to the printable range (space–tilde) rather than the full byte range so
// ordinary whitespace/control characters never trigger a false positive.
const NON_ASCII_RE = /[^ -~\s]/;

export function looksNonEnglish(text) {
  return NON_ASCII_RE.test(text);
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
