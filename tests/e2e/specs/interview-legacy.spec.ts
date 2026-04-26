import { test, expect } from '../fixtures/auth';

// Discovery (2026-04-26):
// The legacy (non-agent) interview supports `textMode` at the API/DB layer
// (`backend/app/routers/interview.py:30`, `backend/app/models/interview.py:43`)
// and in the session UI (`frontend/src/app/(authenticated)/interview/session/[id]/page.tsx`
// reads `data.textMode` and renders a textarea when true). However:
//
//   - `/interview/setup` only starts the AI-coach (agent) interview — its
//     "면접 시작" button routes to `/agent-interview/session/new`.
//   - There is no UI toggle for textMode anywhere in the legacy flow.
//   - There is no UI path to create a legacy InterviewSession at all.
//     Legacy sessions only exist as historical records.
//
// The plan explicitly defers any frontend changes for legacy textMode, so this
// spec is parked as skipped until either (a) a setup UI for legacy + a textMode
// toggle is added, or (b) a Task-3-style URL admin override is wired into the
// legacy session creation path.
test('legacy interview: textMode flow → answer → report', async ({ adminPage, errors }) => {
  test.skip(
    true,
    'no legacy textMode UI: /interview/setup only starts agent-interview, ' +
      'and legacy InterviewSession has no creation UI or textMode toggle. ' +
      'Re-enable once a legacy setup path + textMode toggle (or URL override) exists.',
  );

  // Below kept as a sketch for the eventual implementation.
  void adminPage;
  void errors;
  void expect;
});
