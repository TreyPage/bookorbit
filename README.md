# BookOrbit

![BookOrbit dashboard](docs/images/dashboard-overview.png)

**BookOrbit is a self-hosted library management and reading platform** for organizing ebooks, PDFs, comics, and audiobooks. This repository contains the web application, API server, database migrations, KOReader integration, and optional read-aloud worker.

[![CI](https://img.shields.io/github/actions/workflow/status/TreyPage/bookorbit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/TreyPage/bookorbit/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/TreyPage/bookorbit?style=flat-square)](LICENSE)

## What BookOrbit does

- **Library management:** organize multiple libraries, scan folders, extract and edit metadata, manage series, and write supported metadata back to files.
- **Library maintenance:** find duplicate books and formats, review library-integrity findings, identify missing or orphaned resources, and merge or correct book/file records.
- **Content verification:** compare evidence extracted from ebook and audiobook files against the expected book identity. Optional OpenAI-compatible AI and speech-to-text endpoints support the verification workflow.
- **Book requests:** manage requests and their fulfillment lifecycle, including integrations with configured indexers and download clients.
- **Book Dock:** ingest completed downloads from a configured staging folder and review items before or during library import.
- **Reading:** use the web readers, track reading progress, and manage bookmarks, highlights, annotations, and reading history.
- **Device and service integrations:** synchronize with Kobo and KOReader, and connect supported services such as Hardcover, Readwise, and StoryGraph.
- **Collections and discovery:** organize books with collections, saved smart scopes, search, recommendations, and metadata providers.
- **Read-aloud and text-to-speech:** generate EPUB 3 Media Overlays editions with the optional worker, and configure supported TTS services.
- **Multi-user administration:** manage users, roles, permissions, authentication, and OIDC identity providers.

The repository includes the web client and server. It does **not** contain native iOS, Android, or Apple Watch application source code, nor a managed-hosting service.

## Roadmap and planned improvements

The following items describe current development goals and areas we want to improve. They are plans, not claims that the functionality is already available; scope and priority may change as implementation and testing progress.

### Reliability and data safety

- Strengthen filesystem/database consistency for operations that move, replace, merge, or delete library files.
- Add safer staged deletion with recovery or quarantine, clear previews of affected files, and safeguards against destructive cleanup.
- Expand database-backed integration tests for filesystem operations, imports, merges, and failure recovery.
- Improve merge audit history and make merge operations safe to retry without duplicating changes or damaging reading history.
- Strengthen CI and release checks so migrations, upgrades, and destructive workflows are verified before release.

### Metadata correction and provenance

- Expand metadata write-back with previews, field-level change comparisons, individual and bulk operations, and visible success/failure results.
- Protect richer or more trustworthy existing metadata from being overwritten by weaker matches.
- Add bulk metadata correction and clearer metadata provenance so users can understand where values came from and why they were selected.
- Improve provider matching, result quality, and caching.

### Library Integrity and organization

- Evolve Library Integrity with cross-record file identification, clearer keep/delete decisions, missing-file detection, scan history, and safer bulk cleanup.
- Add quarantine and undo workflows for cleanup operations where recovery is possible.
- Improve organization cleanup, including orphaned resources, empty folders, and inconsistent series names.
- Make scans easier to review and repeat, including saved scan results and clearer progress reporting.

### Requests, imports, and integrations

- Continue automating the request-to-fulfillment lifecycle and make background work, status, and failures easier to inspect.
- Improve Book Dock diagnostics and correction workflows so staged files can be identified, corrected, and imported with less manual filesystem work.
- Improve import and rescan progress reporting.
- Add better reconciliation and diagnostics for supported library and download integrations, including Audiobookshelf and Shelfmark workflows.

### Interface improvements

- Add request-table layout preferences: show or hide optional columns, reorder and resize columns, persist preferences, and restore the default layout.
- Preserve existing sorting, selection, row actions, and the separate mobile-card experience when table customization is used.

## Screenshots

![BookOrbit dashboard](docs/images/dashboard-overview.png)

The KOReader integration is maintained in this repository:

![BookOrbit KOReader plugin](docs/images/koreader-plugin-preview.webp)

See [koreader-plugin/README.md](koreader-plugin/README.md) for installation and configuration.

## Quick start: run with Docker Compose

The repository includes a production Compose configuration and an environment template.

```bash
git clone https://github.com/TreyPage/bookorbit.git
cd bookorbit

mkdir -p books data/app data/postgres
cp .env.example .env
```

Edit `.env` before starting the stack:

- Set `APP_URL` to the URL users will use to reach BookOrbit.
- Set strong, unique values for `POSTGRES_PASSWORD`, `JWT_SECRET`, and `SETUP_BOOTSTRAP_TOKEN`.
- Set `BOOKS_HOST_PATH` to the host directory containing your library.
- Adjust `APP_PORT`, `PUID`, and `PGID` if your deployment requires it.

Generate secrets with OpenSSL, for example:

```bash
openssl rand -hex 32
```

Start the application:

```bash
docker compose up -d
```

Complete the initial setup in the web interface using the bootstrap token configured in `.env`.

The Compose file also defines optional profiles for Kokoro TTS and the read-aloud worker. Their configuration is documented in [the environment template](.env.example), [Read-Aloud Generation](docs/READ_ALOUD.md), and [Read-Aloud Delivery](docs/READ_ALOUD_DELIVERY.md).

For the full list of deployment options, inspect [docker-compose.yml](docker-compose.yml) and [.env.example](.env.example).

## Development setup

BookOrbit is a pnpm monorepo. The main components are a Vue 3 client, a NestJS/Fastify server, shared TypeScript packages, and the optional read-aloud worker.

### Requirements

- Node.js **24 or later** (the root package currently pins pnpm through `packageManager`).
- pnpm **11 or later**.
- Docker with Docker Compose for the development PostgreSQL database.

### Bootstrap

From the repository root:

```bash
pnpm setup
```

`pnpm setup` installs workspace dependencies, creates `server/.env` from `server/.env.example` if needed, starts the development PostgreSQL service, applies migrations, and seeds baseline data.

Start the client, server, and shared-types watcher:

```bash
pnpm dev
```

Default local endpoints:

| Component | Address |
| --- | --- |
| Web client | http://localhost:6263 |
| API server | http://localhost:6262/api |
| Swagger UI (when enabled) | http://localhost:6262/api/docs |
| Development PostgreSQL | localhost:5432 |

To enable Swagger locally, set `SWAGGER_ENABLED=true` in `server/.env`.

### Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start client, server, and shared-types watcher |
| `pnpm run db:up` | Start the development PostgreSQL container |
| `pnpm run db:migrate` | Apply database migrations |
| `pnpm run db:seed` | Seed baseline data |
| `pnpm run test` | Run repository test suites |
| `pnpm run test:server` | Run server unit tests |
| `pnpm run test:client` | Run client unit tests |
| `pnpm run test:worker` | Run read-aloud worker tests |
| `pnpm run e2e:list` | List available E2E suites |
| `pnpm run e2e:run -- <suite-id>` | Run one E2E suite |
| `pnpm run e2e:all` | Run all E2E suites |
| `pnpm run lint:check` | Run client and server lint checks |
| `pnpm run typecheck` | Type-check server, client, and worker |
| `pnpm run format:check` | Check formatting |
| `pnpm run verify` | Run lint, type-check, and tests |
| `pnpm run verify:strict` | Run formatting, lint, full type-check, and tests |

See [Development Guide](docs/DEVELOPMENT.md) for architecture, database workflows, environment configuration, and development conventions. See [Testing Guide](docs/TESTING.md) for unit and E2E test details.

## Repository layout

```text
bookorbit/
├── client/                 # Vue 3 web application
├── server/                 # NestJS API, domain modules, Drizzle schema and migrations
├── packages/
│   ├── types/              # Shared TypeScript types
│   └── plugin-api/         # Plugin API types and contracts
├── workers/
│   └── read-aloud/         # Optional read-aloud generation worker
├── koreader-plugin/        # KOReader plugin source
├── docker/                 # Development database initialization
├── docs/                   # Development, testing, integration and operational guides
├── scripts/                # Bootstrap, database, E2E and repository tooling
├── docker-compose.yml      # Production Compose deployment
└── docker-compose.dev.yml  # Local development services
```

## Further documentation

- [Development Guide](docs/DEVELOPMENT.md)
- [Testing Guide](docs/TESTING.md)
- [Metadata Providers](docs/METADATA_PROVIDERS.md)
- [Build an External Metadata Provider](docs/BUILDING_METADATA_PROVIDERS.md)
- [KOReader Plugin](koreader-plugin/README.md)
- [Read-Aloud EPUB Generation](docs/READ_ALOUD.md)
- [Read-Aloud Delivery](docs/READ_ALOUD_DELIVERY.md)
- [Kobo/KOReader Hash Matching](docs/KOREADER_HASH_MATCHING.md)
- [DJVU Reader](docs/DJVU_READER.md)
- [Server Connection Identity](docs/SERVER_CONNECTION_IDENTITY.md)
- [Localization](docs/LOCALIZATION.md)
- [Commit Guidelines](docs/COMMIT_GUIDELINES.md)
- [AI-Assisted Development Policy](docs/AI_POLICY.md)
- [Community Guidelines](docs/COMMUNITY.md)
- [Code of Conduct](docs/CODE_OF_CONDUCT.md)
- [Security Policy](.github/SECURITY.md)
- [Release Process](docs/RELEASE_PROCESS.md)

## Contributing and support

Development takes place in this repository. Before opening a pull request, review the [Development Guide](docs/DEVELOPMENT.md), [Testing Guide](docs/TESTING.md), and [Commit Guidelines](docs/COMMIT_GUIDELINES.md).

For questions, bug reports, and feature requests, use the [GitHub issue tracker](https://github.com/TreyPage/bookorbit/issues). Do not post security vulnerabilities in public issues; follow the [Security Policy](.github/SECURITY.md).

## License

BookOrbit is licensed under the **GNU Affero General Public License v3.0 only**. See [LICENSE](LICENSE). Additional terms and required attribution are described in [ADDITIONAL_TERMS.md](ADDITIONAL_TERMS.md) and [NOTICE](NOTICE).
