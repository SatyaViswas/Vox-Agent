import { BASE_URL, getUserId, ApiError } from "./client.js";

/**
 * Ingest knowledge from a file, URL, or raw text.
 * Uses FormData since the backend accepts multipart.
 */
export async function ingestKnowledge({ file, url, text, name }) {
  const userId = getUserId();
  const form = new FormData();
  if (file) form.append("file", file);
  if (url) form.append("url", url);
  if (text) form.append("text", text);
  if (name) form.append("custom_name", name);

  const res = await fetch(`${BASE_URL}/knowledge/ingest`, {
    method: "POST",
    headers: { "X-User-Id": userId },
    body: form,
  });

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();

  if (!res.ok) {
    throw new ApiError(
      data?.detail || res.statusText || "Ingest failed",
      res.status,
      data
    );
  }
  return data;
}

/** Get all knowledge sources for the current user. */
export async function getKnowledgeSources() {
  const userId = getUserId();
  const res = await fetch(`${BASE_URL}/knowledge/`, {
    headers: { "X-User-Id": userId },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.detail || "Failed to fetch", res.status, data);
  return data;
}

/** Delete a knowledge source by its source_name. */
export async function deleteKnowledgeSource(sourceName) {
  const userId = getUserId();
  const res = await fetch(
    `${BASE_URL}/knowledge/${encodeURIComponent(sourceName)}`,
    { method: "DELETE", headers: { "X-User-Id": userId } }
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.detail || "Failed to delete", res.status, data);
  return data;
}

export async function getKnowledgeSourceContent(sourceName) {
  const userId = getUserId();
  const res = await fetch(`${BASE_URL}/knowledge/${encodeURIComponent(sourceName)}`, {
    headers: { "X-User-Id": userId },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.detail || "Failed to fetch content", res.status, data);
  return data;
}

export async function renameKnowledgeSource(sourceName, newName) {
  const userId = getUserId();
  const res = await fetch(`${BASE_URL}/knowledge/${encodeURIComponent(sourceName)}/rename`, {
    method: "PATCH",
    headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: newName }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.detail || "Failed to rename", res.status, data);
  return data;
}

export async function updateKnowledgeSource(sourceName, content) {
  const userId = getUserId();
  const res = await fetch(`${BASE_URL}/knowledge/${encodeURIComponent(sourceName)}`, {
    method: "PUT",
    headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.detail || "Failed to update", res.status, data);
  return data;
}
