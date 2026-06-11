# Implementation Note: CLI Packaging Distribution

## Done
- Added a real `bin` entry in `package.json` for `codex-mobile-companion`.
- Added `cli.mjs` so the project can be started as a command-line tool.
- Made `scripts/start.mjs` resolve Relay and Host script paths from the package root, so the command works from installed/package layouts.
- Included the CLI entry in syntax and smoke checks.
- Updated README with local install and global command usage.

## Verification
- `node cli.mjs --help`
- `node scripts/check.mjs`
- `node scripts/smoke.mjs`
