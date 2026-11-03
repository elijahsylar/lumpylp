// Hide and unhide catalog tracks (takedown path, relaunch item 14). Hiding
// is immediate (tracks.is_live is a generated column) and reversible; every
// action is logged in moderation_log with who did it and why.
export const HIDE_REASONS = ['takedown', 'rights', 'quality', 'admin'];
const MAX_NOTE = 255;

export function validateHide({ reason, note }) {
  if (!HIDE_REASONS.includes(reason)) return `reason must be one of: ${HIDE_REASONS.join(', ')}`;
  if (note != null && (typeof note !== 'string' || note.length > MAX_NOTE)) return `note must be text up to ${MAX_NOTE} characters`;
  return null;
}

// Returns false when the track doesn't exist.
export async function hideTrack(query, { trackId, reason, note = null, actor, userId = null }) {
  const r = await query(
    `UPDATE tracks SET hidden_at = COALESCE(hidden_at, NOW()), hidden_reason = ?, hidden_note = ? WHERE id = ?`,
    [reason, note, trackId]
  );
  if (!r.affectedRows) return false;
  await query(
    `INSERT INTO moderation_log (track_id, user_id, actor, action, reason, note) VALUES (?, ?, ?, 'hide', ?, ?)`,
    [trackId, userId, actor, reason, note]
  );
  return true;
}

export async function unhideTrack(query, { trackId, actor, userId = null }) {
  const r = await query(
    `UPDATE tracks SET hidden_at = NULL, hidden_reason = NULL, hidden_note = NULL, duplicate_of = NULL WHERE id = ?`,
    [trackId]
  );
  if (!r.affectedRows) return false;
  await query(
    `INSERT INTO moderation_log (track_id, user_id, actor, action) VALUES (?, ?, ?, 'unhide')`,
    [trackId, userId, actor]
  );
  return true;
}
