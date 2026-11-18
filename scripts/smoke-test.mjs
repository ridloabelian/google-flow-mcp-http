#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
  return out;
}

const fileEnv = loadDotEnv();
const baseUrl = (process.env.SMOKE_BASE_URL || fileEnv.PUBLIC_BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const token = process.env.FLOW_MCP_AUTH_TOKEN || fileEnv.FLOW_MCP_AUTH_TOKEN || "";

async function parseMcpResponse(res) {
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (ct.includes("text/event-stream")) {
    const dataLines = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return dataLines.length > 0 ? JSON.parse(dataLines[dataLines.length - 1]) : { raw };
  }
  return raw ? JSON.parse(raw) : {};
}

async function run() {
  console.log(`[1/4] Memeriksa ${baseUrl}/healthz ...`);
  const healthRes = await fetch(`${baseUrl}/healthz`);
  if (!healthRes.ok) {
    throw new Error(`Healthcheck gagal dengan HTTP ${healthRes.status}`);
  }
  const health = await healthRes.json();
  console.log("      Healthz OK:", JSON.stringify(health));

  const commonHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  console.log(`[2/4] Handshake MCP initialize ke ${baseUrl}/mcp ...`);
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "flow-smoke-test", version: "1.0.0" },
      },
    }),
  });

  if (!initRes.ok) {
    throw new Error(`Initialize gagal: HTTP ${initRes.status} ${await initRes.text()}`);
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  const initBody = await parseMcpResponse(initRes);
  console.log(`      Server: ${initBody?.result?.serverInfo?.name} | Session ID: ${sessionId || "(stateless)"}`);

  const sessionHeaders = {
    ...commonHeaders,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };

  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  console.log("[3/4] Memeriksa daftar tools (tools/list) ...");
  const listRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listBody = await parseMcpResponse(listRes);
  const toolNames = (listBody?.result?.tools || []).map((t) => t.name);
  console.log(`      Terdeteksi ${toolNames.length} tools: ${toolNames.join(", ")}`);

  console.log("[4/4] Memanggil tool flow_status ...");
  const statusRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "flow_status", arguments: {} },
    }),
  });
  const statusBody = await parseMcpResponse(statusRes);
  console.log("      Hasil flow_status:", statusBody?.result?.content?.[0]?.text || JSON.stringify(statusBody));

  if (sessionId) {
    await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: sessionHeaders }).catch(() => undefined);
  }
  console.log("\n[SUKSES] Seluruh alur Streamable HTTP MCP berjalan normal.");
}

run().catch((err) => {
  console.error("\n[GAGAL] Smoke test error:", err.message);
  process.exit(1);
});
