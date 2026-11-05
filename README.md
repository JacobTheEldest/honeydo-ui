# HoneyDo UI

A mobile-first React web app for organizing selected Vikunja tasks in a simple Honey-Do list. It keeps the Vikunja API key on the server and stores list ordering in task due dates; it does not use Vikunja's priority field for ordering.

## Features

- Reorder tasks with drag and drop; move tasks into or out of subtasks.
- Inline title editing, completion, and optional completed-task display.
- Create root tasks or subtasks with a persistent inline composer.
- Show subtasks in a nested tree, including descendants without their own Honey-Do label.
- Remove a Honey-Do label and its ordering metadata for one task or a subtree.
- Open a task in Vikunja for details; dark mode and mobile gestures.

## Stack

- React 19, TypeScript, and Vite
- Tailwind CSS 4
- `@dnd-kit` for drag-and-drop; `@use-gesture/react` for swipe and pull-to-refresh
- Express proxy for keeping the Vikunja API key server-side
- Docker image published to GHCR by GitHub Actions

## Development

Node.js is managed with mise. Install dependencies with `npm ci` after `mise install`.

### Safe tests (mock API only)

```sh
npm test
npx playwright install chromium  # once per machine
npm run test:e2e
npm run build
npm run lint
npm run build:server
npm run test:e2e:prod
```

`npm run test:e2e` starts the mock Vikunja API and Vite automatically. It runs real Chromium mouse and touch input against fixture data, resets the fixture between cases, and makes no live Vikunja requests or writes. `npm run build:server && npm run test:e2e:prod` runs the same browser scenarios against the production bundle and Express proxy, still pointed only at the fixture. Drag regressions assert handle activation, overlay stability through the pointer path, absence of swipe/pull-refresh side effects, API relationship/order writes, and the rendered tree/order after reload. To inspect failures, run `npx playwright test --debug` or open a trace saved under `test-results/` with `npx playwright show-trace <trace.zip>`.

### Run the app

`mise run dev` starts Vite and the Express proxy. The proxy forwards API requests to the configured Vikunja instance and requires `VIKUNJA_API_KEY`; use it only when intentionally testing with an approved safe account/task. Routine feature tests should use the mock-only browser suite above.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `VIKUNJA_API_KEY` | — | Required by the Express proxy; remains server-side. |
| `VIKUNJA_BASE_URL` | `https://vikunja.jacobsteward.me` | Vikunja instance URL. |
| `HONEYDO_LABEL` | `Honey-Do` | Label that identifies tasks for the view. |
| `DEFAULT_PROJECT_ID` | `1` | Project used for new root tasks. |
| `PORT` | `3000` | Express proxy port. |

See `.env.example` for the complete example configuration.

## Production

```sh
npm run build
mise run start
```

Docker Compose and deployment are managed by the parent Compose project on docker-host. See `AGENTS.md` for deployment verification requirements.

## Ordering model

Sibling order is persisted through each task's `due_date`, not Vikunja's priority field. The application assigns dates around a fixed base and uses midpoint or sequential positions for insertions; it rebalances when spacing becomes too small. The UI renders each sibling group by persisted due-date order.

## License

MIT
