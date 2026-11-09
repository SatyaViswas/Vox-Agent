import { apiClient } from "./client";

export function getComposioApps({ search, cursor, limit } = {}) {
  return apiClient.get("/vault/composio-apps", { params: { search, cursor, limit } });
}

export function getVaultApps(userId) {
  return apiClient.get("/vault/apps", { params: { user_id: userId } });
}

export function getComposioConnections(userId) {
  return apiClient.get("/vault/composio-connections", { params: { user_id: userId } });
}

export function getRequiredAppsStatus(userId, appNames, routes) {
  const params = { user_id: userId, apps: appNames.join(",") };
  if (routes) params.routes = routes.join(",");
  return apiClient.get("/vault/required-apps-status", { params });
}

export function introspectAppResources(userId, app, parameterKey) {
  const params = { user_id: userId, app };
  if (parameterKey) params.parameter_key = parameterKey;
  return apiClient.get("/vault/introspect-resources", { params });
}

export function disconnectComposioAccount(connectedAccountId) {
  return apiClient.delete(`/vault/composio-connections/${encodeURIComponent(connectedAccountId)}`);
}

export function connectApp(userId, appSlug) {
  return apiClient.post("/vault/connect", { user_id: userId, app_slug: appSlug });
}

export function getConnectRequirements(appSlug) {
  return apiClient.get("/vault/connect-requirements", { params: { app_slug: appSlug } });
}

export function connectAppWithCredentials(userId, appSlug, credentials) {
  return apiClient.post("/vault/connect-with-credentials", { user_id: userId, app_slug: appSlug, credentials });
}

export function saveSession({ userId, appName, authType, credentials }) {
  return apiClient.post("/vault/save-session", {
    user_id: userId,
    app_name: appName,
    auth_type: authType,
    credentials,
  });
}

export function disconnectApp(userId, appName) {
  return apiClient.delete(`/vault/apps/${encodeURIComponent(appName)}`, { params: { user_id: userId } });
}

export function getVaultNotes(userId) {
  return apiClient.get("/vault/notes", { params: { user_id: userId } });
}

export function startWhatsAppQrSession(userId) {
  return apiClient.post("/vault/whatsapp/qr", { user_id: userId });
}

export function pollWhatsAppQrSession(sessionId) {
  return apiClient.get(`/vault/whatsapp/qr/${sessionId}`);
}

export function cancelWhatsAppQrSession(sessionId) {
  return apiClient.delete(`/vault/whatsapp/qr/${sessionId}`);
}

export function startBrowserLogin({ userId, appName, loginUrl, isMobile = false, viewportWidth, viewportHeight }) {
  return apiClient.post("/vault/browser-login/start", {
    user_id: userId,
    app_name: appName,
    login_url: loginUrl,
    is_mobile: isMobile,
    viewport_width: viewportWidth,
    viewport_height: viewportHeight,
  });
}

export function getBrowserLoginStreamUrl(sessionId) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:5173";
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost:5173";
  return `${wsProto}//${host}/api/v1/vault/browser-login/stream/${sessionId}`;
}

export function captureBrowserLogin(sessionId) {
  return apiClient.post(`/vault/browser-login/${sessionId}/capture`);
}

export function cancelBrowserLogin(sessionId) {
  return apiClient.delete(`/vault/browser-login/${sessionId}`);
}

export function startTelegramLogin(userId, phoneNumber) {
  return apiClient.post("/vault/telegram/login/start", { user_id: userId, phone_number: phoneNumber });
}

export function submitTelegramCode(userId, loginId, code) {
  return apiClient.post("/vault/telegram/login/code", { user_id: userId, login_id: loginId, code });
}

export function submitTelegramPassword(userId, loginId, password) {
  return apiClient.post("/vault/telegram/login/password", { user_id: userId, login_id: loginId, password });
}

export function cancelTelegramLogin(loginId) {
  return apiClient.delete(`/vault/telegram/login/${loginId}`);
}
