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
TERRAFORM_DIR := $(REPO_DIR)/deploy/terraform
TERRAFORM_IMAGE := hashicorp/terraform:1.17.1@sha256:a5d5a5a892c98f60fcbfa81eac2a40fc19e7b3fa7719bccae10ff6111d22524a
TFLINT_IMAGE := ghcr.io/terraform-linters/tflint:v0.65.0@sha256:2788f4d4fc663c0e953b011b01bf443fe5bfce7587ee916e588e6057b85d6359
# Sources mounted read-only; provider and plugin downloads go to a per-checkout cache volume.
TERRAFORM_RUN := docker run --rm --memory 2g -v "$(TERRAFORM_DIR)":/src:ro -v trame-terraform-$(PROJECT_HASH):/cache -w /src \
	-e TF_DATA_DIR=/cache/data -e TFLINT_PLUGIN_DIR=/cache/tflint -e GITHUB_TOKEN

.PHONY: help up down logs ps build wasm test test-rust test-web test-game-systems srd-content lint lint-rust lint-web lint-design lint-terraform fmt check shell-rust shell-web db-psql clean e2e-image e2e e2e-video deploy-compose-smoke

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
# S3 integration tests also need TEST_DATABASE_URL; after `make up`, pass
# TEST_S3_ENDPOINT=http://minio:9000 to run them against the dev Silo service.
TEST_S3_ENDPOINT ?=
TEST_S3_BUCKET ?= trame-test
TEST_S3_ACCESS_KEY_ID ?= trame_minio
TEST_S3_SECRET_ACCESS_KEY ?= trame_minio_secret_key

test-rust: ## Run Cargo workspace tests inside the Rust Docker container
	$(DEV_COMPOSE) run --rm --no-deps -e DATABASE_URL="$(TEST_DATABASE_URL)" \
		-e TEST_S3_ENDPOINT="$(TEST_S3_ENDPOINT)" -e TEST_S3_BUCKET="$(TEST_S3_BUCKET)" \
		-e TEST_S3_ACCESS_KEY_ID="$(TEST_S3_ACCESS_KEY_ID)" \
		-e TEST_S3_SECRET_ACCESS_KEY="$(TEST_S3_SECRET_ACCESS_KEY)" \
		rust-dev cargo test --workspace --all-targets

test-web: wasm test-game-systems ## Run Web frontend (incl. WASM parity) and game-system tests inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev npm test

test-game-systems: wasm ## Run packages/game-systems/dnd5e tests inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev node --test "../game-systems/dnd5e/tests/**/*.test.ts"

srd-content: ## Regenerate the dnd5e SRD 5.2.1 packs from the pinned Open5e snapshot (ARGS="--check" verifies them)
	$(DEV_COMPOSE) run --rm --no-deps web-dev node ../game-systems/dnd5e/scripts/generate-srd-content.ts $(ARGS)

lint: lint-rust lint-web lint-design lint-terraform ## Run all linters and format checks (glossary/ADR integrity, Impeccable design audit, rustfmt, clippy, eslint, tsc, terraform, tflint) inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev python3 scripts/check-glossary-and-adrs.py

lint-design: ## Run Impeccable design system audit (WCAG AA, tokens, Craft Floor) inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev node /workspace/scripts/check-impeccable-design.mjs

lint-rust: ## Run cargo fmt check and clippy inside the Rust Docker container
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo fmt --all -- --check
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo clippy --workspace --all-targets --all-features -- -D warnings

lint-terraform: ## Check deploy/terraform: terraform fmt, init -backend=false (lock file read-only) + validate, tflint (pinned images)
	$(TERRAFORM_RUN) $(TERRAFORM_IMAGE) fmt -check -recursive -diff
	$(TERRAFORM_RUN) --entrypoint sh $(TERRAFORM_IMAGE) -c 'mkdir -p /cache/plugins && TF_PLUGIN_CACHE_DIR=/cache/plugins terraform init -backend=false -input=false -lockfile=readonly >/dev/null && terraform validate'
	$(TERRAFORM_RUN) --entrypoint sh $(TFLINT_IMAGE) -c 'tflint --init >/dev/null && tflint --format=compact'

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

# The stack is the production Compose file with Silo; while the browsers stay open the
# journey asks e2e/scripts/run-e2e.sh to SIGKILL, restart, back up and restore the server.
e2e: ## Run the GM + three players Playwright journey (videos) on the prod Compose stack with Silo, with mid-session SIGKILL, restart, backup + restore, then tear down
	E2E_PROJECT=trame-e2e-$(PROJECT_HASH) sh "$(REPO_DIR)/e2e/scripts/run-e2e.sh"

e2e-video: ## Combine e2e/artifacts/gm.webm and player.webm into a labelled side-by-side MP4
	sh "$(REPO_DIR)/e2e/scripts/side-by-side.sh" "$(REPO_DIR)/e2e/artifacts"

# Uses the trame-server:e2e image from `make e2e-image` (TRAME_IMAGE overrides it).
deploy-compose-smoke: ## Smoke-test the production Compose stack through Caddy (HTTPS, WebSocket deflate, Silo CORS, backup + restore), then tear it down
	SMOKE_PROJECT=trame-deploy-$(PROJECT_HASH) timeout 900 sh "$(REPO_DIR)/deploy/compose/smoke/run-smoke.sh"
