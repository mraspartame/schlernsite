import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import UnoCSS from 'unocss/astro';
import react from '@astrojs/react';

export default defineConfig({
  site:
    process.env.CF_PAGES_URL
      ? process.env.CF_PAGES_URL
      : 'https://localhost:3000/',
  trailingSlash: 'ignore',
  integrations: [sitemap(), UnoCSS({ injectReset: true }), react()],
  vite: {
    optimizeDeps: {
      exclude: ['@resvg/resvg-js'],
    },
    ssr: {
      noExternal: ['peerjs'],
    },
  },
});
