import express from 'express'
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

const upstreamBase = VIKUNJA_BASE_URL.replace(/\/$/, '')

// Runtime config for the frontend
app.get('/config.js', (_req, res) => {
  res.type('application/javascript')
  res.send(
    `window.__HONEYDO_CONFIG__={` +
    `VikunjaBaseUrl:${JSON.stringify(VIKUNJA_BASE_URL)},` +
    `HoneyDoLabel:${JSON.stringify(HONEYDO_LABEL)},` +
    `DefaultProjectId:${DEFAULT_PROJECT_ID}};`
  )
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API proxy - forward all /api/v1/* to Vikunja with auth header
app.use('/api/v1', async (req, res) => {
  const upstreamUrl = `${upstreamBase}/api/v1${req.url}`

  const headers = new Headers()
  // Copy safe headers from client
  const copyHeaders = ['content-type', 'accept', 'accept-encoding']
  for (const h of copyHeaders) {
    const val = req.headers[h]
    if (val) headers.set(h, Array.isArray(val) ? val[0] : val)
  }
  headers.set('Authorization', `Bearer ${VIKUNJA_API_KEY}`)

  try {
    const body = req.method !== 'GET' && req.method !== 'HEAD'
      ? await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => resolve(Buffer.concat(chunks)))
          req.on('error', reject)
        })
      : undefined

    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      // @ts-ignore — duplex is required for Node fetch with body streams
      duplex: 'half',
    })

    res.status(upstreamRes.status)
    upstreamRes.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value)
      }
    })

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (err) {
    console.error('Proxy error:', err)
    res.status(502).json({ error: 'Proxy error', message: String(err) })
  }
})

// Serve static files
const distPath = path.resolve(__dirname, '../../dist')
app.use(express.static(distPath))

// SPA fallback
app.use((_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HoneyDo UI server running on http://0.0.0.0:${PORT}`)
  console.log(`Proxying API to ${VIKUNJA_BASE_URL}`)
})
