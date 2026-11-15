import express from 'express'

const app = express()
app.use(express.json())
const HONEY_DO = { id: 1, title: 'Honey-Do' }
const date = (position) => new Date(Date.UTC(2100, 0, 1, 0, position)).toISOString()
const tasks = new Map()
const trashed = new Map()
const parents = new Map([[11, 1], [12, 1], [21, 2], [31, 30]])
const requests = []
let nextCreatedId = 100

function addTask(id, title, project_id, position, labels = []) {
  tasks.set(id, {
    id,
    title,
    description: `fixture description ${id}`,
    done: false,
    done_at: null,
    due_date: date(position),
    project_id,
    labels: labels.map((label) => ({ ...label })),
    created: date(0),
    updated: date(0),
    priority: id * 10,
  })
}

function resetFixture() {
  tasks.clear()
  trashed.clear()
  parents.clear()
  requests.length = 0
  parents.set(11, 1)
  parents.set(12, 1)
  parents.set(21, 2)
  parents.set(31, 30)
  addTask(1, 'Root A', 1, 10, [HONEY_DO])
  addTask(2, 'Root B', 1, 20, [HONEY_DO])
  addTask(5, 'Root C', 1, 30, [HONEY_DO])
  addTask(11, 'Promotable child', 1, 40)
  addTask(12, 'Unlabeled-parent child', 1, 50)
  addTask(21, 'B descendant', 2, 60)
  addTask(30, 'Hidden unlabeled parent', 2, 70)
  addTask(31, 'Context child', 2, 80, [HONEY_DO])
  nextCreatedId = 100
}

resetFixture()

function detail(task) {
  const children = [...parents.entries()]
    .filter(([, parentId]) => parentId === task.id)
    .map(([childId]) => tasks.get(childId))
    .filter(Boolean)
    .map(({ id, title }) => ({ id, title }))
  const parentId = parents.get(task.id)
  const parent = parentId === undefined ? undefined : tasks.get(parentId)
  return {
    ...task,
    related_tasks: {
      ...(children.length ? { subtask: children } : {}),
      ...(parent ? { parenttask: [{ id: parent.id, title: parent.title }] } : {}),
    },
  }
}

// v2 list responses are {items, total, page, per_page, total_pages} envelopes.
const envelope = (items) => ({
  items,
  total: items.length,
  page: 1,
  per_page: items.length || 50,
  total_pages: 1,
})

// v2 errors are RFC 9457 problem+json documents.
const PROBLEM_TITLES = { 404: 'Not Found', 422: 'Unprocessable Entity', 500: 'Internal Server Error' }
const problem = (status, detail, extra = {}) => ({
  title: PROBLEM_TITLES[status] ?? 'Error',
  status,
  detail,
  ...extra,
})

app.get('/config.js', (_req, res) => {
  res.type('application/javascript').send('window.__HONEYDO_CONFIG__ = { VikunjaBaseUrl: "http://localhost:3000", HoneyDoLabel: "Honey-Do", DefaultProjectId: 1 };')
})
// ---------------------------------------------------------------------------
// Vikunja API v2 surface (the maintained API; v1 is frozen). v2 semantics:
// POST create -> 201, PUT full update, DELETE -> 204 empty body, list reads
// return {items, ...} envelopes, errors are problem+json. Same task/parents/
// trashed state handling as the live 2.8.0 instance: soft delete into the
// trash destroys nothing (relation rows survive both directions), restore
// re-exposes them.
// ---------------------------------------------------------------------------
app.get('/api/v2/labels', (_req, res) => res.json(envelope([HONEY_DO])))
app.get('/api/v2/projects', (_req, res) =>
  res.json(envelope([{ id: 1, title: 'Fixture project' }, { id: 2, title: 'Cross-project fixture' }]))
)
app.get('/api/v2/projects/:id/tasks', (req, res) => {
  const projectId = Number(req.params.id)
  res.json(envelope([...tasks.values()].filter((task) => task.project_id === projectId)))
})
app.get('/api/v2/tasks/deleted', (_req, res) => res.json(envelope([...trashed.values()])))
app.get('/api/v2/tasks/:id', (req, res) => {
  const id = Number(req.params.id)
  const task = tasks.get(id)
  if (!task) {
    // Vikunja 2.8.0: reading a trashed task returns 404 problem+json with
    // code 4040 and trash metadata (verified against a live instance).
    const trashedTask = trashed.get(id)
    if (trashedTask) {
      return res.status(404).json(problem(404, 'This task is in the trash.', {
        code: 4040,
        details: {
          id,
          project_id: trashedTask.project_id,
          deleted_at: trashedTask.deleted_at,
          deleted_by: { id: 1, name: '', username: 'fixture', created: date(0), updated: date(0) },
          can_restore: true,
        },
      }))
    }
    return res.status(404).json(problem(404, 'not found'))
  }
  res.json(detail(task))
})
// New-task composer support: task creation at a project, plus a deterministic
// failure trigger ("force-error" title) for exercising the composer's error path.
app.post('/api/v2/projects/:id/tasks', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  if (req.body?.title === 'force-error') {
    return res.status(500).json(problem(500, 'forced fixture failure'))
  }
  const id = nextCreatedId++
  const task = {
    id,
    title: req.body?.title ?? '',
    description: '',
    done: false,
    done_at: null,
    due_date: req.body?.due_date ?? null,
    project_id: Number(req.params.id),
    labels: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    priority: 0,
  }
  tasks.set(id, task)
  res.status(201).json(task)
})
app.put('/api/v2/tasks/:id', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  const id = Number(req.params.id)
  const task = tasks.get(id)
  if (!task) return res.status(404).json(problem(404, 'not found'))
  tasks.set(id, { ...task, ...req.body, labels: task.labels, updated: new Date().toISOString() })
  res.json(tasks.get(id))
})
app.delete('/api/v2/tasks/:id', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const id = Number(req.params.id)
  const task = tasks.get(id)
  if (!task) return res.status(404).json(problem(404, 'not found'))
  tasks.delete(id)
  trashed.set(id, { ...task, deleted_at: new Date().toISOString() })
  res.status(204).end()
})
app.post('/api/v2/tasks/:id/relations', (req, res) => {
  const { task_id: parentId, other_task_id: childId, relation_kind: kind } = req.body
  if (kind !== 'subtask' || parentId === childId) {
    return res.status(422).json(problem(422, 'invalid relation'))
  }
  requests.push({ method: req.method, path: req.path, body: req.body })
  parents.set(Number(childId), Number(parentId))
  res.status(201).json({})
})
app.delete('/api/v2/tasks/:parentId/relations/subtask/:childId', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const parentId = Number(req.params.parentId)
  const childId = Number(req.params.childId)
  if (parents.get(childId) !== parentId) return res.status(404).json(problem(404, 'relation not found'))
  parents.delete(childId)
  res.status(204).end()
})
app.post('/api/v2/tasks/:id/labels', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  const task = tasks.get(Number(req.params.id))
  if (!task) return res.status(404).json(problem(404, 'not found'))
  if (!task.labels.some((label) => label.id === Number(req.body.label_id))) task.labels.push(HONEY_DO)
  res.status(201).json({ label_id: req.body.label_id })
})
app.delete('/api/v2/tasks/:id/labels/:labelId', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const task = tasks.get(Number(req.params.id))
  if (!task) return res.status(404).json(problem(404, 'not found'))
  task.labels = task.labels.filter((label) => label.id !== Number(req.params.labelId))
  res.status(204).end()
})
app.post('/api/v2/labels', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  res.status(201).json({ id: 2, title: req.body?.title ?? '' })
})
app.post('/api/v2/tasks/:id/restore', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const id = Number(req.params.id)
  const task = trashed.get(id)
  if (!task) return res.status(404).json(problem(404, 'not found'))
  trashed.delete(id)
  const { deleted_at: _deletedAt, ...restored } = task
  tasks.set(id, restored)
  res.json(detail(restored))
})
app.delete('/api/v2/tasks/:id/permanent', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const id = Number(req.params.id)
  if (!trashed.has(id)) return res.status(404).json(problem(404, 'not found'))
  trashed.delete(id)
  res.status(204).end()
})
app.post('/api/v2/test-reset', (_req, res) => {
  resetFixture()
  res.status(204).end()
})
app.post('/api/v2/test-seed-long-list', (_req, res) => {
  for (let index = 0; index < 20; index++) {
    addTask(3000 + index, `Long-list root ${index + 1}`, 1, 100 + index, [HONEY_DO])
  }
  res.status(201).json({ count: 20 })
})
app.get('/api/v2/test-state', (_req, res) => {
  res.json({
    parents: Object.fromEntries(parents),
    tasks: [...tasks.values()],
    trashed: [...trashed.values()].map(({ id, title }) => ({ id, title })),
    requests,
  })
})

const port = Number(process.env.PORT ?? 3000)
app.listen(port, '0.0.0.0', () => console.log(`Fixture Vikunja API listening on ${port}`))
