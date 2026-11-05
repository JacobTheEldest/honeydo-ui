# Agent workflow

Use this file as the single source of truth for HoneyDo development, testing, and deployment. Do not duplicate its step-by-step procedure in agent skills; skills should point here and retain only reusable tool-specific pitfalls.

## Safe local test loop

The ordinary test path must use only the mock Vikunja fixture. Do not run the Express proxy (`mise run dev`) for feature testing: it forwards to the configured Vikunja instance and may mutate real tasks.

```sh
npm ci
npx playwright install chromium   # one-time per machine
npm test                           # deterministic logic/regression tests
npm run test:e2e                   # Chromium against mock fixture + Vite
npm run build
npm run lint
```

`npm run test:e2e` starts the in-memory mock API on port 3001 and Vite on port 5173; Vite proxies `/api` and `/config.js` to the fixture. The test fixture resets between cases. It uses no API key and must never call the live Vikunja service. The mock records writes and exposes `/api/v1/test-state` for server-authoritative assertions. If a port is occupied, identify the owner and use an explicit alternate port/proxy target rather than killing an unknown process.

Use `npm run dev` only for frontend-only work where API access is not needed. Use `mise run dev` only when deliberately testing the Express proxy against a safe, controlled API endpoint; it is not part of the normal regression loop.

## Browser-interaction regression requirements

For drag, touch, swipe, menu, or other browser behavior:

1. Reproduce the current baseline before changing code. Record browser/device, input modality, actual gesture-start target, movement path, visible result, console errors, and API requests.
2. Automate the interaction in Playwright whenever feasible. Use real mouse input (`page.mouse`) or Chromium CDP touch input (`Input.dispatchTouchEvent`) on the actual control; do not simulate React handlers or call dnd-kit internals.
3. For drag-and-drop, assert all three layers: activation on the handle, correct target/collision through movement, and persisted server state plus rendered state after reload. Cover one-slot and multi-slot sibling moves, root-to-subtask and child-to-parent transitions, and relevant rejected/cancelled drops.
4. Test competing gestures explicitly: dragging from the handle must not swipe/complete or trigger pull-to-refresh; ordinary swipe and pull-to-refresh from non-handle content must still work. Clear request logs after initial page loading so mount-time fetches are not confused with gesture side effects.
5. Save traces/screenshots on failures. A selector check, build, healthy container, or visual animation alone does not prove persistence. For flicker, capture element bounds/transforms at several points along the real pointer path and verify the released item matches the visible/persisted slot.
6. If a browser-only behavior cannot be automated, record exact manual steps and observable evidence. Do not push or deploy an unverified change because a test is difficult; report the blocker and ask for the missing input.

## Checks and CI

- `npm test` runs Node's built-in test runner for deterministic logic and API mutation plans.
- `npm run test:e2e` runs Chromium interaction tests against the fixture.
- `npm run build` runs TypeScript project checks, including tests, and the Vite production build.
- `npm run lint` checks application, server, test, and build-config paths (not local worktrees or generated output).
- CI must run unit tests, browser tests, lint, and build before publishing a Docker image. CI success does not replace local reproduction and verification.

Add a focused regression test for each fixed defect. Prefer extracting deterministic ordering/tree/API planning logic from React rendering; keep true pointer/touch semantics in browser tests. Keep fixture behavior representative of Vikunja requests and verify request payloads and relation/order state, not just optimistic UI state.

## Scope and safety

- Never use live Vikunja data for routine tests. For any intentional live mutation, obtain explicit confirmation and use a designated safe task/account.
- Never put API keys in browser code, source control, logs, screenshots, or test output. The Express proxy keeps credentials server-side.
- Read the relevant component, hook, API path, and recent diff before changing behavior. State one evidence-based root-cause hypothesis; test it with the smallest change.
- Keep unrelated cleanup/refactors separate from a bug fix. Do not stage `.worktrees/`; stage explicit paths.

## Deployment gate

Deploy only when explicitly requested and after the exact pushed commit's CI passes. Production is managed by the parent Compose project `/srv/docker/docker-compose.yml` (includes `./honeydo-ui/docker-compose.yml`); run Compose from `/srv/docker`, never from the leaf stack. After deployment, verify the running revision and image digest, the health endpoint on `127.0.0.1:3000`, and a distinctive string/hash in the served bundle. A healthy container alone is insufficient evidence.
