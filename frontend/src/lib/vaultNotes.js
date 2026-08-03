export function normalizeNote(note) {
  const rawContent = note.content ?? note.payload ?? note.data ?? note.text ?? note.raw_text ?? "";

  // The real vault_notes schema only has title/content(jsonb)/created_at —
  // agent/source/timestamp context is folded into the content object itself
  // (see save_vault_note in the backend) rather than being separate columns.
  const isWrapped =
    rawContent && typeof rawContent === "object" && !Array.isArray(rawContent) && "data" in rawContent;
  const innerData = isWrapped ? rawContent.data : rawContent;
  const contentText = typeof innerData === "string" ? innerData : JSON.stringify(innerData, null, 2);

  return {
    id: note.id,
    title: note.title || note.summary_title || (isWrapped && rawContent.source_app) || note.app_name || "Untitled Note",
    agentName:
      note.agent_name || (isWrapped && rawContent.agent_name) || note.agent_title || note.agent_id || "Unknown Agent",
    source: note.source_url || (isWrapped && rawContent.source_app) || note.source_app || note.app_name || note.url || "—",
    contentText,
    createdAt: note.created_at || (isWrapped && rawContent.extracted_at) || note.executed_at || note.timestamp || null,
  };
}

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function notesToCsv(notes) {
  const header = ["Title", "Agent", "Source", "Content", "Timestamp"];
  const rows = notes.map((n) => [n.title, n.agentName, n.source, n.contentText, n.createdAt || ""].map(csvEscape).join(","));
  return [header.join(","), ...rows].join("\n");
}

export function notesToJson(notes) {
  return JSON.stringify(notes, null, 2);
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
