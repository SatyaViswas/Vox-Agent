import { apiClient, BASE_URL } from "./client";

export function planWorkflow(prompt, userId) {
  return apiClient.post("/plan", { prompt, user_id: userId });
}

function mapTriggerType(triggerType) {
  if (triggerType === "schedule") return "scheduled";
  // "webhook" is what the planner emits for "whenever X happens, do Y" —
  // reactive automations that should wait for an event rather than run once
  // immediately or on a timer. Surfaced as its own "event_trigger" category
  // rather than collapsing into "on_demand".
  if (triggerType === "webhook") return "event_trigger";
  return "on_demand";
}

export function createAgent({ title, originalPrompt, blueprint, userId }) {
  const trigger = blueprint?.trigger;
  return apiClient.post("/agents", {
    title,
    original_prompt: originalPrompt,
    json_blueprint: blueprint,
    trigger_type: mapTriggerType(trigger?.type),
    cron_schedule: trigger?.cron ?? null,
    user_id: userId,
  });
}

export function executeAgent(agentId, userId) {
  return apiClient.post(`/execute/${agentId}`, undefined, { params: { user_id: userId } });
}

export function resumeAgent(agentId, answer) {
  return apiClient.post(`/agents/${agentId}/resume`, { answer });
}

export function getTriggerStatus(agentId) {
  return apiClient.get(`/agents/${agentId}/trigger-status`);
}

export function getAgentLogs(agentId, { limit, offset } = {}) {
  return apiClient.get(`/agents/${agentId}/logs`, { params: { limit, offset } });
}

export function getAgents(userId) {
  return apiClient.get("/agents", { params: { user_id: userId } });
}

export function updateAgentSchedule(agentId, { triggerType, cronSchedule, status }) {
  return apiClient.patch(`/agents/${agentId}/schedule`, {
    trigger_type: triggerType,
    cron_schedule: cronSchedule ?? null,
    status,
  });
}

export function updateAgent(agentId, payload) {
  return apiClient.put(`/agents/${agentId}`, payload);
}

export function deleteAgent(agentId) {
  return apiClient.delete(`/agents/${agentId}`);
}

export function telemetrySocketUrl(clientId) {
  const wsBase = BASE_URL.replace(/^http/, "ws");
  return `${wsBase}/ws/telemetry/${clientId}`;
}
