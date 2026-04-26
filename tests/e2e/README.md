# VoicePrep E2E

Playwright tests for VoicePrep. Lives separately from `frontend/` so deps don't pollute the app.

## Prerequisites

Dev environment must be running:
```
docker compose up -d
```
Confirm `http://localhost:81` is reachable.

## Environment Variables

Set these in `tests/e2e/.env` (gitignored) or your shell before running tests:

| Var | Purpose |
| --- | --- |
| `NEXTAUTH_SECRET` | Same value as the root `.env` — used to sign/encrypt the session cookie. |
| `E2E_ADMIN_USER_ID` | The Prisma `User.id` (UUID/cuid) of an admin account in the database. |
| `E2E_ADMIN_EMAIL` | Email of that account; **must be listed in `NEXT_PUBLIC_ADMIN_EMAILS`** (default `test@voiceprep.kr`). |
| `E2E_BASE_URL` | Defaults to `http://localhost:81`. |

To find the admin User.id quickly:
```
cd frontend && set -a && source ../.env && set +a && npx prisma studio
```
Or run a SQL query against the database for the row matching `E2E_ADMIN_EMAIL`.

## Run

```
cd tests/e2e
npm test                                    # all specs, all viewports
npm run test:visual                         # visual regression only (Task 13+)
npx playwright test specs/auth.spec.ts      # one spec
npx playwright test --project=desktop       # one viewport
```

## Reports

```
npm run report
```
Opens `playwright-report/index.html`. Failed runs leave traces in `test-results/`.

## Visual Snapshot Updates

After intentional UI changes:
```
npx playwright test specs/visual.spec.ts --update-snapshots
```
Review the updated PNGs under `specs/visual.spec.ts-snapshots/` before committing.

## Claude Code Skill

`voiceprep-e2e` skill at `~/.claude/skills/voiceprep-e2e/SKILL.md` wraps execution + result interpretation. Trigger with `/e2e`, `/e2e <name>`, or natural-language requests like "E2E 돌려줘".
