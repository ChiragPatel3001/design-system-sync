import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dashboardApiPlugin } from './design-system/sync/scripts/dashboard-server-plugin.ts';

export default defineConfig({
  plugins: [react(), dashboardApiPlugin()],
  build: {
    // Stage 6F: the dashboard is a second, independent HTML entry
    // (dashboard.html / src/dashboard/main.tsx) alongside the existing
    // component-gallery entry (index.html / src/main.tsx) — neither
    // replaces the other.
    rollupOptions: {
      input: {
        main: 'index.html',
        dashboard: 'dashboard.html',
      },
    },
  },
});
