const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT) || 8791;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  webServer: {
    command: 'node tests/serve.js',
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) }
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // the service worker would serve a cached shell and hide the code under test
    serviceWorkers: 'block',
    permissions: ['geolocation'],
    geolocation: { latitude: -29.5198, longitude: 27.4228 },   // Rothe resource centre
    trace: 'retain-on-failure'
  },
  // Field Supervisors are on Android phones — test the shape they actually use
  projects: [{ name: 'android-chrome', use: { ...devices['Pixel 7'] } }]
});
