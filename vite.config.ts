import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  // Served from rupel.xyz/songmap/ rather than its own subdomain, so every emitted asset
  // URL has to carry the prefix. Vite rewrites the entry script and the asset links in
  // index.html from this; anything hardcoded absolute (the og:image below) does not go
  // through Vite and has to spell the prefix out.
  base: '/songmap/',
  plugins: [svelte()],
})
