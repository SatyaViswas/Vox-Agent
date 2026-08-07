import { apiClient } from "./client";

// Translates voice/typed input into English before it's handed to the
// existing planner/knowledge endpoints — those endpoints never see a
// non-English string, so nothing about their own logic changes.
export async function translateText(text, sourceLang) {
  const { translated_text } = await apiClient.post("/translate", {
    text,
    source_lang: sourceLang || "auto",
  });
  return translated_text;
}
