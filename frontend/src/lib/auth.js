// Supabase's user_id columns are typed `uuid`, so the guest sentinel must be a
// real UUID — this matches the backend's own default (e.g. AgentCreateRequest,
// get_agents) rather than an arbitrary string like "default".
export const GUEST_USER_ID = "00000000-0000-0000-0000-000000000000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeUserId(id) {
  return id && UUID_RE.test(id) ? id : GUEST_USER_ID;
}
