# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript/ESM QQ bot framework built on `@tencent-connect/qqbot-nodejs`.
The entry point is `src/index.ts`; `src/config.ts` parses environment variables,
`src/bot.ts` wraps connection lifecycle and event dispatch, `src/logger.ts` handles
logging, and `src/chat-log.ts` persists JSONL records and media. Operational scripts
live in `src/scripts/`. The official API snapshot is under `docs/qq-api/`; consult
it before changing protocol behavior. `data/` and `logs/` are ignored runtime stores.

## Build, Test, and Development Commands

Use Node.js 22+ and pnpm:

```bash
pnpm install
cp .env.example .env
pnpm qq:login          # Scan to obtain QQ credentials and update .env
pnpm dev               # Watch mode with .env loaded
pnpm start             # Run the bot
pnpm typecheck         # Strict TypeScript check
pnpm qq:check          # Offline config, logging, protocol, and Bot assertions
pnpm webhook:check     # Local webhook end-to-end check
pnpm integration:check # typecheck + qq:check + webhook:check
```

## Coding Style & Naming Conventions

Keep TypeScript strict and ESM-compatible: use `import type` for type-only imports,
`.js` suffixes on relative imports, and no `enum`, `namespace`, or constructor
parameter properties. Follow the existing style: two-space indentation, single
quotes, semicolons, and trailing commas. Use `camelCase` for functions and variables,
`PascalCase` for classes and types, and `UPPER_SNAKE_CASE` for constants. Comments and
user-facing text are primarily Chinese. Keep `Bot` as a thin wrapper; do not
reimplement authentication, gateway, webhook, retry, or messaging logic already
provided by the connector.

## Testing Guidelines

There is no Jest/Vitest suite or coverage threshold. Add assertions to
`src/scripts/qq-check.ts` for configuration, logging, chat persistence, decoding,
signing, or Bot assembly changes; add webhook behavior checks to
`webhook-check.ts`. Name each assertion with a short, specific `check(...)` label.
`pnpm qq:check` must pass without credentials or network access after protocol-related
changes. Run `pnpm integration:check` before submitting; live QQ verification is
manual and requires a configured `.env`.

## Commit & Pull Request Guidelines

Git history follows Conventional Commits with optional scopes, for example
`feat: ...`, `fix(docs): ...`, `docs: ...`, and `chore: ...`. Keep commits focused.
Pull requests should summarize behavior, affected modules, commands run, and any
linked issue. Include screenshots only for visible output; state live credentials or
network validation separately when it was not exercised.

## Security & Configuration

Never commit `.env`, logs, downloaded media, or chat data. Read configuration through
`loadConfig()` and keep secrets out of logs; the logger redacts credential-like
fields. Use `CHAT_DATA_DIR` and `LOG_FILE` rather than hard-coding runtime paths.
