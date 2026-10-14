# Go lives in /usr/local/go/bin, which is not on PATH in non-interactive shells.
export PATH := $(CURDIR)/bin:/usr/local/go/bin:$(PATH)

# Pinned dev tools, installed into ./bin (ignored by git) by `make tools`.
SQLC_VERSION         := v1.31.1
OAPI_CODEGEN_VERSION := v2.8.0
GOLANGCI_VERSION     := v2.14.0
# Tools are built with the same toolchain as the module (the system Go is too old).
GO_TOOLCHAIN         := go1.27.1

DEV_DB_URL := postgres://scheduler:scheduler@127.0.0.1:5433/scheduler?sslmode=disable

.PHONY: help install tools gen gen-api gen-sqlc gen-ts lint test build dev-db dev-db-down dev dev-web

help:
	@echo "install    install frontend dependencies (npm ci)"
	@echo "tools      install pinned code generators and linters into ./bin"
	@echo "gen        regenerate Go (oapi-codegen, sqlc) and TS code from api/openapi.yaml, migrations and queries"
	@echo "lint       golangci-lint, eslint, tsc and prettier check"
	@echo "test       backend (with dev Postgres) and frontend tests"
	@echo "build      build the backend binary into ./bin and the frontend into frontend/dist"
	@echo "dev-db     start the dev Postgres on 127.0.0.1:5433"
	@echo "dev        run the backend against the dev database"
	@echo "dev-web    run the Vite dev server (proxies /api to the backend)"

install:
	cd frontend && npm ci

# proxy.golang.org answers 403 for some tool dependencies on this server, so GOPROXY=direct.
tools:
	GOPROXY=direct GOTOOLCHAIN=$(GO_TOOLCHAIN) GOBIN=$(CURDIR)/bin go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)
	GOPROXY=direct GOTOOLCHAIN=$(GO_TOOLCHAIN) GOBIN=$(CURDIR)/bin go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION)
	GOPROXY=direct GOTOOLCHAIN=$(GO_TOOLCHAIN) GOBIN=$(CURDIR)/bin go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_VERSION)

gen: gen-api gen-sqlc gen-ts

gen-api:
	cd backend/internal/httpapi && oapi-codegen -config oapi-codegen.yaml ../../../api/openapi.yaml

# sqlc fails when there are no queries yet, so skip until the first one is added.
gen-sqlc:
	@if ls backend/queries/*.sql >/dev/null 2>&1; then cd backend && sqlc generate; else echo "gen-sqlc: no queries yet, skipping"; fi

gen-ts:
	cd frontend && npm run --silent gen:api

lint:
	cd backend && golangci-lint run ./...
	cd frontend && npm run --silent lint && npm run --silent typecheck && npm run --silent format:check

test: dev-db
	cd backend && TEST_DATABASE_URL='$(DEV_DB_URL)' go test ./...
	cd frontend && npm test --silent

build:
	cd backend && go build -o ../bin/scheduler ./cmd/scheduler
	cd frontend && npm run --silent build

dev-db:
	docker compose -f docker-compose.dev.yml up -d --wait db

dev-db-down:
	docker compose -f docker-compose.dev.yml down

dev:
	cd backend && APP_ENV=dev DATABASE_URL='$(DEV_DB_URL)' go run ./cmd/scheduler

dev-web:
	cd frontend && npm run dev
