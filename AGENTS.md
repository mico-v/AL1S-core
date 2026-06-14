# Repository Guidelines

## Project Structure & Module Organization
- `main.py`: Plugin entrypoint and runtime behavior (`AL1SCorePlugin`) for AstrBot lifecycle hooks and command handlers.
- `output_spec.py`: Text-cleaning and message-formatting logic used by plugin hooks.
- `_conf_schema.json`: Declarative plugin configuration schema shown in AstrBot UI.
- `metadata.yaml`: Plugin metadata (`name`, `version`, compatibility range, repo link).
- `requirements.txt`: Runtime dependency declarations.
- `assets/fonts/`: Bundled Chinese fonts for table/markdown rendering-related behavior.
- `README.md`: Feature overview, install steps, and configuration explanation.

## Build, Test, and Development Commands
- `pip install -r requirements.txt` installs supported runtime dependency (`astrbot>=4.16,<5`).
- `python -m py_compile main.py output_spec.py` checks for syntax/type-name errors before restart.
- `cp -r /path/to/astrbot_plugin_al1s_core /path/to/data/plugins/` then restart AstrBot to run a local smoke test.
- No project build pipeline exists; validate behavior by invoking plugin commands (`/al1s`, `/精华消息`, etc.) in a test group.

## Coding Style & Naming Conventions
- Use 4-space indentation and current plugin style: type hints, clear helper methods, and concise logging.
- Naming: `snake_case` for functions/variables, `CamelCase` for classes, constants in `UPPER_CASE`.
- Keep handler methods single-purpose and keep side effects behind small helpers (cache, parsing, sending).
- Prefer existing libraries over adding new dependencies unless justified.
- If adding tests/formatting tooling, follow `ruff`/`black` defaults and run format/lint before committing.

## Testing Guidelines
- This repository currently has no automated test suite or `tests/` directory.
- If adding tests, use `pytest` with `test_*.py` files and keep utility functions in separate modules for unit coverage.
- Prioritize tests for parsing/formatting logic in `output_spec.py` and cache behavior in `main.py`.
- Minimum verification for every change: restart AstrBot and run at least one command path plus one error path (e.g., unsupported cache state).

## Commit & Pull Request Guidelines
- Existing commits follow a conventional style (`feat(plugin): ...`, `chore: ...`, etc.).
- Use imperative, scoped commit messages (e.g., `feat(plugin): add command flag parsing for ...`).
- PRs should include: summary of behavior change, config impact, command(s) used to validate, and mention of any compatibility/risk.
- Include related issue/feature ID when available and screenshots/log snippets only when user-facing output changes.

## Security & Configuration Tips
- Do not commit secrets (bot tokens, signatures, group IDs, admin credentials).
- Default cache directories are under AstrBot plugin data (`StarTools.get_data_dir`). Keep cache cleanup behavior unchanged unless user data retention is required.
- If you introduce new config fields, update `_conf_schema.json`, `README.md`, and any defaults in code together.
