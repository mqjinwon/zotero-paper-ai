/** Base64url JWT helpers (no verify — only read claims). */

function b64urlDecode(data: string): string {
  const pad = "=".repeat((4 - (data.length % 4)) % 4);
  const b64 = (data + pad).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") {
    return decodeURIComponent(
      Array.from(
        atob(b64),
        (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ).join(""),
    );
  }
  // Node
  return Buffer.from(b64, "base64").toString("utf-8");
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function jwtExp(token: string): number | null {
  const payload = jwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp : null;
}

const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const ACCOUNT_ID_CLAIM = "chatgpt_account_id";

export function jwtAccountId(accessToken: string): string | null {
  const payload = jwtPayload(accessToken);
  if (!payload) return null;
  const auth = payload[JWT_AUTH_CLAIM] as Record<string, unknown> | undefined;
  const id = auth?.[ACCOUNT_ID_CLAIM];
  return id != null ? String(id) : null;
}
