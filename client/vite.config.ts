import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind to 0.0.0.0 so phones on the LAN can connect
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
