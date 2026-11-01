.DEFAULT_GOAL := help

MAKEFILE_PATH := $(shell realpath -- "$(MAKEFILE_LIST)")
REPO_DIR := $(shell dirname -- "$(MAKEFILE_PATH)")
PROJECT_HASH := $(shell printf '%s' "$(REPO_DIR)" | sha256sum | cut -c1-12)
DEV_PROJECT := trame-dev-$(PROJECT_HASH)
COMPOSE_FILE := $(REPO_DIR)/docker-compose.dev.yml
ENV_FILE := $(REPO_DIR)/.env
COMPOSE_ENV_FILE := $(shell if [ -f "$(ENV_FILE)" ]; then printf '%s' '--env-file "$(ENV_FILE)"'; fi)
DC ?= docker compose
DEV_COMPOSE := $(DC) --project-name $(DEV_PROJECT) --project-directory "$(REPO_DIR)" $(COMPOSE_ENV_FILE) -f "$(COMPOSE_FILE)"
E2E_COMPOSE := E2E_UID=$$(id -u) E2E_GID=$$(id -g) $(DC) --project-name trame-e2e-$(PROJECT_HASH) --project-directory "$(REPO_DIR)" --env-file "$(REPO_DIR)/e2e/e2e.env" -f "$(REPO_DIR)/deploy/compose/docker-compose.prod.yml" -f "$(REPO_DIR)/e2e/docker-compose.e2e.yml"

.PHONY: help up down logs ps build wasm test test-rust test-web test-game-systems lint lint-rust lint-web lint-design fmt check shell-rust shell-web db-psql clean e2e-image e2e e2e-video

help: ## Display available Docker-based development commands
	@awk 'BEGIN {FS = ":.*##"; printf "TRAME Docker Development Workflow\nUsage: make <target>\n\nTargets:\n"} /^[a-zA-Z][a-zA-Z0-9_-]*:.*##/ {printf "  %-20s %s\n", $$1, $$2}' "$(MAKEFILE_PATH)"

up: wasm ## Start the isolated local development stack (Postgres 18, Silo S3, Rust server, Web HMR)
	$(DEV_COMPOSE) up -d --build

down: ## Stop the isolated local development stack without removing data volumes
	$(DEV_COMPOSE) down --remove-orphans

logs: ## Follow logs across all local development containers
	$(DEV_COMPOSE) logs -f

ps: ## List running containers for this checkout
	$(DEV_COMPOSE) ps

wasm: ## Compile crates/trame-engine to WebAssembly (browser + Node targets) via wasm-pack inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev sh -c "wasm-pack build crates/trame-engine --target web --out-dir ../../packages/web/src/wasm && wasm-pack build crates/trame-engine --target nodejs --out-dir ../../packages/trame-engine-node"

build: wasm ## Build Rust workspace and Web frontend inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo build --workspace
	$(DEV_COMPOSE) run --rm --no-deps web-dev npm run build

test: test-rust wasm test-game-systems test-web ## Run all tests in order (Rust, WASM build, game systems, Web incl. WASM parity) inside Docker

# Empty by default so PostgreSQL integration tests skip under `--no-deps`; after `make up`,
# pass TEST_DATABASE_URL=postgresql://trame:trame_dev_password@postgres:5432/trame to run them.
TEST_DATABASE_URL ?=

test-rust: ## Run Cargo workspace tests inside the Rust Docker container
	$(DEV_COMPOSE) run --rm --no-deps -e DATABASE_URL="$(TEST_DATABASE_URL)" rust-dev cargo test --workspace --all-targets

test-web: wasm test-game-systems ## Run Web frontend (incl. WASM parity) and game-system tests inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev npm test

test-game-systems: wasm ## Run packages/game-systems/dnd5e tests inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev node --test "../game-systems/dnd5e/tests/**/*.test.ts"

lint: lint-rust lint-web lint-design ## Run all linters and format checks (glossary/ADR integrity, Impeccable design audit, rustfmt, clippy, eslint, tsc) inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev python3 scripts/check-glossary-and-adrs.py

lint-design: ## Run Impeccable design system audit (WCAG AA, tokens, Craft Floor) inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev node /workspace/scripts/check-impeccable-design.mjs

lint-rust: ## Run cargo fmt check and clippy inside the Rust Docker container
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo fmt --all -- --check
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo clippy --workspace --all-targets --all-features -- -D warnings

lint-web: wasm ## Run frontend lint and typecheck inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev sh -c "npm run lint && npm run typecheck"

fmt: ## Format Rust workspace inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo fmt --all

check: lint test ## Run full local verification gate (lint + test) inside Docker

shell-rust: ## Open an interactive bash shell inside the Rust development container
	$(DEV_COMPOSE) run --rm rust-dev bash

shell-web: ## Open an interactive sh shell inside the Web development container
	$(DEV_COMPOSE) run --rm --no-deps web-dev sh

db-psql: ## Open a psql session against the local development PostgreSQL 18 container
	$(DEV_COMPOSE) exec postgres psql -U $${POSTGRES_USER:-trame} -d $${POSTGRES_DB:-trame}

clean: ## Stop containers and remove cached build/data volumes for this checkout
	$(DEV_COMPOSE) down -v --remove-orphans

e2e-image: ## Build the production Dockerfile image used by the browser E2E suite (trame-server:e2e)
	docker build -t trame-server:e2e "$(REPO_DIR)"

e2e: ## Run the GM + player Playwright journey (with videos) against the production image and Postgres, then tear down
	mkdir -p "$(REPO_DIR)/e2e/artifacts"
	rm -rf "$(REPO_DIR)/e2e/static"
	cid=$$(docker create trame-server:e2e) && docker cp "$$cid:/app/static" "$(REPO_DIR)/e2e/static"; rc=$$?; docker rm "$$cid" >/dev/null; exit $$rc
	$(E2E_COMPOSE) up -d --wait postgres trame-server spa-proxy
	$(E2E_COMPOSE) run --rm playwright; rc=$$?; $(E2E_COMPOSE) logs --no-color trame-server > "$(REPO_DIR)/e2e/artifacts/server.log" 2>&1; $(E2E_COMPOSE) --profile e2e down -v --remove-orphans; exit $$rc

e2e-video: ## Combine e2e/artifacts/gm.webm and player.webm into a labelled side-by-side MP4
	sh "$(REPO_DIR)/e2e/scripts/side-by-side.sh" "$(REPO_DIR)/e2e/artifacts"
