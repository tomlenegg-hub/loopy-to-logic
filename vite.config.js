import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
