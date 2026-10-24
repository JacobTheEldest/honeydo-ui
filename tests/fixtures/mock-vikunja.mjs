import express from 'express'

const app = express()
app.use(express.json())
const HONEY_DO = { id: 1, title: 'Honey-Do' }
const date = (position) => new Date(Date.UTC(2000, 0, 1, 0, position)).toISOString()
const tasks = new Map()
const parents = new Map([[11, 1], [12, 1], [21, 2], [31, 30]])
const requests = []

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

addTask(1, 'Root A', 1, 10, [HONEY_DO])
addTask(2, 'Root B', 1, 20, [HONEY_DO])
addTask(5, 'Root C', 1, 30, [HONEY_DO])
addTask(11, 'Promotable child', 1, 40)
addTask(12, 'Unlabeled-parent child', 1, 50)
addTask(21, 'B descendant', 2, 60)
addTask(30, 'Hidden unlabeled parent', 2, 70)
addTask(31, 'Context child', 2, 80, [HONEY_DO])

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

app.get('/config.js', (_req, res) => {
  res.type('application/javascript').send('window.__HONEYDO_CONFIG__ = { VikunjaBaseUrl: "http://localhost:3000", HoneyDoLabel: "Honey-Do", DefaultProjectId: 1 };')
})
app.get('/api/v1/labels', (_req, res) => res.json([HONEY_DO]))
app.get('/api/v1/projects', (_req, res) => res.json([{ id: 1, title: 'Fixture project' }, { id: 2, title: 'Cross-project fixture' }]))
app.get('/api/v1/projects/:id/tasks', (req, res) => {
  const projectId = Number(req.params.id)
  res.json([...tasks.values()].filter((task) => task.project_id === projectId))
})
app.get('/api/v1/tasks/:id', (req, res) => {
  const task = tasks.get(Number(req.params.id))
  if (!task) return res.status(404).json({ message: 'not found' })
  res.json(detail(task))
})
app.put('/api/v1/tasks/:id/relations', (req, res) => {
  const { task_id: parentId, other_task_id: childId, relation_kind: kind } = req.body
  if (kind !== 'subtask' || parentId === childId) return res.status(400).json({ message: 'invalid relation' })
  requests.push({ method: req.method, path: req.path, body: req.body })
  parents.set(Number(childId), Number(parentId))
  res.status(200).json({})
})
app.delete('/api/v1/tasks/:parentId/relations/subtask/:childId', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const parentId = Number(req.params.parentId)
  const childId = Number(req.params.childId)
  if (parents.get(childId) !== parentId) return res.status(404).json({ message: 'relation not found' })
  parents.delete(childId)
  res.status(200).json({})
})
app.post('/api/v1/tasks/:id', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  const id = Number(req.params.id)
  const task = tasks.get(id)
  if (!task) return res.status(404).json({ message: 'not found' })
  tasks.set(id, { ...task, ...req.body, labels: task.labels, updated: new Date().toISOString() })
  res.json(tasks.get(id))
})
app.put('/api/v1/tasks/:id/labels', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  const task = tasks.get(Number(req.params.id))
  if (!task) return res.status(404).json({ message: 'not found' })
  if (!task.labels.some((label) => label.id === Number(req.body.label_id))) task.labels.push(HONEY_DO)
  res.status(200).json({})
})
app.delete('/api/v1/tasks/:id/labels/:labelId', (req, res) => {
  requests.push({ method: req.method, path: req.path })
  const task = tasks.get(Number(req.params.id))
  if (!task) return res.status(404).json({ message: 'not found' })
  task.labels = task.labels.filter((label) => label.id !== Number(req.params.labelId))
  res.status(200).json({})
})
// New-task composer support: task creation at a project, plus a deterministic
// failure trigger ("force-error" title) for exercising the composer's error path.
let nextCreatedId = 100
app.put('/api/v1/projects/:id/tasks', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body })
  if (req.body?.title === 'force-error') {
    return res.status(500).json({ message: 'forced fixture failure' })
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
  res.json(task)
})
app.get('/api/v1/test-state', (_req, res) => {
  res.json({
    parents: Object.fromEntries(parents),
    tasks: [...tasks.values()],
    requests,
  })
})

const port = Number(process.env.PORT ?? 3000)
app.listen(port, '0.0.0.0', () => console.log(`Fixture Vikunja API listening on ${port}`))
