.PHONY: help setup install build dev start doctor up up-tunnel down logs test install-skill cf-provision chrome

help:
	@echo "Plug-and-Play commands for google-flow-mcp-http:"
	@echo "  make setup          - Generate .env (256-bit secrets) & MCP client config"
	@echo "  make up             - Start Docker stack (Chromium KasmVNC + MCP Streamable HTTP)"
	@echo "  make up-tunnel      - Start Docker stack + Cloudflare Tunnel sidecar"
	@echo "  make down           - Stop all Docker containers"
	@echo "  make logs           - Tail live logs from flow-mcp-server"
	@echo "  make install        - Install dependencies & build TypeScript (bare-metal)"
	@echo "  make chrome         - Launch local Chrome with CDP on 127.0.0.1:9222"
	@echo "  make start          - Start local Streamable HTTP server (bare-metal)"
	@echo "  make doctor         - Check CDP health & close hung/crashed Chrome tabs"
	@echo "  make test           - Run end-to-end JSON-RPC smoke test against /mcp"
	@echo "  make install-skill  - Install SKILL.md to Hermes Agent, Claude Code, and Antigravity"
	@echo "  make cf-provision   - Provision unbuffered SSE Configuration Rule via Cloudflare API"

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
	@echo "KasmVNC Login GUI available at https://127.0.0.1:3001 (use an SSH tunnel on headless VPS/homelab)"

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
	@echo "[OK] SKILL.md installed to ~/.hermes/skills, ~/.claude/skills, and .agent/skills"

cf-provision:
	node scripts/provision-cloudflare-rules.mjs
