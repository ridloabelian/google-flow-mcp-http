import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CdpSessionManager } from "../browser/cdp-manager.js";
import type { GoogleFlowController } from "../flow/controller.js";
import type { FlowJobQueue } from "../queue/job-queue.js";

function okEnvelope(data: Record<string, unknown>) {
  const payload = { ok: true, ...data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errEnvelope(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const codeMatch = message.match(/^([A-Z_]+):/);
  const payload = {
    ok: false,
    code: codeMatch ? codeMatch[1] : "FLOW_EXECUTION_ERROR",
    message,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

export function buildFlowMcpServer(deps: {
  cdp: CdpSessionManager;
  flow: GoogleFlowController;
  queue: FlowJobQueue;
}): McpServer {
  const server = new McpServer(
    {
      name: "google-flow-mcp-http",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  const emitProgress = async (msg: string) => {
    try {
      await server.server.sendLoggingMessage({
        level: "info",
        logger: "google-flow-mcp",
        data: msg,
      });
    } catch {
      // Ignore if client did not subscribe to SSE GET /mcp stream
    }
  };

  server.registerTool(
    "flow_status",
    {
      title: "Google Flow Session & Credit Status",
      description:
        "Memeriksa koneksi Chrome CDP, status login akun Google di flow.google.com, saldo kredit terdeteksi, serta status antrean job saat ini.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return okEnvelope(await deps.flow.getStatus());
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_doctor",
    {
      title: "CDP Health Check & Hung Tab Cleanup",
      description:
        "Memeriksa target tab Chrome pada endpoint CDP dan opsional menutup tab yang crash/hang agar koneksi tidak terblokir.",
      inputSchema: {
        closeHungTabs: z
          .boolean()
          .optional()
          .default(false)
          .describe("Tutup otomatis tab Chrome yang berstatus crash ('Aw, Snap!')."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ closeHungTabs }) => {
      try {
        const report = await deps.cdp.runDoctor(closeHungTabs);
        return okEnvelope({ doctor: report });
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_list_models",
    {
      title: "List Google Flow Image & Video Models",
      description:
        "Mengambil daftar model Google Flow (Veo 3.1 Quality/Fast/Lite, Omni Flash, Nano Banana Pro/2, Imagen 4) beserta estimasi biaya kredit.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return okEnvelope(await deps.flow.listModels());
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_list_history",
    {
      title: "List Recent Jobs & Flow Media Tiles",
      description:
        "Menampilkan daftar job generasi terbaru di server beserta URL unduhan bertanda tangan dan tile media pada kanvas aktif.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().default(15),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        return okEnvelope(await deps.flow.listHistory(limit));
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_create_project",
    {
      title: "Create New Google Flow Project",
      description: "Membuka dan membuat workspace project baru di Google Flow.",
      inputSchema: {
        projectName: z.string().min(1).describe("Nama referensi project baru."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectName }) => {
      try {
        return okEnvelope(await deps.flow.createProject(projectName));
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_generate_image",
    {
      title: "Generate Image in Google Flow",
      description:
        "Membuat gambar menggunakan Nano Banana 2, Nano Banana Pro, atau Imagen 4 melalui sesi Chrome Google Flow dan mengembalikan HTTPS download URL bertanda tangan.",
      inputSchema: {
        prompt: z.string().min(3).describe("Deskripsi visual gambar yang ingin dibuat."),
        model: z
          .enum(["Nano Banana 2", "Nano Banana Pro", "Imagen 4"])
          .optional()
          .default("Nano Banana 2"),
        aspectRatio: z
          .enum(["16:9", "9:16", "1:1", "4:3", "3:4"])
          .optional()
          .default("16:9"),
        projectUrl: z.string().url().optional().describe("URL project Flow spesifik bila ada."),
        referenceImagePaths: z
          .array(z.string())
          .optional()
          .describe("Path file referensi lokal di host server bila diperlukan."),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe("Jika true, hanya mengisi prompt & memeriksa estimasi kredit tanpa klik Generate."),
        maxCredits: z.number().int().positive().optional(),
        resumeJobId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return okEnvelope(await deps.flow.generateMedia({ kind: "image", ...args }, emitProgress));
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_generate_video",
    {
      title: "Generate Video in Google Flow (Veo 3.1 / Omni Flash)",
      description:
        "Membuat klip video AI (Veo 3.1 Lite/Fast/Quality atau Omni Flash) di Google Flow dengan proteksi batas kredit dan mengembalikan HTTPS MP4 URL bertanda tangan untuk diakses remote agent.",
      inputSchema: {
        prompt: z.string().min(3).describe("Prompt adegan, subjek, pencahayaan, dan pergerakan kamera."),
        model: z
          .enum(["Omni Flash", "Veo 3.1 Lite", "Veo 3.1 Fast", "Veo 3.1 Quality"])
          .optional()
          .default("Veo 3.1 Fast"),
        aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
        projectUrl: z.string().url().optional(),
        referenceImagePaths: z.array(z.string()).optional(),
        dryRun: z.boolean().optional().default(false),
        maxCredits: z.number().int().positive().optional(),
        resumeJobId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return okEnvelope(await deps.flow.generateMedia({ kind: "video", ...args }, emitProgress));
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_job_status",
    {
      title: "Get Job Status & Signed Download Links",
      description: "Mengecek status detail sebuah job berdasarkan jobId serta mengambil link unduhan medianya.",
      inputSchema: { jobId: z.string().min(4) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ jobId }) => {
      const record = deps.queue.getJob(jobId);
      if (!record) {
        return errEnvelope(new Error(`JOB_NOT_FOUND: Job ${jobId} tidak ditemukan.`));
      }
      return okEnvelope({ job: record, queue: deps.queue.getQueueMetrics() });
    },
  );

  server.registerTool(
    "flow_export_scene",
    {
      title: "Merge & Export Multi-Shot Scene to MP4",
      description:
        "Menggabungkan beberapa klip MP4 yang telah diunduh menjadi satu video scene utuh menggunakan ffmpeg dan mengembalikan signed download URL.",
      inputSchema: {
        clipFilenames: z.array(z.string().min(3)).min(1),
        outputBasename: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ clipFilenames, outputBasename }) => {
      try {
        return okEnvelope(await deps.flow.exportSceneMp4({ clipFilenames, outputBasename }));
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  server.registerTool(
    "flow_discover_ui",
    {
      title: "Inspect Live Google Flow DOM Selectors",
      description:
        "Memindai tombol, menu, textbox, dan custom element pada halaman aktif Google Flow beserta koordinatnya untuk debugging bila antarmuka web berubah.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return okEnvelope(await deps.flow.discoverUi());
      } catch (err) {
        return errEnvelope(err);
      }
    },
  );

  return server;
}
