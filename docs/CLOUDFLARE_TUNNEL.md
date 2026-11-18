# Konfigurasi Cloudflare Tunnel & Reverse Proxy untuk Google Flow Streamable HTTP MCP

Panduan ini menyajikan konfigurasi siap pakai untuk mengekspos server `google-flow-mcp-http` (`127.0.0.1:3100`) ke *remote AI agents* melalui **Cloudflare Tunnel (`cloudflared`)**, **Cloudflare Zero Trust Access**, **Caddy**, maupun **Nginx** tanpa memutus aliran Server-Sent Events (SSE) atau terkena error timeout HTTP 524 saat merender video [Google Flow](https://flow.google.com/) berdurasi 1 hingga 5 menit ([Wireflow Guide](https://www.wireflow.ai/blog/google-flow-api)).

## 1. Tiga Titik Rawan pada Cloudflare Tunnel untuk MCP Streamable HTTP

1. **Response Body Buffering Menahan Event SSE**: Secara default (`standard`), Cloudflare menahan awalan *response body* untuk inspeksi keamanan sehingga notifikasi progres SSE tertunda ([Cloudflare Configuration Rules Changelog](https://developers.cloudflare.com/changelog/product-group/application-security/6/)). Jalankan `make cf-provision` atau buat **Configuration Rule** pada jalur `/mcp*` dengan `response_body_buffering: "none"`.
2. **Super Bot Fight Mode Memblokir Request Agen Otomatis**: Klien MCP otonom (Node `fetch`, Python `httpx`, Claude Code, Antigravity, Hermes Agent) terdeteksi sebagai trafik otomatis dan dapat ditolak oleh *Super Bot Fight Mode* ([Cloudflare Tunnel Common Errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)). Gunakan **WAF Custom Rule** atau **Cloudflare Access Service Token** agar trafik agen yang terautentikasi diizinkan lewat ([Cloudflare Service Tokens Docs](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)).
3. **Chunked Transfer Encoding & Idle Read Timeout (HTTP 524)**: Pada `cloudflared`, parameter `disableChunkedEncoding` harus tetap `false` supaya streaming chunked HTTP/1.1 menuju origin tetap berjalan ([Cloudflare Tunnel Origin Parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)). Karena `google-flow-mcp-http` mengirimkan event log SSE setiap 5 detik selama proses *rendering* Veo 3.1, koneksi tidak pernah idle melampaui batas antar-baca Cloudflare.

## 2. Aturan Cloudflare Edge: SSE Unbuffered, WAF Skip, & Zero Trust Access

| Lapisan Cloudflare | Target Path / Ekspresi | Pengaturan Wajib | Alasan Teknis & Sumber |
| :--- | :--- | :--- | :--- |
| **Configuration Rules** | `http.host eq "flow-mcp.domainkamu.id" and starts_with(http.request.uri.path, "/mcp")` | **Response body buffering**: `None` (`response_body_buffering: "none"`) | Mencegah proxy Cloudflare menahan stream SSE pada `GET /mcp` dan `POST /mcp` ([Cloudflare Configuration Rules](https://developers.cloudflare.com/changelog/product-group/application-security/6/)). |
| **Zero Trust Access (`/mcp*`)** | `flow-mcp.domainkamu.id/mcp*` | Action: **Service Auth** dengan **Service Token** (`CF-Access-Client-Id` & `CF-Access-Client-Secret`) atau integrasi [Cloudflare MCP Server Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) | Menambahkan lapisan autentikasi m2m di edge Cloudflare sebelum request menyentuh container lokal ([Cloudflare Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)). |
| **Zero Trust Access (`/media/*`)** | `flow-mcp.domainkamu.id/media/*` | Action: **Bypass** untuk `Everyone` | Path `/media/:filename?exp=...&sig=...` sudah diverifikasi dengan tanda tangan HMAC-SHA256 berbatas waktu sehingga `ffmpeg` atau pipeline video eksternal dapat mengunduh MP4 tanpa header Access khusus ([Cloudflare Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)). |
| **Security > WAF Custom Rules** | Host `flow-mcp.domainkamu.id` dengan header `authorization` atau path `/media/` | Action: **Skip** (*Super Bot Fight Mode*, *Managed Rules*, *Rate Limiting*) | Mencegah agen AI otonom terblokir halaman tantangan JavaScript/Turnstile ([Cloudflare Tunnel Common Errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)). |

## 3. File Template Siap Pakai di Folder `deploy/`

Saat kamu menjalankan `./setup.sh --domain flow-mcp.domainkamu.id`, seluruh file di bawah ini otomatis di-render ulang dengan domain kamu ke folder `generated-configs/`:

- `deploy/cloudflared/config.yml` (Locally-managed tunnel)
- `deploy/docker-compose.cloudflared.yml` (Sidecar Docker tunnel di jaringan internal `flow_internal`)
- `deploy/cloudflare-edge-rules.json` (Referensi ekspresi Configuration Rule, WAF, dan Access)
- `deploy/caddy/Caddyfile` (`flush_interval -1` untuk jalur `/mcp*`)
- `deploy/nginx/flow-mcp.conf` (`proxy_buffering off` dan `X-Accel-Buffering: no`)
- `deploy/systemd/google-flow-mcp.service` (Layanan systemd untuk Linux bare-metal)
