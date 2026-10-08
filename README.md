# HoneyDo UI

A simple, mobile-first web UI for managing Honey-Do tasks in [Vikunja](https://vikunja.io). Built for my wife to easily prioritize tasks without navigating the full Vikunja interface.

## Features

- **Title-only task list** - Clean, distraction-free view
- **Drag-and-drop reordering** - Touch-friendly via `@dnd-kit`
- **Tap to edit** - Quick inline title editing
- **Swipe to complete** - Mobile gesture or click the check button
- **Show/hide completed** - Toggle to review or un-complete tasks
- **Create tasks** - FAB to add new tasks at the top of the list
- **Open in Vikunja** - Deep link to full task details

## Tech Stack

- React 18 + TypeScript + Vite
- Tailwind CSS
- `@dnd-kit` for drag-and-drop
- `@use-gesture/react` for swipe gestures
- Express proxy (keeps API key server-side)
- Docker + GitHub Actions + GHCR

## Development

Requires [mise](https://mise.jdx.dev/) for dependency management.

```bash
# Install dependencies
mise install
npm install

# Copy env and add your Vikunja API key
cp .env.example .env
# Edit .env with VIKUNJA_API_KEY=...

# Start dev server (frontend + proxy)
mise run dev
```

The dev setup runs:
- Vite dev server on `http://localhost:5173`
- Express proxy on `http://localhost:3000`

The Vite dev config proxies `/api` to the Express server, so the frontend calls work seamlessly.

## Production

```bash
# Build
mise run build

# Start production server
mise run start

# Or with Docker
docker compose up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIKUNJA_API_KEY` | - | **Required.** Bearer token for Vikunja API |
| `VIKUNJA_BASE_URL` | `https://vikunja.jacobsteward.me` | Vikunja instance URL |
| `PORT` | `3000` | Server port |

## Deployment

Images are built and pushed to GHCR via GitHub Actions on every push to `main`.

```bash
docker pull ghcr.io/jacobtheeldest/honeydo-ui:main
```

## Ordering Strategy

Tasks are ordered by `due_date` (since Vikunja has no custom sort field):
- Base date: `2000-01-01T00:00:00Z`
- Position N = base + N × 60 seconds
- New tasks get `base - 60s` (top of list)
- Reordering uses midpoint insertion
- Auto-rebalance when gaps get too small

## License

MIT
