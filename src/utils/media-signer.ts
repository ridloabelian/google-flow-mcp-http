import crypto from "node:crypto";

export class MediaUrlSigner {
  constructor(
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly ttlSeconds: number,
  ) {}

  public signFilename(filename: string): { url: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const sig = this.computeHmac(filename, exp);
    const encoded = encodeURIComponent(filename);
    return {
      url: `${this.publicBaseUrl}/media/${encoded}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  public verify(filename: string, expRaw: string | undefined, sigRaw: string | undefined): boolean {
    if (!expRaw || !sigRaw) return false;
    const exp = Number.parseInt(expRaw, 10);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
      return false;
    }
    const expected = this.computeHmac(filename, exp);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sigRaw, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private computeHmac(filename: string, exp: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`${filename}:${exp}`)
      .digest("hex");
  }
}

export function shortBufferDigest(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

export function verifyBearerToken(headerValue: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return true;
  if (!headerValue || !headerValue.startsWith("Bearer ")) return false;
  const provided = headerValue.slice("Bearer ".length).trim();
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expectedToken, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
