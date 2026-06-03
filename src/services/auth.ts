import type { AppConfig } from "../config.js";

export type AuthUser = { id: string; email?: string };

export interface AuthVerifier {
  verify(accessToken: string): Promise<AuthUser | null>;
}

export class SupabaseAuthVerifier implements AuthVerifier {
  constructor(private readonly config: NonNullable<AppConfig["supabase"]>) {}

  async verify(accessToken: string): Promise<AuthUser | null> {
    const response = await fetch(`${this.config.url}/auth/v1/user`, {
      headers: { apikey: this.config.anonKey, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const user = await response.json() as { id?: string; email?: string };
    return user.id ? { id: user.id, email: user.email } : null;
  }
}

export function tokenFromRequest(headers: { authorization?: string; cookie?: string }): string | undefined {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const raw = headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("vp_session="))?.slice("vp_session=".length);
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}
