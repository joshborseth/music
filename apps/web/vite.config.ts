import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const SERVER_URL = process.env.MUSIC_SERVER_URL ?? 'http://localhost:3001'

const APP_NAME = 'Joshify'
const THEME_COLOR = '#0b0c0e'

const YOUTUBE_IMAGE_HOSTS =
  /^https:\/\/(lh3|yt3)\.googleusercontent\.com\/|^https:\/\/i\.ytimg\.com\//

const IMAGE_CACHE_MAX_ENTRIES = 500
const IMAGE_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * Covers asked for at 1080 pixels (the full player and the heroes of album,
 * playlist, and artist pages) are about ten times the bytes of a list's, so
 * they get their own, smaller cache.
 */
const LARGE_IMAGE =
  /^https:\/\/(lh3|yt3)\.googleusercontent\.com\/.*=w1080-h1080/
const LARGE_IMAGE_CACHE_MAX_ENTRIES = 60

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
        description: 'Browse YouTube Music and play it on your phone or TV.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        categories: ['music', 'entertainment'],
        shortcuts: [
          { name: 'Search', url: '/search' },
          { name: 'Library', url: '/library' },
        ],
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
            urlPattern: LARGE_IMAGE,
            handler: 'CacheFirst',
            options: {
              cacheName: 'artwork-large',
              expiration: {
                maxEntries: LARGE_IMAGE_CACHE_MAX_ENTRIES,
                maxAgeSeconds: IMAGE_CACHE_MAX_AGE_SECONDS,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
