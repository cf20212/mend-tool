# mend-tool

mend — a patch tool for AI edit formats. It applies patches written in four formats — unified diff, SEARCH/REPLACE blocks, the V4A Begin/End Patch envelope, and JSON edit arrays (or JSON Lines) — with one file model (CRLF preserved per file, final-break state kept), three-tier context matching (exact, trailing blanks off, both ends off; `--strict` pins tier 0), all-or-nothing application with per-edit error lines, and byte-ordered `A`/`D`/`M`/`R` reporting. It scores 100/100 on the kit's practice set and passes 46 additional adversarial checks written against spec sentences the practice set does not cover.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cf20212/mend-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cf20212/mend-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

## Run

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH absent or `-` reads the patch from stdin. Exit 0 reports the changed files and `ok: <n> file(s)`; exit 1 lists one `error: <code> <path>` per failed edit and writes nothing; exit 2 is a single usage/no-patch/format/parse error line.

Built by an AI agent for make.fun's "Build mend, a patch tool for AI edit formats, 22 November 2026" bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
