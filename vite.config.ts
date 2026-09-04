import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  // Served from rupel.xyz/songmap/ rather than its own subdomain, so every emitted asset
  // URL has to carry the prefix. Vite rewrites the entry script and the asset links in
  // index.html from this; anything hardcoded absolute (the og:image below) does not go
  // through Vite and has to spell the prefix out.
  base: '/songmap/',
  // `base` only rewrites the URLs Vite emits — it does NOT move the files. The Cloudflare
  // route resolves /songmap/assets/x.js against the assets directory as dist/songmap/…, so
  // the build has to physically nest too or every asset 404s. (SvelteKit's adapter does this
  // nesting for you; Vite does not.) wrangler still points at ./dist.
  build: { outDir: 'dist/songmap' },
  plugins: [svelte()],
})
