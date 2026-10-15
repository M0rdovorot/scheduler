import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// An isolated stack: its own database, backend and Vite server, on ports that
// do not collide with `make dev` (8081 / 5173).
const apiPort = 8082
const webPort = 5174
const database = 'scheduler_e2e'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  // One user ("dev") is shared by all tests, so they run one after another.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    timezoneId: 'Europe/Moscow',
    locale: 'ru-RU',
    viewport: { width: 390, height: 800 },
    trace: 'retain-on-failure',
    // Some servers lack Chromium's shared libraries and offer no root to install them.
    // They can be unpacked from the distribution's .deb files into this directory.
    launchOptions: {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [
          join(homedir(), '.local/share/chromium-libs/usr/lib/x86_64-linux-gnu'),
          process.env.LD_LIBRARY_PATH,
        ]
          .filter(Boolean)
          .join(':'),
      },
    },
  },
  webServer: [
    {
      command: './e2e/start-backend.sh',
      url: `http://127.0.0.1:${apiPort}/api/v1/healthz`,
      env: {
        APP_ENV: 'dev',
        DEV_AUTH: 'true',
        HTTP_ADDR: `127.0.0.1:${apiPort}`,
        DATABASE_URL: `postgres://scheduler:scheduler@127.0.0.1:5433/${database}?sslmode=disable`,
      },
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --port ${webPort} --host 127.0.0.1 --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false,
    },
  ],
})
