import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, name, track_count FROM genres ORDER BY track_count DESC, name ASC`
    );
    res.json({ genres: rows });
  } catch (err) { next(err); }
});

export default router;
