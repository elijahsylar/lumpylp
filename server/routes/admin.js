// Admin endpoints. Every route requires a signed-in user whose role is
// 'admin' in the DB (checked per request). Declared once at router level so
// a new route can't be added without the check.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HIDE_REASONS, validateHide, hideTrack, unhideTrack } from '../lib/moderation.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// Catalog health at a glance: live, dead (per the sweep) and hidden counts.
router.get('/track-health', async (_req, res, next) => {
  try {
    const [totals] = await query(
      `SELECT COUNT(*) AS total, SUM(is_live = 1) AS live, SUM(is_dead = 1) AS dead,
              SUM(hidden_at IS NOT NULL) AS hidden, SUM(dead_checked_at IS NULL) AS never_checked
       FROM tracks`
    );
    const deadBySource = await query(
      `SELECT source, COUNT(*) AS n FROM tracks WHERE is_dead = 1 GROUP BY source`
    );
    const hiddenByReason = await query(
      `SELECT hidden_reason AS reason, COUNT(*) AS n FROM tracks WHERE hidden_at IS NOT NULL GROUP BY hidden_reason`
    );
    const num = (v) => Number(v) || 0;
    res.json({
      total: num(totals.total),
      live: num(totals.live),
      dead: num(totals.dead),
      hidden: num(totals.hidden),
      never_checked: num(totals.never_checked),
      dead_by_source: Object.fromEntries(deadBySource.map((r) => [r.source, num(r.n)])),
      hidden_by_reason: Object.fromEntries(hiddenByReason.map((r) => [r.reason, num(r.n)])),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/tracks/:id/hide { reason, note } — takedowns and rights issues.
router.post('/tracks/:id/hide', async (req, res, next) => {
  try {
    const trackId = parseInt(req.params.id, 10);
    const { reason, note = null } = req.body || {};
    const problem = validateHide({ reason, note });
    if (problem) return res.status(400).json({ error: problem });
    const ok = await hideTrack(query, { trackId, reason, note, actor: `admin:${req.user.username}`, userId: req.user.id });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, id: trackId, reason });
  } catch (err) { next(err); }
});

router.post('/tracks/:id/unhide', async (req, res, next) => {
  try {
    const trackId = parseInt(req.params.id, 10);
    const ok = await unhideTrack(query, { trackId, actor: `admin:${req.user.username}`, userId: req.user.id });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, id: trackId });
  } catch (err) { next(err); }
});

// GET /api/admin/tracks/hidden?reason=&page= — what is hidden and why.
router.get('/tracks/hidden', async (req, res, next) => {
  try {
    const page = Math.min(500, Math.max(1, parseInt(req.query.page, 10) || 1));
    const reason = String(req.query.reason || '');
    const where = ['hidden_at IS NOT NULL'];
    const params = [];
    if (reason) { where.push('hidden_reason = ?'); params.push(reason); }
    const rows = await query(
      `SELECT id, source, external_id, title, artist_name, hidden_at, hidden_reason, hidden_note, pd_effective_on
       FROM tracks WHERE ${where.join(' AND ')}
       ORDER BY hidden_at DESC, id DESC LIMIT 50 OFFSET ${(page - 1) * 50}`,
      params
    );
    res.json({ page, reasons: HIDE_REASONS, tracks: rows });
  } catch (err) { next(err); }
});

export default router;
