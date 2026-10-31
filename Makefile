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

.PHONY: help up down logs ps build wasm test test-rust test-web lint lint-rust lint-web fmt check shell-rust shell-web db-psql clean

help: ## Display available Docker-based development commands
	@awk 'BEGIN {FS = ":.*##"; printf "TRAME Docker Development Workflow\nUsage: make <target>\n\nTargets:\n"} /^[a-zA-Z][a-zA-Z0-9_-]*:.*##/ {printf "  %-14s %s\n", $$1, $$2}' "$(MAKEFILE_PATH)"

up: ## Start the isolated local development stack (Postgres 18, MinIO S3, Rust server, Web HMR)
	$(DEV_COMPOSE) up -d --build

down: ## Stop the isolated local development stack without removing data volumes
	$(DEV_COMPOSE) down --remove-orphans

logs: ## Follow logs across all local development containers
	$(DEV_COMPOSE) logs -f

ps: ## List running containers for this checkout
	$(DEV_COMPOSE) ps

wasm: ## Compile crates/trame-engine to WebAssembly via wasm-pack inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev wasm-pack build crates/trame-engine --target web --out-dir ../../packages/web/src/wasm

build: ## Build Rust workspace and Web frontend inside Docker
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo build --workspace
	$(DEV_COMPOSE) run --rm --no-deps web-dev npm run build

test: test-rust test-web ## Run all unit and integration tests (Rust + WASM + Web) inside Docker

test-rust: ## Run Cargo workspace tests inside the Rust Docker container
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo test --workspace --all-targets

test-web: ## Run Web frontend tests inside the Node Docker container
	$(DEV_COMPOSE) run --rm --no-deps web-dev npm test

lint: lint-rust lint-web ## Run all linters and format checks (glossary/ADR integrity, rustfmt, clippy, eslint, tsc) inside Docker
	python3 "$(REPO_DIR)/scripts/check-glossary-and-adrs.py"

lint-rust: ## Run cargo fmt check and clippy inside the Rust Docker container
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo fmt --all -- --check
	$(DEV_COMPOSE) run --rm --no-deps rust-dev cargo clippy --workspace --all-targets --all-features -- -D warnings

lint-web: ## Run frontend lint and typecheck inside the Node Docker container
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
