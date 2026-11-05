import { defineConfig, devices } from '@playwright/test'

const production = process.env.HONEYDO_E2E_PRODUCTION === '1'
const appPort = production ? 3002 : 5173
const baseURL = `http://127.0.0.1:${appPort}`
const appServer = production
  ? 'node dist-server/server/proxy.js'
  : 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node tests/fixtures/mock-vikunja.mjs',
      url: 'http://127.0.0.1:3001/api/v1/test-state',
      env: { PORT: '3001' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: appServer,
      url: baseURL,
      env: production
        ? {
            PORT: String(appPort),
            VIKUNJA_API_KEY: 'fixture-only-test-key',
            VIKUNJA_BASE_URL: 'http://127.0.0.1:3001',
          }
        : { HONEYDO_API_PROXY_TARGET: 'http://127.0.0.1:3001' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
