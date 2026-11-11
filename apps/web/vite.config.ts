import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const SERVER_URL = process.env.MUSIC_SERVER_URL ?? 'http://localhost:3001'

const APP_NAME = 'Music'
const THEME_COLOR = '#0a0a0a'

const YOUTUBE_IMAGE_HOSTS =
  /^https:\/\/(lh3|yt3)\.googleusercontent\.com\/|^https:\/\/i\.ytimg\.com\//

const IMAGE_CACHE_MAX_ENTRIES = 500
const IMAGE_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export default defineConfig({
  plugins: [
    tailwindcss(),
    foldkit(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description:
          'Search YouTube Music and read about songs, artists, and albums.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: THEME_COLOR,
        theme_color: THEME_COLOR,
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/rpc/, /^\/audio\//, /^\/session/],
        runtimeCaching: [
          {
            urlPattern: YOUTUBE_IMAGE_HOSTS,
            handler: 'CacheFirst',
            options: {
              cacheName: 'artwork',
              expiration: {
                maxEntries: IMAGE_CACHE_MAX_ENTRIES,
                maxAgeSeconds: IMAGE_CACHE_MAX_AGE_SECONDS,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
  server: {
    host: true,
    proxy: {
      '/rpc': { target: SERVER_URL, changeOrigin: true },
      '/audio': { target: SERVER_URL, changeOrigin: true },
      '/session': { target: SERVER_URL, changeOrigin: true, ws: true },
    },
  },
  preview: {
    host: true,
    proxy: {
      '/rpc': { target: SERVER_URL, changeOrigin: true },
      '/audio': { target: SERVER_URL, changeOrigin: true },
      '/session': { target: SERVER_URL, changeOrigin: true, ws: true },
    },
  },
})
