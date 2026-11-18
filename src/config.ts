import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3100),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:3100"),
  FLOW_MCP_AUTH_TOKEN: z.string().default(""),
  FLOW_MEDIA_SIGNING_SECRET: z.string().min(16).default("dev-only-change-this-signing-secret-immediately"),
  FLOW_MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  FLOW_ALLOWED_HOSTS: z
    .string()
    .default("127.0.0.1,localhost,127.0.0.1:3100,localhost:3100"),
  FLOW_STATELESS_HTTP: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),
  FLOW_SESSION_TTL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  FLOW_CDP_URL: z.string().url().default("http://127.0.0.1:9222"),
  FLOW_ALLOW_REMOTE_CDP: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),
  FLOW_BASE_URL: z.string().url().default("https://flow.google.com"),
  FLOW_EXPECTED_EMAIL: z.string().optional().default(""),
  FLOW_MAX_CREDITS_PER_CALL: z.coerce.number().int().nonnegative().default(25),
  FLOW_DAILY_CREDIT_CAP: z.coerce.number().int().nonnegative().default(200),
  FLOW_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(360_000),
  FLOW_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  FLOW_ACTION_DELAY_MS: z.coerce.number().int().nonnegative().default(750),
  FLOW_OUTPUT_DIR: z.string().default("./exports"),
  FLOW_STATE_DIR: z.string().default("./state"),
  FLOW_SELECTORS_PATH: z.string().default("./config/selectors.map.json"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  allowedHostsList: string[];
  outputDirAbs: string;
  stateDirAbs: string;
  selectorsPathAbs: string;
};

export interface SelectorMap {
  version: string;
  urls: {
    flowHome: string;
    trpcVideoModels: string;
    trpcUserHistory: string;
    trpcCreateProject: string;
  };
  selectors: {
    composerTextbox: string;
    sendButtonIconPattern: string;
    settingsButtonIconPattern: string;
    newProjectButtonPattern: string;
    attachButtonIconPattern: string;
    videoTile: string;
    imageTile: string;
    creditQuotePattern: string;
    generatingIndicatorPattern: string;
  };
  models: {
    image: Array<{ id: string; label: string; estimatedCredits: number }>;
    video: Array<{ id: string; label: string; estimatedCredits: number }>;
  };
}

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.parse(process.env);
  const outputDirAbs = path.resolve(parsed.FLOW_OUTPUT_DIR);
  const stateDirAbs = path.resolve(parsed.FLOW_STATE_DIR);
  const selectorsPathAbs = path.resolve(parsed.FLOW_SELECTORS_PATH);

  fs.mkdirSync(outputDirAbs, { recursive: true });
  fs.mkdirSync(path.join(stateDirAbs, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(stateDirAbs, "screenshots"), { recursive: true });

  const allowedHostsList = parsed.FLOW_ALLOWED_HOSTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return {
    ...parsed,
    PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    allowedHostsList,
    outputDirAbs,
    stateDirAbs,
    selectorsPathAbs,
  };
}

export function loadSelectorMap(selectorsPathAbs: string): SelectorMap {
  const raw = fs.readFileSync(selectorsPathAbs, "utf-8");
  return JSON.parse(raw) as SelectorMap;
}
