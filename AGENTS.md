# Repository Guidelines

## Project Structure & Module Organization

- `src/app/` contains App Router pages and REST/SSE routes under `src/app/api/`.
- `src/components/workspace/` contains room, Console, settings, and Cron UI.
- `src/lib/domain/` defines shared Zod schemas and TypeScript types.
- `src/lib/server/` owns SQLite, scheduling, models, tools, and Cron; database code lives in `src/lib/server/db/`.
- `tests/` contains Vitest integration and protocol tests. Runtime data stays in ignored `.oceanking/`.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies.
- `pnpm dev` starts the local server on `127.0.0.1:3000`.
- `pnpm lint` runs the Next.js ESLint rules.
- `pnpm typecheck` runs strict TypeScript checks.
- `pnpm test` runs Vitest once; `pnpm test:watch` watches changes.
- `pnpm build` validates the production bundle; `pnpm start` serves it locally.

## Coding Style & Naming Conventions

Use TypeScript, strict types, two-space indentation, semicolons, and the `@/` alias. Use PascalCase for components and types, camelCase for functions and variables, and lowercase kebab-case for files (for example, `model-runtime.ts`). Keep server code out of client components. Reuse canonical Zod schemas instead of duplicating request or tool shapes.

## Testing Guidelines

Vitest runs in Node and serializes tests because they share process state. Name tests `*.test.ts` or `*.test.tsx`. Add temporary-SQLite coverage for repository, scheduler, recovery, or command changes. Model adapters should cover malformed streams, tool deltas, cancellation, and both API formats. There is no fixed threshold; behavior changes need regression tests.

## Architecture & Security

SQLite is authoritative; SSE and browser state are projections. Public Agent speech must use `send_message_to_room`; its streamed room bubble is temporary until the tool commits. Ordinary assistant output stays private. Never commit `.env.local`, keys, `.oceanking/`, uploads, or databases. Shell tools inherit full host permissions, so preserve loopback binding and Origin validation.

## Commit & Pull Request Guidelines

Use concise Chinese commits matching history, such as `修复房间调度重入问题`. PRs should explain intent, user impact, security implications, and validation. Link issues and include screenshots for UI changes. Separate unrelated refactors.

## Nested Instructions & Maintenance

Before editing, check for a nearer `AGENTS.md` or `AGENTS.override.md`; the closest takes precedence. Add nested guidance only for stable directory-specific differences. Update this file when commands, structure, safety boundaries, or workflows change. Never record credentials, task logs, timestamps, or temporary debugging notes. Review it before each commit and include relevant updates with the code change.
