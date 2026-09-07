import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import type { Plugin } from 'vite'

// The only change to the stock app: an observer. It does not invalidate
// anything, it just records that Vite ran a plugin's hotUpdate hook.
function countsHotUpdates(): Plugin {
  let n = 0
  return {
    name: 'counts-hot-updates',
    hotUpdate: {
      handler() {
        n++
        console.log(`[counts-hot-updates] hotUpdate #${n} in env "${this.environment.name}"`)
      },
    },
  }
}

// Same switch as repro/minimal, so both exhibits can be run against either
// watcher backend. Vite: "When set to false on OS X, usePolling: true becomes
// the default."
const watch = process.env.REPRO_WATCHER === 'poll' ? { useFsEvents: false } : undefined

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: { watch },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    countsHotUpdates(),
  ],
})

export default config
