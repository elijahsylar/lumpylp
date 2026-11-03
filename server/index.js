import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env BEFORE importing modules that read process.env at module load
// (middleware/auth.js reads JWT_SECRET on import). In production the systemd
// unit's EnvironmentFile provides everything and db.js reads .env.production;
// a stray developer .env must never be picked up there (review R12).
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}

const { createApp } = await import('./app.js');
const app = await createApp();

const PORT = process.env.PORT || 3001;
// Loopback by default: nginx is the only thing that should reach the API.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[api] LumpyLP server listening on ${HOST}:${PORT}`);
});
