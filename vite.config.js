import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

const sha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; } })();
const stamp = `v1.1 – ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC – ${sha}`;

export default defineConfig({
  define: { __BUILD__: JSON.stringify(stamp) },
  base: './', // works on GitHub Pages under any repository name
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'icon-192.png'],
      workbox: { globPatterns: ['**/*.{js,css,html,wasm,png,json}'], maximumFileSizeToCacheInBytes: 8 * 1024 * 1024 },
      manifest: {
        name: 'Loopy to Logic', short_name: 'Loopy to Logic',
        description: 'Migrate a Loopy Pro project to Logic Pro for iPad. Runs entirely on your device.',
        lang: 'en-GB', start_url: './', scope: './', display: 'standalone',
        background_color: '#12343b', theme_color: '#12343b',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  test: { include: ['test/**/*.test.js'], exclude: ['fixtures/**', 'node_modules/**'] },
});
