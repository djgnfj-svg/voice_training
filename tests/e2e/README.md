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

## Mock LLM mode

For specs that exercise agent flows (agent-interview, learning-coach), set
`E2E_MOCK_LLM=1` on the **backend** container so OpenAI calls are replaced
with deterministic canned responses. This makes runs reproducible and free
of API cost. The backend must be restarted to pick up the env var.

Quick toggle (dev):
```
docker compose stop backend
E2E_MOCK_LLM=1 docker compose up -d backend
docker compose restart nginx          # refresh DNS to backend
# ... run specs ...
docker compose stop backend && docker compose up -d backend && docker compose restart nginx
```

The mock covers `call_llm`, `call_llm_json`, `call_llm_stream`,
`call_llm_vision`, and the embedding entry point. The learning-coach
agentic LangGraph loop (which calls AsyncOpenAI directly via tool-calling)
is NOT mocked — specs depending on it should be skipped under
`E2E_MOCK_LLM=1` or run against the real API.

Do NOT add `E2E_MOCK_LLM=1` to `docker-compose.yml` — it must stay OFF by
default so normal dev hits the real LLM.

## Claude Code Skill

`voiceprep-e2e` skill at `~/.claude/skills/voiceprep-e2e/SKILL.md` wraps execution + result interpretation. Trigger with `/e2e`, `/e2e <name>`, or natural-language requests like "E2E 돌려줘".
