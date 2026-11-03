# Takedowns: how to take a track down quickly

This is the operating procedure. It is not legal text: the Terms of Service, privacy policy and DMCA agent registration are handled separately by the owner.

## Contact route

- **Address:** `takedowns@lumpylp.com`, forwarded to the owner by Cloudflare Email Routing. The owner sets up the routing; the domain's DNS is already on Cloudflare.
- Publish this address on the takedown page and in the footer once the legal pages exist.
- Log every request you receive, even ones you decline.

## When a notice arrives

1. **Find the track.** A notice usually names a title, artist or link.
   - A LumpyLP link `/tracks/<id>` gives the id directly.
   - Otherwise, an admin can search: `GET /api/search?q=<title>`.
   - Each track's `attribution.source_url` shows where it came from.
2. **Hide it immediately.** Don't wait to judge the claim; hiding is reversible.
   - API, as an admin:
     ```
     POST /api/admin/tracks/<id>/hide
     {"reason": "takedown", "note": "notice from <sender>, <date>, ref <their ref>"}
     ```
   - API down? On the server:
     ```
     NODE_ENV=production node server/scripts/hide-track.js <id> --reason=takedown --note="notice from <sender>, <date>"
     ```
   - The effect is immediate: the track drops out of every listing, search and shuffle, and `/api/stream/<id>` returns 410. In lumps it disappears for everyone except the lump's owner, who sees an "Unavailable track" placeholder with no title, artist or source. Nothing is deleted.
3. **Check for copies.** The same recording can exist under another source or as a hidden duplicate (`duplicate_of`). Search by title and artist and hide every copy named in the notice.
4. **Record it.** `moderation_log` already holds who hid what, when, why and the note. Keep the notice itself with your records (outside the server).
5. **Reply** to the sender that the material has been disabled.
6. **Counter-notice or a mistake:** unhide with `POST /api/admin/tracks/<id>/unhide` (or `hide-track.js <id> --unhide`). This is also logged.

## Reasons

| reason | use for |
|---|---|
| `takedown` | a rights holder's notice |
| `rights` | our own finding that a license doesn't hold |
| `quality` | broken or junk entries |
| `admin` | anything else (say why in the note) |

The system uses its own reasons for bulk hides; don't set these by hand:
- `rights_loc_jukebox` and `rights_check_pending` (Library of Congress);
- `rights_musopen_european_archive`;
- `pd_not_yet_1926` (unhidden automatically on its public-domain date);
- `license_unverified` (Wikimedia public-domain and Jamendo bare-"CC" rows; `scripts/check-wikimedia-licenses.js` lists the Wikimedia ones Commons confirms);
- `duplicate`.

## Review

`GET /api/admin/tracks/hidden?reason=takedown` lists hidden tracks with their reason and note. `GET /api/admin/track-health` gives counts per reason.

## Who can do this

Only accounts with `role = 'admin'`. Grant it with `server/db/grant-admin.sql`; there is no API to change roles.
