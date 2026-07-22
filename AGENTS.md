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

SQLite is authoritative; SSE and browser state are projections. Public Agent speech must open `begin_message_to_room`; its streamed room bubble is temporary until the message commits. Ordinary assistant output stays private. Never commit `.env.local`, keys, `.oceanking/`, uploads, or databases. Shell tools inherit full host permissions, so preserve loopback binding and Origin validation.

Human messages and committed Agent `kind=handoff` messages immediately supersede active target-Agent runs, which must preserve an interruption snapshot for takeover. Agent `kind=notify` messages never enqueue, advance, or interrupt another Agent. Non-message room events such as invitations remain queued without preemption.

Public Agent messages have only two protocol kinds: `notify` is a process update that publishes without satisfying delivery or waking another Agent, while `handoff` is an ending message that publishes, ends the current Turn, and wakes the room's next Agent. `read_no_reply` remains a non-message receipt for an exact inbound message and is how a receiver terminates a chain without public output. Cross-room waits are runtime-managed through `turn_handoffs.awaiting_reply`; a resumed task uses `handoff` both to continue delegation and to return a final result to its source room. Do not add model-visible wait tools or poll `read_room_history` inside the sending Turn.

## Global Model Configuration

- The server natively reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_MODELS`, and `OPENAI_API_FORMAT` from `process.env`; a repository-root `.env.local` is only one way to populate them.
- The model-visible `web_search` tool works without configuration through public search sources (DuckDuckGo for webpages, Google News RSS for news, with Bing RSS as a webpage fallback). If `BRAVE_SEARCH_API_KEY` is present in `process.env`, it automatically upgrades to Brave Search; the optional key is never persisted in SQLite. Restart OceanKing after adding or changing it.
- On Windows, share model configuration across Git worktrees by storing these variables as user-scoped environment variables, for example with `[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<secret>", "User")`. Do not add a repository-specific loader for `%USERPROFILE%\.oceanking\config.env`; OceanKing does not natively read that file.
- Restart the terminal or host application and the OceanKing server after changing user-scoped variables. Existing processes retain the environment captured when they started.
- Never record real keys or private values in this file, Git, shell history, logs, tests, or screenshots.
- Keep `OCEANKING_DATA_DIR` instance-specific rather than user-global when multiple worktrees may run simultaneously; sharing one SQLite data directory across active backends is unsupported.

## Commit & Pull Request Guidelines

Use concise Chinese commits matching history, such as `修复房间调度重入问题`. PRs should explain intent, user impact, security implications, and validation. Link issues and include screenshots for UI changes. Separate unrelated refactors.

## Nested Instructions & Maintenance

Before editing, check for a nearer `AGENTS.md` or `AGENTS.override.md`; the closest takes precedence. Add nested guidance only for stable directory-specific differences. Update this file when commands, structure, safety boundaries, or workflows change. Never record credentials, task logs, timestamps, or temporary debugging notes. Review it before each commit and include relevant updates with the code change.
