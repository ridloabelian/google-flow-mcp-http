#!/usr/bin/env node
const apiToken = process.env.CF_API_TOKEN;
const zoneId = process.env.CF_ZONE_ID;
const publicUrl = process.env.PUBLIC_BASE_URL;

if (!apiToken || !zoneId || !publicUrl) {
  console.error(
    "Usage: CF_API_TOKEN=... CF_ZONE_ID=... PUBLIC_BASE_URL=https://flow-mcp.domain.id node scripts/provision-cloudflare-rules.mjs",
  );
  process.exit(1);
}

const hostname = new URL(publicUrl).hostname;
const endpoint = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_config_settings/entrypoint`;

async function main() {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  let existingRules = [];
  const getRes = await fetch(endpoint, { headers });
  if (getRes.ok) {
    const data = await getRes.json();
    existingRules = (data?.result?.rules || []).filter(
      (r) => r.description !== "Google Flow MCP - Disable SSE Response Buffering",
    );
  }

  const newRule = {
    description: "Google Flow MCP - Disable SSE Response Buffering",
    expression: `(http.host eq "${hostname}" and starts_with(http.request.uri.path, "/mcp"))`,
    action: "set_config",
    action_parameters: {
      request_body_buffering: "standard",
      response_body_buffering: "none",
    },
    enabled: true,
  };

  const putRes = await fetch(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      rules: [...existingRules, newRule],
    }),
  });

  const out = await putRes.json();
  if (!putRes.ok || !out.success) {
    console.error("[ERROR] Gagal menerapkan Configuration Rule Cloudflare:", JSON.stringify(out, null, 2));
    process.exit(1);
  }

  console.log(`[OK] Configuration Rule response_body_buffering=none aktif untuk https://${hostname}/mcp*`);
}

main().catch((err) => {
  console.error("[ERROR]", err);
  process.exit(1);
});
