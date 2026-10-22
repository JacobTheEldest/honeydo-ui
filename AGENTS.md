# Agent workflow

For every feature, bug fix, or browser-interaction change, reproduce and verify locally before asking the user to deploy or test it. Treat the steps below as required; report concrete behavior and observations, not just that a build passed.

## Reproduce before changing code

1. Record exact reproduction steps, browser/device, and input modality (mouse, keyboard, or touch), plus expected and actual behavior.
2. Reproduce on the current baseline first. Note observable signals: DOM/UI state, relevant network/API calls and their count/status, and console errors. If it does not reproduce, record that rather than guessing.
3. Inspect the relevant component, hook, API/proxy path, and recent changes. State one root-cause hypothesis and the evidence for it before patching; revise it if experiments disprove it.

## Local verification loop (before deployment)

1. Install dependencies and runtime: `mise install` and `npm ci`. Start the frontend **and** Express proxy with `mise run dev`. This serves Vite at `http://localhost:5173` and the proxy at port 3000; `npm run dev` alone starts only Vite, so `/api` and `/config.js` will not be proxied to Express.
2. Open the local Vite URL in real Chromium using Browser Use or available browser automation. Inspect the rendered DOM, network/API requests, and console; exercise the changed behavior and a relevant unaffected control path.
3. For pointer/touch/gesture behavior, use CDP touch emulation where needed. Exercise the actual originating target (including nested icons/handles), relevant movement thresholds, gesture release/cancel, and nearby controls. Assert side effects as well as UI state: for example, wrap `window.fetch` to count and inspect API calls, and verify both the intended action and a negative/control gesture. Do not infer the originating target from a gesture library's bound element without checking the real event target/composed path.
4. When production bundling, runtime configuration, or serving differs materially from development, test the built app locally too: run `mise run build`, then `mise run start` (production server on port 3000; requires a configured proxy key), or use an appropriate local production server. `npm run preview` serves Vite's built frontend but does not reproduce the Express proxy by itself. Do not deploy to establish that a basic fix works.
5. Never mutate live Vikunja data for routine verification. Prefer mocks/stubs or a safe test account/task, and confirm before any operation that could alter real data. Never place API keys or other secrets in browser code, source control, logs, screenshots, or test output. Keep credentials server-side and redact any incidental output.

## Regression protection and checks

- Add a focused automated regression test when feasible. There is currently no test runner or `test` script; choose the smallest suitable option and justify adding a larger framework. Do not claim `npm test` works unless a test script has actually been added.
- If automation is impractical for a browser-only behavior, record reproducible browser steps and the captured observations (for example, gesture target and API-call count). Verify the pre-fix failure when possible, then the post-fix success.
- Run the targeted test, if one exists, plus `npm run build` and `npm run lint`. Fix failures caused by the change; report any unrelated baseline failure explicitly.

## Mandatory pre-push gate

Before pushing any code change:

- The relevant local regression test must pass, or the changed browser behavior must be reproduced and verified locally using the workflow above. A build alone is not a substitute.
- `npm run build` and `npm run lint` must pass. If either has an unrelated baseline failure, document the exact failure and why it is unrelated; fix failures caused by the change.
- If local verification is truly blocked, state the exact blocker and obtain explicit user approval before pushing unverified code. Never describe unverified code as verified.

Keep these stages distinct: local regression/build/lint checks happen before the push; CI is checked after the push and does not replace local verification; deployment happens only after CI passes and only when requested or required by the task. A documentation-only change does not require deployment.

Existing project commands:

```sh
mise run dev       # Vite + Express proxy
npm run build      # TypeScript check + Vite production bundle
npm run lint       # oxlint
```

## CI, deployment, and reporting

- Do not ask the user to deploy or spend time testing a fix until local behavior has been verified and CI has passed. If local verification is blocked by missing credentials, network access, or browser tooling, state the exact blocker and do not claim the fix works; ask only for the input needed to unblock it.
- Deploy only when deployment is part of the task and after CI is green. Production is managed by the parent Compose project `/srv/docker/docker-compose.yml`, which includes `./honeydo-ui/docker-compose.yml`; run Compose from `/srv/docker`, not from the leaf stack. Verify the running revision/image digest and that the served JavaScript asset contains the change. A healthy container alone is not proof, and deployment never substitutes for local regression testing.
- Report the actual checks and interaction exercised, with observable results (such as expected UI state and request count/status), plus build/lint/CI outcomes. Do not report intent as evidence.
