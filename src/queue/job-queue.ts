import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type JobKind = "image" | "video" | "scene_export";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "dry_run";

export interface FlowJobRecord {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  prompt: string;
  model: string;
  aspectRatio: string;
  projectUrl: string;
  quotedCredits: number | null;
  baselineTileCount: number;
  outputs: Array<{
    filename: string;
    localPath: string;
    downloadUrl: string;
    expiresAt: string;
    bytes: number;
  }>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface DailyCreditState {
  date: string;
  spentCredits: number;
  jobsCount: number;
}

export class FlowJobQueue {
  private activePromise: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private activeJobId: string | null = null;

  constructor(
    private readonly stateDirAbs: string,
    private readonly defaultMaxCreditsPerCall: number,
    private readonly dailyCreditCap: number,
  ) {}

  public createJobRecord(params: {
    kind: JobKind;
    prompt: string;
    model: string;
    aspectRatio: string;
    projectUrl: string;
  }): FlowJobRecord {
    const now = new Date().toISOString();
    const record: FlowJobRecord = {
      jobId: `job_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      kind: params.kind,
      status: "queued",
      prompt: params.prompt,
      model: params.model,
      aspectRatio: params.aspectRatio,
      projectUrl: params.projectUrl,
      quotedCredits: null,
      baselineTileCount: 0,
      outputs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.saveJob(record);
    return record;
  }

  public saveJob(record: FlowJobRecord): void {
    record.updatedAt = new Date().toISOString();
    const file = path.join(this.stateDirAbs, "jobs", `${record.jobId}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf-8");
  }

  public getJob(jobId: string): FlowJobRecord | null {
    const safeId = path.basename(jobId);
    const file = path.join(this.stateDirAbs, "jobs", `${safeId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as FlowJobRecord;
  }

  public listRecentJobs(limit = 15): FlowJobRecord[] {
    const jobsDir = path.join(this.stateDirAbs, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    const files = fs
      .readdirSync(jobsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(jobsDir, f));
    const records = files.map((f) => JSON.parse(fs.readFileSync(f, "utf-8")) as FlowJobRecord);
    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public getQueueMetrics(): {
    activeJobId: string | null;
    pendingCount: number;
    todaySpentCredits: number;
    dailyCreditCap: number;
  } {
    const ledger = this.readDailyLedger();
    return {
      activeJobId: this.activeJobId,
      pendingCount: this.pendingCount,
      todaySpentCredits: ledger.spentCredits,
      dailyCreditCap: this.dailyCreditCap,
    };
  }

  public assertCreditBudget(quotedCredits: number, maxCreditsOverride?: number): void {
    const perCallLimit = maxCreditsOverride ?? this.defaultMaxCreditsPerCall;
    if (quotedCredits > perCallLimit) {
      throw new Error(
        `CREDIT_CAP_EXCEEDED: Estimasi kredit Flow (${quotedCredits}) melebihi batas per panggilan (${perCallLimit}). Naikkan parameter maxCredits jika memang disengaja.`,
      );
    }
    const ledger = this.readDailyLedger();
    if (this.dailyCreditCap > 0 && ledger.spentCredits + quotedCredits > this.dailyCreditCap) {
      throw new Error(
        `DAILY_CREDIT_CAP_EXCEEDED: Total kredit hari ini (${ledger.spentCredits} + ${quotedCredits}) melampaui batas harian (${this.dailyCreditCap}).`,
      );
    }
  }

  public recordCreditSpend(credits: number): void {
    if (credits <= 0) return;
    const ledger = this.readDailyLedger();
    ledger.spentCredits += credits;
    ledger.jobsCount += 1;
    const file = this.getDailyLedgerPath(ledger.date);
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2), "utf-8");
  }

  public async enqueueExclusive<T>(jobId: string, task: () => Promise<T>): Promise<T> {
    this.pendingCount += 1;
    const run = async (): Promise<T> => {
      this.pendingCount -= 1;
      this.activeJobId = jobId;
      try {
        return await task();
      } finally {
        this.activeJobId = null;
      }
    };

    const next = this.activePromise.then(run, run);
    this.activePromise = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private getDailyLedgerPath(dateStr: string): string {
    return path.join(this.stateDirAbs, `credits-${dateStr}.json`);
  }

  private readDailyLedger(): DailyCreditState {
    const today = new Date().toISOString().slice(0, 10);
    const file = this.getDailyLedgerPath(today);
    if (!fs.existsSync(file)) {
      return { date: today, spentCredits: 0, jobsCount: 0 };
    }
    return JSON.parse(fs.readFileSync(file, "utf-8")) as DailyCreditState;
  }
}
