# Cloudflare Tunnel & Reverse Proxy Guide for Google Flow Streamable HTTP MCP

This guide provides production-ready configurations for exposing `google-flow-mcp-http` (`127.0.0.1:3100`) to remote AI agents via **Cloudflare Tunnel (`cloudflared`)**, **Cloudflare Zero Trust Access**, **Caddy**, or **Nginx** without breaking Server-Sent Events (SSE) streams or hitting HTTP 524 timeouts during 1-5 minute [Google Flow](https://flow.google.com/) video renders ([Wireflow Guide](https://www.wireflow.ai/blog/google-flow-api)).

## 1. Three Critical Edge Settings for Streamable HTTP on Cloudflare

1. **Disable Response Body Buffering on `/mcp*`**: By default (`standard`), Cloudflare buffers response body prefixes for inspection, delaying SSE progress notifications ([Cloudflare Configuration Rules Changelog](https://developers.cloudflare.com/changelog/product-group/application-security/6/)). Run `make cf-provision` or configure a **Configuration Rule** on `/mcp*` with `response_body_buffering: "none"`.
2. **Allow Autonomous Agent Traffic Past Bot Fight Mode**: Headless MCP clients (`fetch`, `httpx`, Claude Code, Antigravity, Hermes Agent) can trigger *Super Bot Fight Mode* ([Cloudflare Tunnel Common Errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)). Add a **WAF Custom Rule** skip or **Cloudflare Access Service Token** for authenticated agent requests ([Cloudflare Service Tokens Docs](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)).
3. **Keep Chunked Encoding Enabled & Long Keepalives**: In `cloudflared`, keep `disableChunkedEncoding: false` so HTTP/1.1 streaming remains active ([Cloudflare Tunnel Origin Parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)). Because `google-flow-mcp-http` emits SSE log notifications every 5 seconds during Veo 3.1 rendering, the stream stays active and avoids idle read timeouts.

## 2. Cloudflare Edge Rules Summary

| Cloudflare Layer | Target Path / Expression | Required Setting | Technical Reason & Source |
| :--- | :--- | :--- | :--- |
| **Configuration Rules** | `http.host eq "flow-mcp.yourdomain.com" and starts_with(http.request.uri.path, "/mcp")` | **Response body buffering**: `None` (`response_body_buffering: "none"`) | Prevents Cloudflare edge from buffering `GET /mcp` and `POST /mcp` SSE streams ([Cloudflare Configuration Rules](https://developers.cloudflare.com/changelog/product-group/application-security/6/)). |
| **Zero Trust Access (`/mcp*`)** | `flow-mcp.yourdomain.com/mcp*` | Action: **Service Auth** with **Service Token** (`CF-Access-Client-Id` & `CF-Access-Client-Secret`) or [Cloudflare MCP Server Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) | Adds m2m edge authentication before requests reach the origin container ([Cloudflare Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)). |
| **Zero Trust Access (`/media/*`)** | `flow-mcp.yourdomain.com/media/*` | Action: **Bypass** for `Everyone` | `/media/:filename?exp=...&sig=...` is already protected by expiring HMAC-SHA256 signatures so external `ffmpeg` or media pipelines can fetch MP4 files without Access headers ([Cloudflare Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)). |
| **Security > WAF Custom Rules** | Host `flow-mcp.yourdomain.com` with `authorization` header or `/media/` path | Action: **Skip** (*Super Bot Fight Mode*, *Managed Rules*, *Rate Limiting*) | Prevents automated AI agents from hitting JavaScript/Turnstile challenges ([Cloudflare Tunnel Common Errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)). |

## 3. Ready-to-Use Templates in `deploy/`

Running `./setup.sh --domain flow-mcp.yourdomain.com` automatically renders all templates below with your domain into `generated-configs/`:

- `deploy/cloudflared/config.yml` (Locally-managed tunnel)
- `deploy/docker-compose.cloudflared.yml` (Docker sidecar tunnel on internal `flow_internal` network)
- `deploy/cloudflare-edge-rules.json` (Reference Configuration Rule, WAF, and Access policies)
- `deploy/caddy/Caddyfile` (`flush_interval -1` on `/mcp*`)
- `deploy/nginx/flow-mcp.conf` (`proxy_buffering off` and `X-Accel-Buffering: no`)
- `deploy/systemd/google-flow-mcp.service` (Linux bare-metal systemd service)
