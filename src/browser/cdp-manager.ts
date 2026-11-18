import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { AppConfig } from "../config.js";

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface DoctorReport {
  cdpReachable: boolean;
  resolvedCdpUrl?: string;
  browserVersion?: string;
  totalPageTargets: number;
  closedHungTargets: string[];
  flowWorkerTabUrl?: string;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "chrome-flow" ||
    h === "host.docker.internal" ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
  );
}

export class CdpSessionManager {
  private browser: Browser | null = null;
  private workerPage: Page | null = null;

  constructor(private readonly config: AppConfig) {
    const parsed = new URL(this.config.FLOW_CDP_URL);
    if (!this.config.FLOW_ALLOW_REMOTE_CDP && !isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new Error(
        `UNSAFE_CDP_HOST: Menolak koneksi CDP ke host publik (${parsed.hostname}). Gunakan 127.0.0.1 atau jaringan internal Docker.`,
      );
    }
  }

  private async resolveCdpBaseUrl(): Promise<string> {
    const parsed = new URL(this.config.FLOW_CDP_URL);
    if (parsed.hostname !== "localhost" && net.isIP(parsed.hostname) === 0) {
      const resolved = await dns.lookup(parsed.hostname, { family: 4 });
      parsed.hostname = resolved.address;
    }
    return parsed.toString().replace(/\/+$/, "");
  }

  public async runDoctor(closeHung = false): Promise<DoctorReport> {
    let base: string;
    try {
      base = await this.resolveCdpBaseUrl();
    } catch {
      return {
        cdpReachable: false,
        totalPageTargets: 0,
        closedHungTargets: [],
      };
    }

    const verRes = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) }).catch(
      () => null,
    );
    if (!verRes || !verRes.ok) {
      return {
        cdpReachable: false,
        resolvedCdpUrl: base,
        totalPageTargets: 0,
        closedHungTargets: [],
      };
    }

    const verJson = (await verRes.json()) as { Browser?: string };
    const listRes = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(4000) });
    const targets = ((await listRes.json()) as CdpTargetInfo[]).filter((t) => t.type === "page");

    const closedHungTargets: string[] = [];
    if (closeHung) {
      for (const target of targets) {
        if (target.url.startsWith("chrome://crash") || target.title === "Aw, Snap!") {
          await fetch(`${base}/json/close/${target.id}`, {
            signal: AbortSignal.timeout(3000),
          }).catch(() => undefined);
          closedHungTargets.push(target.id);
        }
      }
    }

    return {
      cdpReachable: true,
      resolvedCdpUrl: base,
      browserVersion: verJson.Browser,
      totalPageTargets: targets.length,
      closedHungTargets,
      flowWorkerTabUrl: this.workerPage ? this.workerPage.url() : undefined,
    };
  }

  public async ensureWorkerPage(): Promise<{ context: BrowserContext; page: Page }> {
    if (this.browser && !this.browser.isConnected()) {
      this.browser = null;
      this.workerPage = null;
    }

    if (!this.browser) {
      const resolvedCdp = await this.resolveCdpBaseUrl();
      this.browser = await chromium.connectOverCDP(resolvedCdp, {
        timeout: 15_000,
      });
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.workerPage = null;
      });
    }

    const contexts = this.browser.contexts();
    const context = contexts[0] ?? (await this.browser.newContext());

    if (this.workerPage && !this.workerPage.isClosed()) {
      return { context, page: this.workerPage };
    }

    const existingFlowTab = context
      .pages()
      .find((p) => p.url().startsWith(this.config.FLOW_BASE_URL) && !p.isClosed());

    if (existingFlowTab) {
      this.workerPage = existingFlowTab;
    } else {
      this.workerPage = await context.newPage();
      await this.workerPage.goto(this.config.FLOW_BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }

    return { context, page: this.workerPage };
  }

  public async captureFailureScreenshot(label: string): Promise<string | undefined> {
    if (!this.workerPage || this.workerPage.isClosed()) return undefined;
    try {
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${safeLabel}_${Date.now()}.png`;
      const fullPath = path.join(this.config.stateDirAbs, "screenshots", filename);
      await this.workerPage.screenshot({ path: fullPath, fullPage: false });
      return fullPath;
    } catch {
      return undefined;
    }
  }

  public async gracefulDetach(): Promise<void> {
    this.workerPage = null;
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Abaikan error saat shutdown
      }
      this.browser = null;
    }
  }
}
