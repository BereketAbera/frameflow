import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig, OwnerAuthConfig } from "../config.js";

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

export function bearerToken(authorization?: string): string | undefined {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export function sessionCookie(cookie?: string): string | undefined {
  const raw = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("vp_session="))?.slice("vp_session=".length);
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

export function tokenFromRequest(headers: { authorization?: string; cookie?: string }): string | undefined {
  return bearerToken(headers.authorization) ?? sessionCookie(headers.cookie);
}

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Single-owner access for a public, read-only deployment. The owner proves possession of an access key whose
 * SHA-256 digest is configured; the browser then holds only a server-signed, expiring session, never the key.
 */
export class OwnerAccess {
  private readonly digest: Buffer;
  constructor(private readonly config: OwnerAuthConfig, private readonly now: () => number = Date.now) { this.digest = Buffer.from(config.tokenSha256, "hex"); }

  get user(): AuthUser { return { id: this.config.userId }; }
  get sessionMaxAgeSeconds(): number { return this.config.sessionMaxAgeSeconds; }

  verifyAccessKey(accessKey: string): boolean {
    return sameBytes(createHash("sha256").update(accessKey, "utf8").digest(), this.digest);
  }

  createSession(): string {
    const payload = `owner.${Math.floor(this.now() / 1000) + this.config.sessionMaxAgeSeconds}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifySession(session: string): boolean {
    const match = /^(owner\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(session);
    if (!match) return false;
    const expiry = Number(match[2]), now = Math.floor(this.now() / 1000);
    // The signature check runs before the expiry check so both rejections take the same path through the HMAC.
    const authentic = sameBytes(Buffer.from(match[3]!), Buffer.from(this.sign(match[1]!)));
    return authentic && expiry > now && expiry <= now + this.config.sessionMaxAgeSeconds;
  }

  /** A bearer header, when present, is decisive; otherwise the vp_session cookie is checked. */
  authenticate(headers: { authorization?: string; cookie?: string }): AuthUser | null {
    const accessKey = bearerToken(headers.authorization);
    if (accessKey !== undefined) return this.verifyAccessKey(accessKey) ? this.user : null;
    const session = sessionCookie(headers.cookie);
    return session && this.verifySession(session) ? this.user : null;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.config.sessionSecret).update(payload).digest("base64url");
  }
}
