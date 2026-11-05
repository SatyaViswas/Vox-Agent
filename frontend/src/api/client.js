import { normalizeUserId } from "../lib/auth";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000/api/v1";

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function getUserId() {
  return normalizeUserId(localStorage.getItem("voxagent_user_id"));
}

async function request(path, { method = "GET", body, headers = {}, params, signal } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });
  }

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const requestHeaders = {
    "X-User-Id": getUserId(),
    ...headers,
  };
  if (!isFormData && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(url.toString(), {
    method,
    headers: requestHeaders,
    body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
    signal,
  });

  const contentType = res.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await res.json().catch(() => null);
  } else if (contentType.includes("audio/") || contentType.includes("application/octet-stream")) {
    data = await res.blob();
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    throw new ApiError(data?.detail || res.statusText || "Request failed", res.status, data);
  }

  return data;
}

export const apiClient = {
  get: (path, opts) => request(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => request(path, { ...opts, method: "POST", body }),
  put: (path, body, opts) => request(path, { ...opts, method: "PUT", body }),
  patch: (path, body, opts) => request(path, { ...opts, method: "PATCH", body }),
  delete: (path, opts) => request(path, { ...opts, method: "DELETE" }),
};

export { ApiError, BASE_URL, getUserId };
