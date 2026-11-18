import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright-core";
import { loadSelectorMap, type AppConfig, type SelectorMap } from "../config.js";
import type { CdpSessionManager } from "../browser/cdp-manager.js";
import type { FlowJobQueue, FlowJobRecord } from "../queue/job-queue.js";
import { MediaUrlSigner, shortBufferDigest } from "../utils/media-signer.js";

const execFileAsync = promisify(execFile);

export type ProgressCallback = (msg: string) => Promise<void>;

export interface GenerateMediaInput {
  kind: "image" | "video";
  prompt: string;
  model?: string;
  aspectRatio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  count?: number;
  projectUrl?: string;
  referenceImagePaths?: string[];
  dryRun?: boolean;
  maxCredits?: number;
  resumeJobId?: string;
}

export class GoogleFlowController {
  constructor(
    private readonly config: AppConfig,
    private readonly cdp: CdpSessionManager,
    private readonly queue: FlowJobQueue,
    private readonly signer: MediaUrlSigner,
  ) {}

  private getSelectors(): SelectorMap {
    return loadSelectorMap(this.config.selectorsPathAbs);
  }

  private async delay(ms?: number): Promise<void> {
    const wait = ms ?? this.config.FLOW_ACTION_DELAY_MS;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  public async getStatus() {
    const doctor = await this.cdp.runDoctor(false);
    if (!doctor.cdpReachable) {
      return {
        ok: false,
        cdpReachable: false,
        signedIn: false,
        message: `Chrome CDP tidak merespons di ${this.config.FLOW_CDP_URL}. Jalankan scripts/start-chrome-cdp.sh atau container chrome-flow.`,
        queue: this.queue.getQueueMetrics(),
      };
    }

    const { page } = await this.cdp.ensureWorkerPage();
    if (!page.url().startsWith(this.config.FLOW_BASE_URL)) {
      await page.goto(this.config.FLOW_BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await this.delay(600);

    const uiState = await page.evaluate(() => {
      const currentUrl = window.location.href;
      const isAuthWall =
        currentUrl.includes("accounts.google.com") ||
        Boolean(document.querySelector('a[href*="accounts.google.com/ServiceLogin"]'));
      const bodyText = document.body?.innerText ?? "";
      const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const creditMatch = bodyText.match(/([\d,]+)\s*(?:AI\s*)?credits?/i);
      return {
        currentUrl,
        signedIn: !isAuthWall,
        detectedEmail: emailMatch ? emailMatch[0] : null,
        detectedCreditsBalance: creditMatch ? Number(creditMatch[1].replace(/,/g, "")) : null,
        pageTitle: document.title,
      };
    });

    if (
      this.config.FLOW_EXPECTED_EMAIL &&
      uiState.detectedEmail &&
      uiState.detectedEmail.toLowerCase() !== this.config.FLOW_EXPECTED_EMAIL.toLowerCase()
    ) {
      return {
        ok: false,
        cdpReachable: true,
        ...uiState,
        accountMismatch: true,
        message: `Akun aktif (${uiState.detectedEmail}) tidak cocok dengan FLOW_EXPECTED_EMAIL (${this.config.FLOW_EXPECTED_EMAIL}).`,
        queue: this.queue.getQueueMetrics(),
      };
    }

    return {
      ok: uiState.signedIn,
      cdpReachable: true,
      browserVersion: doctor.browserVersion,
      ...uiState,
      queue: this.queue.getQueueMetrics(),
    };
  }

  public async listModels() {
    const map = this.getSelectors();
    const { page } = await this.cdp.ensureWorkerPage();

    const liveTrpcModels = await page
      .evaluate(async (endpoint) => {
        try {
          const res = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      }, map.urls.trpcVideoModels)
      .catch(() => null);

    return {
      source: liveTrpcModels ? "live_in_tab_trpc" : "configured_catalog",
      configuredModels: map.models,
      liveVideoModelConfig: liveTrpcModels,
    };
  }

  public async listHistory(limit = 20) {
    const map = this.getSelectors();
    const { page } = await this.cdp.ensureWorkerPage();

    const trpcData = await page
      .evaluate(async (endpoint) => {
        try {
          const res = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      }, map.urls.trpcUserHistory)
      .catch(() => null);

    const domTiles = await this.collectDomTiles(page, map, limit);
    return {
      recentServerJobs: this.queue.listRecentJobs(limit),
      domTilesCount: domTiles.length,
      domTiles,
      rawHistoryAvailable: Boolean(trpcData),
    };
  }

  public async createProject(projectName: string) {
    const map = this.getSelectors();
    return this.queue.enqueueExclusive(`create_project_${Date.now()}`, async () => {
      const { page } = await this.cdp.ensureWorkerPage();
      if (!page.url().startsWith(this.config.FLOW_BASE_URL)) {
        await page.goto(this.config.FLOW_BASE_URL, { waitUntil: "domcontentloaded" });
      }
      await this.delay();

      const clicked = await this.clickButtonByPattern(page, map.selectors.newProjectButtonPattern);
      if (clicked) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await this.delay(1500);
      }

      return {
        ok: clicked,
        projectName,
        projectUrl: page.url(),
        note: clicked
          ? "Berhasil membuka workspace project baru di Google Flow."
          : "Tombol New Project tidak ditemukan; jalankan flow_discover_ui untuk memperbarui selectors.map.json.",
      };
    });
  }

  public async generateMedia(input: GenerateMediaInput, onProgress?: ProgressCallback) {
    const map = this.getSelectors();

    if (input.resumeJobId) {
      const existing = this.queue.getJob(input.resumeJobId);
      if (!existing) {
        throw new Error(`JOB_NOT_FOUND: Job ID ${input.resumeJobId} tidak ditemukan di state disk.`);
      }
      return this.queue.enqueueExclusive(existing.jobId, async () => {
        const { page } = await this.cdp.ensureWorkerPage();
        await onProgress?.(`Melanjutkan polling untuk job ${existing.jobId}...`);
        return this.pollAndDownloadOutputs(page, map, existing, input.count ?? 1, onProgress);
      });
    }

    const defaultModel = input.kind === "image" ? "Nano Banana 2" : "Veo 3.1 Fast";
    const chosenModel = input.model ?? defaultModel;
    const chosenRatio = input.aspectRatio ?? "16:9";
    const targetUrl = input.projectUrl ?? this.config.FLOW_BASE_URL;

    const job = this.queue.createJobRecord({
      kind: input.kind,
      prompt: input.prompt,
      model: chosenModel,
      aspectRatio: chosenRatio,
      projectUrl: targetUrl,
    });

    return this.queue.enqueueExclusive(job.jobId, async () => {
      job.status = "running";
      this.queue.saveJob(job);

      try {
        const { page } = await this.cdp.ensureWorkerPage();
        await onProgress?.(`[${job.jobId}] Membuka workspace Flow: ${targetUrl}`);
        if (page.url() !== targetUrl) {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await this.delay(1200);
        }

        if (page.url().includes("accounts.google.com")) {
          throw new Error(
            "AUTH_REQUIRED: Sesi Chrome belum login ke akun Google. Buka antarmuka KasmVNC atau jendela Chrome lokal untuk login sekali.",
          );
        }

        await onProgress?.(`[${job.jobId}] Mengatur model=${chosenModel}, rasio=${chosenRatio}...`);
        await this.configureComposerSettings(page, map, input.kind, chosenModel, chosenRatio);

        if (input.referenceImagePaths && input.referenceImagePaths.length > 0) {
          for (const refPath of input.referenceImagePaths) {
            const absRef = path.resolve(refPath);
            if (!fs.existsSync(absRef)) {
              throw new Error(`REFERENCE_MISSING: File referensi tidak ditemukan di ${absRef}`);
            }
            await onProgress?.(`[${job.jobId}] Mengunggah gambar referensi: ${path.basename(absRef)}`);
            await this.attachReferenceFile(page, map, absRef);
          }
        }

        const composer = page.locator(map.selectors.composerTextbox).last();
        await composer.waitFor({ state: "visible", timeout: 15_000 });
        await composer.click();
        await composer.fill(input.prompt);
        await this.delay(500);

        const quotedCredits = await this.extractCreditQuote(page, map, input.kind, chosenModel);
        job.quotedCredits = quotedCredits;
        this.queue.saveJob(job);

        this.queue.assertCreditBudget(quotedCredits, input.maxCredits);

        if (input.dryRun) {
          job.status = "dry_run";
          this.queue.saveJob(job);
          return {
            ok: true,
            dryRun: true,
            jobId: job.jobId,
            quotedCredits,
            model: chosenModel,
            aspectRatio: chosenRatio,
            message: "Dry run selesai: prompt dan parameter sudah terpasang tanpa menekan tombol Generate.",
          };
        }

        const tileSelector = input.kind === "video" ? map.selectors.videoTile : map.selectors.imageTile;
        job.baselineTileCount = await page.locator(tileSelector).count();
        this.queue.saveJob(job);

        await onProgress?.(`[${job.jobId}] Menjalankan generasi (${quotedCredits} credits)...`);
        const triggered = await this.clickButtonByPattern(page, map.selectors.sendButtonIconPattern);
        if (!triggered) {
          await composer.press("Enter");
        }
        await this.delay(1500);

        const completedJob = await this.pollAndDownloadOutputs(
          page,
          map,
          job,
          input.count ?? 1,
          onProgress,
        );

        this.queue.recordCreditSpend(quotedCredits);
        return {
          ok: true,
          dryRun: false,
          job: completedJob,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const screenshot = await this.cdp.captureFailureScreenshot(job.jobId);
        job.status = "failed";
        job.error = screenshot ? `${message} (screenshot: ${screenshot})` : message;
        this.queue.saveJob(job);
        throw err;
      }
    });
  }

  public async exportSceneMp4(params: { clipFilenames: string[]; outputBasename?: string }) {
    if (params.clipFilenames.length === 0) {
      throw new Error("EMPTY_SCENE: Minimal satu file klip MP4 diperlukan.");
    }

    const resolvedClips = params.clipFilenames.map((name) => {
      const safeName = path.basename(name);
      const abs = path.join(this.config.outputDirAbs, safeName);
      if (!fs.existsSync(abs)) {
        throw new Error(`CLIP_NOT_FOUND: File klip ${safeName} tidak ditemukan di direktori output.`);
      }
      return abs;
    });

    const job = this.queue.createJobRecord({
      kind: "scene_export",
      prompt: `Scene merge (${resolvedClips.length} clips)`,
      model: "ffmpeg-concat",
      aspectRatio: "auto",
      projectUrl: this.config.FLOW_BASE_URL,
    });

    const listFile = path.join(this.config.stateDirAbs, `concat_${job.jobId}.txt`);
    const listContent = resolvedClips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(listFile, listContent, "utf-8");

    const outName = `${(params.outputBasename ?? `scene_${job.jobId}`).replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4`;
    const outAbs = path.join(this.config.outputDirAbs, outName);

    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "24",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outAbs,
      ]);
    } finally {
      fs.rmSync(listFile, { force: true });
    }

    const stat = fs.statSync(outAbs);
    const signed = this.signer.signFilename(outName);
    job.status = "completed";
    job.outputs = [
      {
        filename: outName,
        localPath: outAbs,
        downloadUrl: signed.url,
        expiresAt: signed.expiresAt,
        bytes: stat.size,
      },
    ];
    this.queue.saveJob(job);

    return {
      ok: true,
      jobId: job.jobId,
      output: job.outputs[0],
    };
  }

  public async discoverUi() {
    const { page } = await this.cdp.ensureWorkerPage();
    return page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(
          "button, [role='button'], [role='menuitem'], [role='textbox'], textarea, flow-video-tile, flow-image-tile",
        ),
      );
      return {
        currentUrl: window.location.href,
        title: document.title,
        interactiveElements: elements.slice(0, 80).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            ariaLabel: el.getAttribute("aria-label"),
            text: (el as HTMLElement).innerText?.trim().slice(0, 80) ?? "",
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        }),
      };
    });
  }

  private async configureComposerSettings(
    page: Page,
    map: SelectorMap,
    kind: "image" | "video",
    modelLabel: string,
    aspectRatio: string,
  ): Promise<void> {
    const opened = await this.clickButtonByPattern(page, map.selectors.settingsButtonIconPattern);
    if (!opened) return;
    await this.delay(500);

    await this.clickElementContainingText(page, modelLabel);
    await this.delay(300);
    await this.clickElementContainingText(page, aspectRatio);
    await this.delay(300);

    await page.keyboard.press("Escape").catch(() => undefined);
    await this.delay(300);
    void kind;
  }

  private async attachReferenceFile(page: Page, map: SelectorMap, absFilePath: string): Promise<void> {
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }).catch(() => null),
      this.clickButtonByPattern(page, map.selectors.attachButtonIconPattern),
    ]);

    if (fileChooser) {
      await fileChooser.setFiles(absFilePath);
      await this.delay(1500);
      return;
    }

    const fileInput = page.locator("input[type='file']").first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(absFilePath);
      await this.delay(1500);
    }
  }

  private async extractCreditQuote(
    page: Page,
    map: SelectorMap,
    kind: "image" | "video",
    modelLabel: string,
  ): Promise<number> {
    const liveQuote = await page.evaluate((patternStr) => {
      const regex = new RegExp(patternStr, "i");
      const text = document.body?.innerText ?? "";
      const specific = text.match(/use\s+(\d+)\s*credits?/i) ?? text.match(regex);
      return specific ? Number.parseInt(specific[1], 10) : null;
    }, map.selectors.creditQuotePattern);

    if (liveQuote !== null && Number.isFinite(liveQuote)) {
      return liveQuote;
    }

    const catalog = kind === "video" ? map.models.video : map.models.image;
    const matched = catalog.find(
      (m) =>
        m.label.toLowerCase() === modelLabel.toLowerCase() ||
        m.id.toLowerCase() === modelLabel.toLowerCase(),
    );
    return matched ? matched.estimatedCredits : kind === "video" ? 20 : 2;
  }

  private async pollAndDownloadOutputs(
    page: Page,
    map: SelectorMap,
    job: FlowJobRecord,
    expectedNewCount: number,
    onProgress?: ProgressCallback,
  ): Promise<FlowJobRecord> {
    const selector = job.kind === "video" ? map.selectors.videoTile : map.selectors.imageTile;
    const deadline = Date.now() + this.config.FLOW_JOB_TIMEOUT_MS;
    let newMediaUrls: string[] = [];

    while (Date.now() < deadline) {
      const urls = await this.extractTileMediaUrls(page, selector, job.kind === "video");
      const delta = urls.length - job.baselineTileCount;

      if (delta >= expectedNewCount && urls.length > 0) {
        newMediaUrls = urls.slice(0, Math.max(delta, expectedNewCount));
        break;
      }

      await onProgress?.(
        `[${job.jobId}] Menunggu hasil render ${job.kind} (tile saat ini: ${urls.length}, target: >= ${job.baselineTileCount + expectedNewCount})...`,
      );
      await this.delay(this.config.FLOW_POLL_INTERVAL_MS);
    }

    if (newMediaUrls.length === 0) {
      throw new Error(
        `GENERATION_TIMEOUT: Tidak ada media baru setelah ${Math.round(this.config.FLOW_JOB_TIMEOUT_MS / 1000)} detik. Gunakan resumeJobId="${job.jobId}" untuk mengecek ulang tanpa menghabiskan kredit baru.`,
      );
    }

    const outputs: FlowJobRecord["outputs"] = [];
    const ext = job.kind === "video" ? "mp4" : "png";

    for (const mediaUrl of newMediaUrls) {
      const response = await page.context().request.get(mediaUrl, { timeout: 60_000 });
      if (!response.ok()) {
        throw new Error(`MEDIA_DOWNLOAD_FAILED: HTTP ${response.status()} saat mengunduh media Flow.`);
      }
      const buffer = await response.body();
      const digest = shortBufferDigest(buffer);
      const filename = `flow_${digest}_${job.jobId}.${ext}`;
      const localPath = path.join(this.config.outputDirAbs, filename);
      fs.writeFileSync(localPath, buffer);

      const signed = this.signer.signFilename(filename);
      outputs.push({
        filename,
        localPath,
        downloadUrl: signed.url,
        expiresAt: signed.expiresAt,
        bytes: buffer.byteLength,
      });
    }

    job.status = "completed";
    job.outputs = outputs;
    this.queue.saveJob(job);
    return job;
  }

  private async extractTileMediaUrls(
    page: Page,
    tileSelector: string,
    hoverForVideoSrc: boolean,
  ): Promise<string[]> {
    const locator = page.locator(tileSelector);
    const count = await locator.count();
    if (hoverForVideoSrc && count > 0) {
      const limit = Math.min(count, 4);
      for (let i = 0; i < limit; i++) {
        await locator.nth(i).hover({ timeout: 1500 }).catch(() => undefined);
        await this.delay(250);
      }
    }

    return page.evaluate((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const urls: string[] = [];
      for (const node of nodes) {
        const video =
          node.tagName.toLowerCase() === "video"
            ? (node as HTMLVideoElement)
            : node.querySelector("video");
        const img =
          node.tagName.toLowerCase() === "img"
            ? (node as HTMLImageElement)
            : node.querySelector("img");
        const candidate =
          video?.currentSrc ||
          video?.getAttribute("src") ||
          node.getAttribute("data-src") ||
          img?.currentSrc ||
          img?.getAttribute("src");
        if (candidate && candidate.startsWith("http")) {
          urls.push(candidate);
        }
      }
      return urls;
    }, tileSelector);
  }

  private async collectDomTiles(page: Page, map: SelectorMap, limit: number) {
    return page.evaluate(
      ({ videoSel, imageSel, max }) => {
        const collect = (sel: string, type: "video" | "image") =>
          Array.from(document.querySelectorAll(sel))
            .slice(0, max)
            .map((el) => ({
              type,
              mediaId: el.getAttribute("data-media-id"),
              src:
                el.querySelector("video")?.getAttribute("src") ??
                el.querySelector("img")?.getAttribute("src") ??
                el.getAttribute("src"),
            }));
        return [...collect(videoSel, "video"), ...collect(imageSel, "image")].slice(0, max);
      },
      { videoSel: map.selectors.videoTile, imageSel: map.selectors.imageTile, max: limit },
    );
  }

  private async clickButtonByPattern(page: Page, patternStr: string): Promise<boolean> {
    return page.evaluate((pat) => {
      const regex = new RegExp(pat, "i");
      const candidates = Array.from(
        document.querySelectorAll("button, [role='button']"),
      ) as HTMLElement[];
      const target = candidates.find((el) => {
        const text = `${el.innerText ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && regex.test(text);
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, patternStr);
  }

  private async clickElementContainingText(page: Page, label: string): Promise<boolean> {
    return page.evaluate((needle) => {
      const lower = needle.toLowerCase();
      const candidates = Array.from(
        document.querySelectorAll("[role='menuitem'], [role='option'], button, [role='radio']"),
      ) as HTMLElement[];
      const target = candidates.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (el.innerText ?? "").toLowerCase().includes(lower);
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, label);
  }
}
