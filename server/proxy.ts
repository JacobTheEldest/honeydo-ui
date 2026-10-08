import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = Number(process.env.PORT) || 3000
const VIKUNJA_BASE_URL = process.env.VIKUNJA_BASE_URL || 'https://vikunja.jacobsteward.me'
const VIKUNJA_API_KEY = process.env.VIKUNJA_API_KEY

if (!VIKUNJA_API_KEY) {
  console.error('VIKUNJA_API_KEY environment variable is required')
  process.exit(1)
}

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
    pathRewrite: { '^/api/v1': '/api/v1' },
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('Authorization', `Bearer ${VIKUNJA_API_KEY}`)
      },
    },
  })
)

// Serve static files
const distPath = path.resolve(__dirname, '../dist')
app.use(express.static(distPath))

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HoneyDo UI server running on http://0.0.0.0:${PORT}`)
  console.log(`Proxying API to ${VIKUNJA_BASE_URL}`)
})
