import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The web-app manifest and offline service worker (spec Prompt 10, item 3).
    // The manifest lives here rather than a static public/manifest.json so the
    // icon list, theme colours and generated service worker stay in one source
    // of truth — the plugin emits manifest.webmanifest and injects its <link>.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-icon.svg'],
      manifest: {
        name: 'AI Study Tutor',
        short_name: 'Study Tutor',
        description:
          'Turn your course material into interactive AI lectures, flashcards, quizzes and timed practice exams.',
        theme_color: '#6C63FF',
        background_color: '#0F0F0F',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'pwa-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // App shell / static assets — serve instantly, refresh in the
            // background.
            urlPattern: ({ request }) =>
              ['style', 'script', 'font', 'image'].includes(request.destination),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'assets' },
          },
        ],
      },
      devOptions: {
        // Keep the SW off in `vite dev` so hot reload isn't fighting a cache.
        enabled: false,
      },
    }),
  ],
})
