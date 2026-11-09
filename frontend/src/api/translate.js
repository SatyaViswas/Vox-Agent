import { apiClient } from "./client";

// Translates voice/typed input bidirectionally:
// - To English before it reaches planning/knowledge endpoints
// - To Indic languages (e.g. Telugu, Hindi) for voice synthesis and UI clarification continuity
export async function translateText(text, sourceLang = "auto", targetLang = "en") {
  const { translated_text } = await apiClient.post("/translate", {
    text,
    source_lang: sourceLang || "auto",
    target_lang: targetLang || "en",
  });
  return translated_text;
}
