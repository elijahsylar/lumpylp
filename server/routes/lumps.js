import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../db.js';
import { limiters } from '../lib/rateLimits.js';
import { TRACK_COLUMNS_SQL, serializeTrack } from '../lib/trackShape.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

const NAME_RE = z.string().trim().min(1).max(100);
const DESC_RE = z.string().trim().max(500).nullish();

const CreateSchema = z.object({
  name:        NAME_RE,
  description: DESC_RE,
  is_public:   z.boolean().optional(),
});

const PatchSchema = z.object({
  name:        NAME_RE.optional(),
  description: DESC_RE,
  is_public:   z.boolean().optional(),
});

const ReorderSchema = z.object({
  track_ids: z.array(z.number().int().positive()).max(2000),
});

function lumpRow(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    is_public: !!r.is_public,
    track_count: Number(r.track_count) || 0,
    owner_username: r.owner_username,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// GET /api/lumps  — current user's lumps
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT l.id, l.name, l.description, l.is_public, l.created_at, l.updated_at,
              COALESCE(c.cnt, 0) AS track_count
       FROM user_lumps l
       LEFT JOIN (
         SELECT lump_id, COUNT(*) AS cnt FROM lump_tracks GROUP BY lump_id
       ) c ON c.lump_id = l.id
       WHERE l.user_id = ?
       ORDER BY l.updated_at DESC, l.id DESC`,
      [req.user.id]
    );
    res.json({ lumps: rows.map(lumpRow) });
  } catch (err) { next(err); }
});

// POST /api/lumps — create
router.post('/', requireAuth, limiters().lumpWrites, async (req, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid input' });
    }
    const { name, description, is_public = false } = parsed.data;

    // Per-user uniqueness — checked in app code per spec.
    const dup = await query(
      `SELECT id FROM user_lumps WHERE user_id = ? AND name = ? LIMIT 1`,
      [req.user.id, name]
    );
    if (dup.length) return res.status(400).json({ error: 'a lump with that name already exists' });

    const result = await query(
      `INSERT INTO user_lumps (user_id, name, description, is_public)
       VALUES (?, ?, ?, ?)`,
      [req.user.id, name, description ?? null, is_public ? 1 : 0]
    );
    const rows = await query(
      `SELECT id, name, description, is_public, created_at, updated_at
       FROM user_lumps WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ lump: { ...lumpRow({ ...rows[0], track_count: 0 }) } });
  } catch (err) { next(err); }
});

// Helper — fetch a lump and check viewability for a user (or anon).
async function fetchLumpForViewer(lumpId, userId) {
  const rows = await query(
    `SELECT l.id, l.user_id, l.name, l.description, l.is_public,
            l.created_at, l.updated_at,
            u.username AS owner_username,
            COALESCE(c.cnt, 0) AS track_count
     FROM user_lumps l
     JOIN users u ON u.id = l.user_id
     LEFT JOIN (
       SELECT lump_id, COUNT(*) AS cnt FROM lump_tracks GROUP BY lump_id
     ) c ON c.lump_id = l.id
     WHERE l.id = ?
     LIMIT 1`,
    [lumpId]
  );
  if (!rows.length) return { status: 'not_found' };
  const l = rows[0];
  const isOwner = userId && l.user_id === userId;
  if (!l.is_public && !isOwner) return { status: 'not_found' };
  return { status: 'ok', lump: l, isOwner: !!isOwner };
}

// GET /api/lumps/:id — detail with tracks
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const lumpId = parseInt(req.params.id, 10);
    if (!Number.isFinite(lumpId)) return res.status(404).json({ error: 'not found' });

    const result = await fetchLumpForViewer(lumpId, req.user?.id);
    if (result.status !== 'ok') return res.status(404).json({ error: 'not found' });
    const { lump, isOwner } = result;

    const userId = req.user?.id || 0;
    const tracks = await query(
      `SELECT ${TRACK_COLUMNS_SQL},
              t.is_live AS available,
              (t.hidden_at IS NOT NULL) AS is_hidden,
              v.direction AS user_vote,
              lt.position
       FROM lump_tracks lt
       JOIN tracks t ON t.id = lt.track_id
       LEFT JOIN votes v ON v.track_id = t.id AND v.user_id = ?
       WHERE lt.lump_id = ?
       ORDER BY lt.position ASC, lt.id ASC`,
      [userId, lumpId]
    );

    res.json({
      lump: lumpRow(lump),
      tracks: tracks.flatMap((t) => {
        // Dead (link gone) tracks keep their details, marked unavailable.
        if (!t.is_hidden) return [{ ...serializeTrack(t), available: !!t.available }];
        // Hidden tracks (takedowns, rights) never show to other viewers; the
        // owner keeps the slot as a placeholder so the lump's order makes sense.
        if (!isOwner) return [];
        return [{
          id: t.id, external_id: null, source: null, title: 'Unavailable track',
          artist_name: '', genre: null, duration_seconds: null, license: null,
          artwork_url: null, upvotes: 0, downvotes: 0, net_lumps: 0,
          playable: false, attribution: null, position: t.position, available: false,
        }];
      }),
      is_owner: isOwner,
    });
  } catch (err) { next(err); }
});

// PATCH /api/lumps/:id
router.patch('/:id', requireAuth, limiters().lumpWrites, async (req, res, next) => {
  try {
    const lumpId = parseInt(req.params.id, 10);
    if (!Number.isFinite(lumpId)) return res.status(404).json({ error: 'not found' });

    const owner = await query(
      `SELECT id FROM user_lumps WHERE id = ? AND user_id = ? LIMIT 1`,
      [lumpId, req.user.id]
    );
    if (!owner.length) return res.status(404).json({ error: 'not found' });

    const parsed = PatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid input' });
    }
    const fields = parsed.data;

    if (fields.name) {
      const dup = await query(
        `SELECT id FROM user_lumps WHERE user_id = ? AND name = ? AND id != ? LIMIT 1`,
        [req.user.id, fields.name, lumpId]
      );
      if (dup.length) return res.status(400).json({ error: 'a lump with that name already exists' });
    }

    const sets = [];
    const params = [];
    if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
    if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
    if (fields.is_public !== undefined) { sets.push('is_public = ?'); params.push(fields.is_public ? 1 : 0); }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });

    params.push(lumpId);
    await query(`UPDATE user_lumps SET ${sets.join(', ')} WHERE id = ?`, params);

    const result = await fetchLumpForViewer(lumpId, req.user.id);
    res.json({ lump: lumpRow(result.lump) });
  } catch (err) { next(err); }
});

// DELETE /api/lumps/:id
router.delete('/:id', requireAuth, limiters().lumpWrites, async (req, res, next) => {
  try {
    const lumpId = parseInt(req.params.id, 10);
    const result = await query(
      `DELETE FROM user_lumps WHERE id = ? AND user_id = ?`,
      [lumpId, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

async function ensureOwnership(lumpId, userId) {
  const rows = await query(
    `SELECT id FROM user_lumps WHERE id = ? AND user_id = ? LIMIT 1`,
    [lumpId, userId]
  );
  return rows.length > 0;
}

async function bumpUpdatedAt(lumpId) {
  await query(`UPDATE user_lumps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [lumpId]);
}

// POST /api/lumps/:id/tracks — append
router.post('/:id/tracks', requireAuth, limiters().lumpWrites, async (req, res, next) => {
  try {
    const lumpId = parseInt(req.params.id, 10);
    if (!await ensureOwnership(lumpId, req.user.id)) return res.status(404).json({ error: 'not found' });

    const trackId = parseInt(req.body?.track_id, 10);
    if (!Number.isFinite(trackId)) return res.status(400).json({ error: 'track_id required' });

    const trackExists = await query(`SELECT id FROM tracks WHERE id = ? AND is_live = 1 LIMIT 1`, [trackId]);
    if (!trackExists.length) return res.status(404).json({ error: 'track not found' });

    const dup = await query(
      `SELECT id, position FROM lump_tracks WHERE lump_id = ? AND track_id = ? LIMIT 1`,
      [lumpId, trackId]
    );
    if (dup.length) {
      return res.json({ lump_track: dup[0], message: 'already in this lump', already_in: true });
    }

    const [{ next_pos }] = await query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM lump_tracks WHERE lump_id = ?`,
      [lumpId]
    );
    const ins = await query(
      `INSERT INTO lump_tracks (lump_id, track_id, position) VALUES (?, ?, ?)`,
      [lumpId, trackId, next_pos]
    );
    await bumpUpdatedAt(lumpId);

    res.status(201).json({
      lump_track: { id: ins.insertId, lump_id: lumpId, track_id: trackId, position: next_pos },
      already_in: false,
    });
  } catch (err) { next(err); }
});

// DELETE /api/lumps/:id/tracks/:trackId — remove + compact
router.delete('/:id/tracks/:trackId', requireAuth, limiters().lumpWrites, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const lumpId = parseInt(req.params.id, 10);
    const trackId = parseInt(req.params.trackId, 10);
    if (!Number.isFinite(lumpId) || !Number.isFinite(trackId)) {
      return res.status(400).json({ error: 'bad ids' });
    }

    if (!await ensureOwnership(lumpId, req.user.id)) {
      return res.status(404).json({ error: 'not found' });
    }

    await conn.beginTransaction();
    const [del] = await conn.execute(
      `DELETE FROM lump_tracks WHERE lump_id = ? AND track_id = ?`,
      [lumpId, trackId]
    );
    if (!del.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ error: 'not in this lump' });
    }
    // Compact positions to stay 0..n-1.
    await conn.query(`SET @pos := -1`);
    await conn.query(
      `UPDATE lump_tracks SET position = (@pos := @pos + 1)
       WHERE lump_id = ? ORDER BY position ASC`,
      [lumpId]
    );
    await conn.execute(
      `UPDATE user_lumps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [lumpId]
    );
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    try { await conn.rollback(); } catch { /* */ }
    next(err);
  } finally {
    conn.release();
  }
});

// PATCH /api/lumps/:id/tracks/reorder — full re-order
router.patch('/:id/tracks/reorder', requireAuth, limiters().lumpWrites, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const lumpId = parseInt(req.params.id, 10);
    if (!await ensureOwnership(lumpId, req.user.id)) {
      return res.status(404).json({ error: 'not found' });
    }

    const parsed = ReorderSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'track_ids required' });
    const trackIds = parsed.data.track_ids;

    await conn.beginTransaction();

    // Validate each track_id is in this lump (and only in this lump set).
    const [existing] = await conn.execute(
      `SELECT track_id FROM lump_tracks WHERE lump_id = ?`,
      [lumpId]
    );
    const existingSet = new Set(existing.map((r) => r.track_id));
    if (existingSet.size !== trackIds.length || trackIds.some((t) => !existingSet.has(t))) {
      await conn.rollback();
      return res.status(400).json({ error: 'track_ids must match the lump exactly' });
    }

    for (let i = 0; i < trackIds.length; i++) {
      await conn.execute(
        `UPDATE lump_tracks SET position = ? WHERE lump_id = ? AND track_id = ?`,
        [i, lumpId, trackIds[i]]
      );
    }
    await conn.execute(`UPDATE user_lumps SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [lumpId]);
    await conn.commit();

    const result = await fetchLumpForViewer(lumpId, req.user.id);
    res.json({ lump: lumpRow(result.lump) });
  } catch (err) {
    try { await conn.rollback(); } catch { /* */ }
    next(err);
  } finally {
    conn.release();
  }
});

export default router;
