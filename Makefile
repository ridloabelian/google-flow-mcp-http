.PHONY: help setup install build dev start doctor up up-tunnel down logs test install-skill cf-provision chrome

help:
	@echo "Perintah Plug-and-Play google-flow-mcp-http:"
	@echo "  make setup          - Generate .env otomatis (secret 256-bit) & config klien MCP"
	@echo "  make up             - Jalankan Docker stack (Chromium KasmVNC + MCP Streamable HTTP)"
	@echo "  make up-tunnel      - Jalankan Docker stack + sidecar Cloudflare Tunnel"
	@echo "  make down           - Hentikan semua container Docker"
	@echo "  make logs           - Pantau log container MCP server secara live"
	@echo "  make install        - Install dependencies & build TypeScript (mode bare-metal)"
	@echo "  make chrome         - Jalankan Chrome asli lokal dengan CDP 127.0.0.1:9222"
	@echo "  make start          - Jalankan server Streamable HTTP lokal (bare-metal)"
	@echo "  make doctor         - Periksa kesehatan CDP & bersihkan tab Chrome yang hang"
	@echo "  make test           - Jalankan smoke test JSON-RPC end-to-end ke endpoint /mcp"
	@echo "  make install-skill  - Copy SKILL.md ke Hermes Agent, Claude Code, dan Antigravity"
	@echo "  make cf-provision   - Pasang aturan SSE unbuffered otomatis via Cloudflare API"

setup:
	@bash ./setup.sh

install:
	npm install
	npm run build

chrome:
	@bash ./scripts/start-chrome-cdp.sh

dev:
	npm run dev

start:
	npm start

doctor:
	node dist/index.js --doctor --close-hung

up:
	@test -f .env || bash ./setup.sh --non-interactive
	docker compose up -d --build
	@echo "KasmVNC Login GUI tersedia di https://127.0.0.1:3001 (gunakan SSH tunnel bila di VPS/Homelab)"

up-tunnel:
	@test -f .env || bash ./setup.sh
	docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflared.yml up -d --build

down:
	docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflared.yml down --remove-orphans

logs:
	docker compose logs -f flow-mcp-server

test:
	node scripts/smoke-test.mjs

install-skill:
	@mkdir -p "$$HOME/.hermes/skills/google-flow-mcp" "$$HOME/.claude/skills/google-flow-mcp" ".agent/skills/google-flow-mcp"
	@cp skills/google-flow-mcp/SKILL.md "$$HOME/.hermes/skills/google-flow-mcp/SKILL.md"
	@cp skills/google-flow-mcp/SKILL.md "$$HOME/.claude/skills/google-flow-mcp/SKILL.md"
	@cp skills/google-flow-mcp/SKILL.md ".agent/skills/google-flow-mcp/SKILL.md"
	@echo "[OK] SKILL.md terpasang di ~/.hermes/skills, ~/.claude/skills, dan .agent/skills"

cf-provision:
	node scripts/provision-cloudflare-rules.mjs
