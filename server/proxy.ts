import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = Number(process.env.PORT) || 3000
const VIKUNJA_BASE_URL = process.env.VIKUNJA_BASE_URL || 'https://vikunja.jacobsteward.me'
const HONEYDO_LABEL = process.env.HONEYDO_LABEL || 'Honey-Do'
const DEFAULT_PROJECT_ID = Number(process.env.DEFAULT_PROJECT_ID) || 1
let VIKUNJA_API_KEY = process.env.VIKUNJA_API_KEY || ''

// Try reading from file if env is empty (docker secrets pattern)
if (!VIKUNJA_API_KEY) {
  try {
    VIKUNJA_API_KEY = fs.readFileSync('/run/secrets/vikunja_api_key', 'utf8').trim()
  } catch {
    // ignore
  }
}

if (!VIKUNJA_API_KEY) {
  console.error('VIKUNJA_API_KEY environment variable is required')
  process.exit(1)
}

// Runtime config for the frontend
app.get('/config.js', (_req, res) => {
  res.type('application/javascript')
  res.send(`window.__HONEYDO_CONFIG__={VikunjaBaseUrl:${JSON.stringify(VIKUNJA_BASE_URL)},HoneyDoLabel:${JSON.stringify(HONEYDO_LABEL)},DefaultProjectId:${DEFAULT_PROJECT_ID}};`)
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API proxy - forward to Vikunja with auth header
app.use(
  '/api/v1',
  createProxyMiddleware({
    target: VIKUNJA_BASE_URL,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, _req) => {
        proxyReq.setHeader('Authorization', `Bearer ${VIKUNJA_API_KEY}`)
      },
    },
  })
)

// Serve static files
const distPath = path.resolve(__dirname, '../dist')
app.use(express.static(distPath))

// SPA fallback
app.use((_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HoneyDo UI server running on http://0.0.0.0:${PORT}`)
  console.log(`Proxying API to ${VIKUNJA_BASE_URL}`)
})
