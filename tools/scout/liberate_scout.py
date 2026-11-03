"""
Liberate-Scout — autonomous CC/PD music source discovery.

Forked from Liberate, a smaller single-track finder (not included here).
This tool finds whole music ARCHIVES — APIs, bulk downloads, regional
collections, niche communities — and logs verified candidates to
SQLite for manual review. The original Liberate is unchanged.

## Setup

    ollama serve
    ollama pull llama3.1:8b-instruct
    pip3 install ddgs requests rich

## Usage

    python3 liberate_scout.py --hours 6
    python3 liberate_scout.py --until-convergence
    python3 liberate_scout.py --report
    python3 liberate_scout.py --smoke-test

`--hours N`            run for at most N hours, then stop.
`--until-convergence`  stop after N consecutive turns with no new candidate.
`--report`             print a summary of scout.db and exit (no LLM calls).
`--smoke-test`         run exactly 3 LLM turns and exit. Use this to confirm
                       the loop is wired right before kicking off long runs.

## Architecture

Same shape as Liberate: ollama chat loop, DDG search wrapper, action-parsing,
failed-domain learning, rich console output. Differences:

  * System prompt: discover music SOURCES, not individual tracks.
  * Actions: SEARCH | FETCH | VERIFY_API | LOG_CANDIDATE | LOG_REJECTION | DONE.
  * Output: SQLite at scout.db (no audio downloads).
  * Default model: llama3.1:8b-instruct (better instruction-following than mistral).
  * Loop control: --hours / --until-convergence / --smoke-test.
  * Blocklist: scout_blocklist.txt — already-integrated and already-rejected sources.

## Hard rules

  * The LLM never writes code or files. Its only outputs are the 6 actions.
  * The LLM cannot directly write to the DB. log_candidate / log_rejection
    actions are mediated by the script. The verified_count column is bound
    to the most recent verify_api result for that URL — the LLM's claimed
    counts are ignored.
  * A LOG_CANDIDATE is only accepted if at least one of:
      (a) verify_api returned a numeric count > 0
      (b) verify_api returned 200 OK + audio indicators (audio/* content-type,
          mp3/ogg/flac/wav/m4a/opus links in body, or `<audio>` tag)
      (c) the LLM put specific verification evidence in the NOTES field
          (a quoted homepage claim like "50,000 tracks", "we host 12,000 albums",
          a screenshot URL, etc.) — heuristic: 4+ digit number near a
          music-related noun.
    Otherwise the action is rejected and the LLM is told to verify again or
    log_rejection.
  * Politeness: 3s between web searches, 1s between fetches, 500ms between
    API calls to the same host.
  * Blocked sources (scout_blocklist.txt) are filtered from search results,
    rejected if fetched, and rejected if logged as candidates.

## Output files

  * tools/scout/scout.db              — SQLite (candidates, rejections, search_history, sessions)
  * tools/scout/scout_messages.jsonl    — append-only training-data stream, one
                                      JSON object per turn (full message history,
                                      response, parsed action, tool result, latency)
  * tools/scout/scout_blocklist.txt    — user-editable; seeded on first run

## Expected runtime

  * --smoke-test: ~30–60 seconds (3 turns, ollama-bound).
  * --hours 6: 6 hours wallclock; expect 100–500 candidates depending on
    discovery rate. Long-run sessions are unattended-safe.
"""

import os
import re
import sys
import json
import time
import uuid
import sqlite3
import argparse
import requests
from urllib.parse import urlparse
from pathlib import Path
from datetime import datetime, timezone
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from ddgs import DDGS

# ------------------------------------------------------------------ #
#  CONFIG                                                              #
# ------------------------------------------------------------------ #

OLLAMA_URL = "http://localhost:11434/api/chat"
DEFAULT_MODEL = "llama3.1:latest"

SCRIPT_DIR = Path(__file__).resolve().parent
DB_PATH = SCRIPT_DIR / "scout.db"
BLOCKLIST_PATH = SCRIPT_DIR / "scout_blocklist.txt"
JSONL_PATH = SCRIPT_DIR / "scout_messages.jsonl"

MAX_TURNS_DEFAULT = 1000        # generous cap; --hours / --until-convergence usually bind first
CONVERGENCE_TURNS = 8           # turns with no new candidate to declare convergence
SMOKE_TURNS = 3
TEMPERATURE = 0.7
NUM_PREDICT = 1024

SEARCH_GAP_SEC = 3.0
FETCH_GAP_SEC = 1.0
APICALL_GAP_SEC = 0.5

HEADERS = {"User-Agent": "LumpyLP scout (research; +https://lumpylp.com)"}
console = Console()

# ------------------------------------------------------------------ #
#  SYSTEM PROMPT                                                       #
# ------------------------------------------------------------------ #

SYSTEM_PROMPT = """You are a music-archive scout for LumpyLP, a Creative Commons + Public Domain music indexer with 430k tracks. Your job is to find sources LumpyLP hasn't integrated yet — whole archives, not individual tracks.

You care about real music: regional traditions, DIY communities, historical recordings, indigenous artists sharing openly, niche scenes the algorithms ignore. You're bored by AI-generated music and royalty-free corporate stock.

## Your goal this session

Log 50+ verified candidates. Volume matters. A human curator reviews everything you log later — they can prune. What they CAN'T do is find sources you didn't surface. Err toward logging sources with weak-but-real evidence over rejecting them.

DONE is only valid when you have logged at least 50 candidates OR exhausted every reasonable lead. Do not emit DONE just because a few attempts failed. The script enforces a session timer; that timer ends the session, not you.

## How to think and act

Work in a Thought → Action → Observation loop. Every response starts with one Thought line explaining your reasoning, followed by exactly one Action.

Format:
   Thought: [your reasoning, 1-3 sentences]
   Action: [exactly one of the action commands below]

The Thought is for you to reason about what to do. The Action is the command the script will execute.

## Available actions

   SEARCH: <query>
      Web search via DuckDuckGo. Keep queries 3-6 words. Use non-English terms for non-English regions ("musique libre", "música creative commons", "クリエイティブコモンズ音楽").

   FETCH: <full URL>
      Read the first ~4000 chars of a webpage. The argument MUST be a complete URL starting with http:// or https://.

      ✅ CORRECT: FETCH: https://monocromatica.com
      ❌ WRONG:   FETCH: 2          (this is a result index, not a URL)
      ❌ WRONG:   FETCH: monocromatica   (no schema)

      Use FETCH on the homepage or about page of a candidate source, looking for numeric claims about catalog size in the page body.

   VERIFY_API: <full URL> | <format>
      Hit an API/feed and try to extract item count. Format must be one of: json, xml, html.

      If you try | json and the response says "API returned HTML, not JSON" — that means you guessed wrong on format. Retry with | html on the SAME URL before giving up. Different sites return different formats; trying both takes one extra action and saves the source from being abandoned.

   LOG_CANDIDATE: <multi-line block>
      Save a source. Required fields:
         NAME: <source name>
         URL: <homepage or API root>
         REGION: <country / region / global>
         LICENSE_POSTURE: <quote actual license terms if visible>
         ACCESS_METHOD: <REST API / bulk download / RSS / scrape>
         AUDIO_FORMAT: <mp3 / flac / etc>
         COVERAGE: <genre / language / era / community>
         CULTURAL_POSTURE: <cleared | caution | research-required>
         INTEGRATION_DIFFICULTY: <easy | moderate | hard>
         NOTES: <verification evidence + why this source matters>

   LOG_REJECTION: <name> | <url> | <reason>
      Record a source you investigated but ruled out. ONLY use after at least 2 separate verification attempts on that source (different endpoint OR different format OR a homepage FETCH). Single-attempt rejections are not allowed.

   DONE
      End the session. ONLY valid after logging 50+ candidates or exhausting every available lead.

## What is and isn't a real lead

A LEAD is the homepage or API of an actual music archive — a place that hosts or distributes audio files.

These ARE leads (verify these):
   ✅ https://monocromatica.com (a netlabel that hosts music)
   ✅ https://dogmazic.net (a music platform with audio)
   ✅ https://archive.org/details/folkways (an IA collection)

These are NOT leads (skip these — don't even verify):
   ❌ https://en.wikipedia.org/wiki/Free_Music_Archive
      (Wikipedia ARTICLES about archives are not the archives themselves)
   ❌ https://blog.somesite.com/best-cc-music-sites
      (Blog posts listing music sites are not music sites)
   ❌ https://reddit.com/r/freemusic
      (Discussion forums are not music sources)

If a search result is a Wikipedia article or blog post, treat it as a SOURCE OF LEADS — read it for archive URLs it mentions, then verify those archives directly. Do not log the Wikipedia URL itself as a candidate.

## The standard discovery flow

This is the path you should take 80% of the time:

   1. SEARCH for a niche, region, or community
   2. From the results, identify a real archive URL
   3. FETCH the archive's homepage
   4. Read the body for a numeric claim — "we host X tracks", "X albums", "X recordings", "X items"
   5. If the homepage doesn't show a count, try ONE of these in order before giving up:
         a. FETCH <domain>/about (often has "we have X" copy)
         b. FETCH <domain>/press or <domain>/press-kit
         c. FETCH <domain>/stats or <domain>/statistics
         d. SEARCH "<domain> tracks" or "<domain> catalog size" (the count often shows in third-party reviews / press coverage)
   6. LOG_CANDIDATE with the quoted claim in NOTES
   7. Move to the next source

Where numeric claims actually live (in order of likelihood):
   - About / About-us pages — most common
   - Press kits — almost always have catalog size
   - Wikipedia articles — yes, the article itself is not a lead, but it usually contains a quotable number you can put in NOTES (e.g. "Wikipedia states 150,000 tracks as of 2024")
   - Third-party reviews and press coverage — search for "<archive name> tracks" or "<archive name> review"
   - The footer of the homepage (sometimes "X+ tracks since YYYY")
   - Marketing copy on the front page (less common but possible)

Wikipedia is special: don't log the Wikipedia URL as the candidate, but DO use Wikipedia as a source of quotable numeric claims for the actual archive's NOTES field. Quote Wikipedia saying "X has Y tracks" and put that in NOTES with attribution.

The number-in-NOTES path (FETCH → quote → LOG) is the most common and most efficient. Use it as your default. VERIFY_API is for sources where you've already found an API endpoint and want a clean count.

## Recovery procedure when LOG_CANDIDATE gets rejected

If your LOG_CANDIDATE is rejected, do NOT abandon the source. Stay on it. Run through this procedure:

   Step 1: If you only ran VERIFY_API with | json and got HTML back: retry VERIFY_API on the same URL with | html.
   Step 2: If that still fails: FETCH the homepage and look for numeric claims in the body.
   Step 3: If that still fails: FETCH a different page (about, /catalog, /stats, /api) on the same domain.
   Step 4: Only after 3 attempts on the same source: LOG_REJECTION and move on.

Determination matters. The first endpoint rarely returns clean data — that's normal, not a reason to bail.

## Examples

Healthy discovery flow:

   Thought: Eastern European netlabels are an under-indexed scene. Let me search for that.
   Action: SEARCH: Eastern European netlabel CC

   [Observation: results include monocromatica.com (a Polish netlabel) and a Wikipedia article on netlabels]

   Thought: Skipping the Wikipedia link. Monocromatica is the real archive — let me read their homepage.
   Action: FETCH: https://monocromatica.com

   [Observation: page body contains "Since 2003 we've released over 250 albums of free electronic music"]

   Thought: Quoted numeric claim — "250 albums" — that's my evidence. Logging this.
   Action: LOG_CANDIDATE:
   NAME: Monocromatica
   URL: https://monocromatica.com
   REGION: Poland / Eastern Europe
   LICENSE_POSTURE: CC-BY-NC variants per release; verify per album
   ACCESS_METHOD: bulk download (zip per album)
   AUDIO_FORMAT: mp3, flac
   COVERAGE: electronic, ambient, IDM, Polish DIY scene
   CULTURAL_POSTURE: cleared
   INTEGRATION_DIFFICULTY: moderate (per-album licensing variance)
   NOTES: Homepage states "Since 2003 we've released over 250 albums of free electronic music." Active Polish netlabel collective, fills geographic gap in the catalog (currently light on Eastern European electronic scenes).

Recovery flow after format mismatch:

   Thought: Dogmazic is the canonical French CC platform. Let me verify their API.
   Action: VERIFY_API: https://dogmazic.net/api/ | json

   [Observation: status 200, content_type text/html, count null. The endpoint returned HTML, not JSON.]

   Thought: Format mismatch — that endpoint serves HTML. Retrying with html format on the same URL before giving up.
   Action: VERIFY_API: https://dogmazic.net/api/ | html

   [Observation: still no count extractable; it's the routing root, not the actual API]

   Thought: Two API attempts didn't yield a count. Trying the homepage for marketing copy with numeric claims.
   Action: FETCH: https://dogmazic.net

   [Observation: page contains "Plus de 60 000 morceaux libres" in French marketing text]

   Thought: There it is — "more than 60,000 free tracks" in French. Logging with that quote.
   Action: LOG_CANDIDATE:
   NAME: Dogmazic
   URL: https://dogmazic.net
   REGION: France / French-speaking
   LICENSE_POSTURE: CC variants (BY, BY-SA, BY-NC), per-track
   ACCESS_METHOD: web scraping, possibly Subsonic API at /rest/
   AUDIO_FORMAT: mp3, ogg
   COVERAGE: French independent music, all genres, since 2004
   CULTURAL_POSTURE: cleared
   INTEGRATION_DIFFICULTY: moderate
   NOTES: Homepage states "Plus de 60 000 morceaux libres" (60,000+ free tracks). Major French CC platform, active for 20+ years. Subsonic-compatible API likely available at /rest/getArtists.view but needs follow-up investigation.

What NOT to do — bailing too early:

   Thought: VERIFY_API returned HTML instead of JSON.
   Action: LOG_REJECTION: Source X | url | API returned HTML

This is wrong. You only tried | json. Always retry with | html, then FETCH the homepage, before rejecting.

## Hard rules

   - One Thought + one Action per response. Always.
   - Don't invent URLs. Use only URLs from search results, fetch responses, or verify_api responses.
   - Don't log a source twice (the script tracks by URL).
   - Don't suggest sources on the blocklist (the script tells you when results were filtered).
   - Don't log Wikipedia articles, blog posts, or discussion forums as candidates. Read them for archive URLs and verify those instead.
   - When in doubt, log with verification evidence. Volume > selectivity.
   - DONE is only valid when you've logged 50+ candidates or genuinely exhausted leads. Three failed attempts is not exhaustion.
   - Never ask the user a question or wait for direction. If you don't know what to do next, run another action (different SEARCH, different FETCH, or LOG_REJECTION). Asking "would you like me to A or B?" is forbidden — pick one and act.

Begin scouting.
"""

# ------------------------------------------------------------------ #
#  SQLITE                                                              #
# ------------------------------------------------------------------ #

SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  region TEXT,
  verified_count INTEGER,
  license_posture TEXT,
  access_method TEXT,
  audio_format TEXT,
  coverage TEXT,
  cultural_posture TEXT,
  integration_difficulty TEXT,
  notes TEXT,
  discovered_at TEXT DEFAULT CURRENT_TIMESTAMP,
  verified_at TEXT
);
CREATE TABLE IF NOT EXISTS rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  url TEXT,
  reason TEXT,
  rejected_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  result_count INTEGER,
  searched_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  mode TEXT,
  total_turns INTEGER DEFAULT 0,
  candidates_logged INTEGER DEFAULT 0,
  rejections_logged INTEGER DEFAULT 0,
  final_status TEXT DEFAULT 'running'
);
"""


def db_open():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def log_candidate_row(conn, fields, verified_count, verified_at):
    cur = conn.cursor()
    try:
        cur.execute("""
          INSERT INTO candidates
            (name, url, region, verified_count, license_posture, access_method,
             audio_format, coverage, cultural_posture, integration_difficulty,
             notes, verified_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(url) DO UPDATE SET
            name=excluded.name,
            region=excluded.region,
            verified_count=excluded.verified_count,
            license_posture=excluded.license_posture,
            access_method=excluded.access_method,
            audio_format=excluded.audio_format,
            coverage=excluded.coverage,
            cultural_posture=excluded.cultural_posture,
            integration_difficulty=excluded.integration_difficulty,
            notes=excluded.notes,
            verified_at=excluded.verified_at
        """, (
            fields.get("name"), fields.get("url"), fields.get("region"),
            verified_count, fields.get("license_posture"),
            fields.get("access_method"), fields.get("audio_format"),
            fields.get("coverage"), fields.get("cultural_posture"),
            fields.get("integration_difficulty"), fields.get("notes"),
            verified_at,
        ))
        conn.commit()
        return cur.rowcount, "ok"
    except sqlite3.Error as e:
        return 0, f"db error: {e}"


def log_rejection_row(conn, name, url, reason):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO rejections (name, url, reason) VALUES (?,?,?)",
        (name, url, reason),
    )
    conn.commit()
    return cur.rowcount


def log_search_row(conn, query, result_count):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO search_history (query, result_count) VALUES (?,?)",
        (query, result_count),
    )
    conn.commit()


def session_start(conn, session_id, model, mode):
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, model, mode) VALUES (?,?,?,?)",
        (session_id, started_at, model, mode),
    )
    conn.commit()


def session_progress(conn, session_id, turns, candidates, rejections):
    conn.execute(
        """UPDATE sessions
           SET total_turns=?, candidates_logged=?, rejections_logged=?
           WHERE session_id=?""",
        (turns, candidates, rejections, session_id),
    )
    conn.commit()


def session_end(conn, session_id, final_status):
    ended_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute(
        "UPDATE sessions SET ended_at=?, final_status=? WHERE session_id=?",
        (ended_at, final_status, session_id),
    )
    conn.commit()


def jsonl_append(record):
    """Best-effort append. Failures must NOT crash the loop."""
    try:
        with open(JSONL_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as e:
        console.print(f"[yellow]jsonl write failed: {e}[/yellow]")


# ------------------------------------------------------------------ #
#  BLOCKLIST                                                           #
# ------------------------------------------------------------------ #

DEFAULT_BLOCKLIST = """\
# Liberate-Scout blocklist — substring match on URL or name.
# Lines starting with # are comments. One pattern per line.
# Edit freely between runs.

# Already integrated into LumpyLP catalog (do not re-discover)
audius.co
archive.org/details/etree
archive.org/details/netlabels
archive.org/details/cylindertransfer
jamendo.com
ccmixter.org
commons.wikimedia.org
loc.gov/audio
musopen.org
api.musopen.org
incompetech.com
audionautix.com

# Confirmed dead ends from prior research (do not re-explore)
smithsonianfolkways.org
pixabay.com/music
bensound.com
youtube.com/audiolibrary
looperman.com
magnatune.com
freepd.com
archive.org/details/audio_music
archive.org/details/opensource_audio

# Confirmed legal-risk sources (do not explore)
rgafd.ru
nlr.ru
rsl.ru
"""


def load_blocklist():
    if not BLOCKLIST_PATH.exists():
        BLOCKLIST_PATH.write_text(DEFAULT_BLOCKLIST)
    patterns = []
    for line in BLOCKLIST_PATH.read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            patterns.append(s.lower())
    return patterns


def is_blocked(text, patterns):
    if not text:
        return False
    t = text.lower()
    return any(p in t for p in patterns)


# ------------------------------------------------------------------ #
#  POLITENESS GATES                                                    #
# ------------------------------------------------------------------ #

_last_search = 0.0
_last_fetch = 0.0
_last_api_per_host = {}


def _politeness_wait(kind, host=None):
    global _last_search, _last_fetch
    now = time.time()
    if kind == "search":
        delta = SEARCH_GAP_SEC - (now - _last_search)
        if delta > 0:
            time.sleep(delta)
        _last_search = time.time()
    elif kind == "fetch":
        delta = FETCH_GAP_SEC - (now - _last_fetch)
        if delta > 0:
            time.sleep(delta)
        _last_fetch = time.time()
    elif kind == "api":
        last = _last_api_per_host.get(host, 0)
        delta = APICALL_GAP_SEC - (now - last)
        if delta > 0:
            time.sleep(delta)
        _last_api_per_host[host] = time.time()


# ------------------------------------------------------------------ #
#  TOOLS — search / fetch / verify_api                                 #
# ------------------------------------------------------------------ #

def tool_search(query, blocklist):
    """Run a DDG search and filter blocked URLs out."""
    _politeness_wait("search")
    try:
        results = list(DDGS().text(query, max_results=10))
    except Exception as e:
        return f"Search error: {e}", 0
    filtered = []
    skipped = 0
    for r in results:
        url = r.get("href", "")
        if is_blocked(url, blocklist):
            skipped += 1
            continue
        filtered.append(r)
    if not filtered:
        msg = "No results"
        if skipped:
            msg += f" ({skipped} filtered by blocklist)"
        return msg + ".", 0
    out = []
    for i, r in enumerate(filtered, 1):
        body = (r.get("body", "") or "")[:300]
        out.append(
            f"[{i}] {r.get('title','')}\n"
            f"    URL: {r.get('href','')}\n"
            f"    {body}"
        )
    note = f" ({skipped} blocked)" if skipped else ""
    return "\n\n".join(out) + note, len(filtered)


def tool_fetch(url):
    """Raw HTTP GET, return first ~4000 chars of response."""
    _politeness_wait("fetch")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
    except Exception as e:
        return f"FETCH ERROR: {e}", None
    text = resp.text or ""
    head = text[:4000]
    return f"HTTP {resp.status_code} ({len(text)} chars total)\n\n{head}", resp.status_code


def tool_verify_api(url, fmt):
    """Hit url, parse as fmt, attempt to extract count + sample fields."""
    fmt = (fmt or "").strip().lower()
    host = urlparse(url).netloc
    _politeness_wait("api", host=host)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
    except Exception as e:
        return {
            "ok": False, "status": None, "format": fmt,
            "content_type": None,
            "count": None, "sample_fields": None,
            "audio_indicators": False,
            "raw_head": "", "error": str(e),
        }
    raw = resp.text or ""
    head = raw[:1500]
    content_type = (resp.headers.get("content-type") or "").lower()
    info = {
        "ok": resp.ok, "status": resp.status_code, "format": fmt,
        "content_type": content_type,
        "count": None, "sample_fields": None,
        "audio_indicators": _has_audio_indicators(content_type, raw),
        "raw_head": head, "error": None,
    }
    try:
        if fmt == "json":
            data = json.loads(raw)
            info["count"] = _extract_count_json(data)
            info["sample_fields"] = _sample_fields_json(data)
        elif fmt == "xml":
            m = re.search(r"<(?:[^>]+:)?totalResults?\b[^>]*>(\d+)<", raw, re.I)
            if m:
                info["count"] = int(m.group(1))
            info["sample_fields"] = sorted(set(
                re.findall(r"<([a-zA-Z][\w:-]{1,30})[\s/>]", raw)
            ))[:20]
        elif fmt == "html":
            m = re.search(
                r"([\d,]{2,})\s*(?:tracks|items|records|recordings|releases|songs|albums)",
                raw, re.I,
            )
            if m:
                info["count"] = int(m.group(1).replace(",", ""))
            info["sample_fields"] = None
        else:
            info["error"] = f"unknown format: {fmt}"
    except Exception as e:
        info["error"] = f"parse error: {e}"
    return info


def _extract_count_json(data):
    if not isinstance(data, (dict, list)):
        return None
    if isinstance(data, list):
        return len(data)
    # Common count fields seen in the wild
    for k in ("totalResults", "total", "count", "numFound", "total_count",
              "totalItems", "n_results", "totalHits"):
        v = data.get(k)
        if isinstance(v, int):
            return v
    # Internet Archive advanced search shape
    resp = data.get("response")
    if isinstance(resp, dict):
        v = resp.get("numFound")
        if isinstance(v, int):
            return v
    # Fallback: length of the first result-list-shaped field
    for k in ("results", "items", "data", "docs", "tracks", "audios", "siblings"):
        v = data.get(k)
        if isinstance(v, list):
            return len(v)
    return None


def _sample_fields_json(data):
    target = data
    if isinstance(target, dict):
        for k in ("results", "items", "data", "docs", "tracks", "audios"):
            v = target.get(k)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                target = v[0]
                break
        else:
            target = data
    if isinstance(target, dict):
        return sorted(target.keys())[:30]
    if isinstance(target, list) and target and isinstance(target[0], dict):
        return sorted(target[0].keys())[:30]
    return None


_AUDIO_EXT_RE = re.compile(r"\.(mp3|ogg|flac|wav|m4a|opus|aac)\b", re.IGNORECASE)
_AUDIO_TAG_RE = re.compile(r"<audio\b", re.IGNORECASE)
_NOTES_EVIDENCE_RE = re.compile(
    r"\b\d{1,3}(?:[,.\s]?\d{3})+\s*\+?\s*"  # 4+ digit number, optional separators / +
    r"(?:tracks|songs|albums|recordings|items|files|releases|hours|sound\s*recordings)\b"
    r"|"
    r"\b\d{4,}\s*\+?\s*"
    r"(?:tracks|songs|albums|recordings|items|files|releases|hours|sound\s*recordings)\b",
    re.IGNORECASE,
)


def _has_audio_indicators(content_type, body):
    """Audio content-type, audio file extensions, or <audio> tag in body head."""
    if content_type and content_type.startswith("audio/"):
        return True
    head = body[:5000] if body else ""
    if _AUDIO_EXT_RE.search(head):
        return True
    if _AUDIO_TAG_RE.search(head):
        return True
    return False


def _notes_has_evidence(notes):
    """Heuristic: 4+ digit number adjacent to a music-related noun in NOTES."""
    if not notes:
        return False
    return bool(_NOTES_EVIDENCE_RE.search(notes))


def is_log_candidate_eligible(verified_info, notes):
    """
    Returns (ok: bool, reason: str). Implements the candidate-verification rule:
      (a) verify_api count > 0
      (b) verify_api 200 OK + audio_indicators
      (c) NOTES contains specific verification evidence
    """
    if verified_info:
        cnt = verified_info.get("count")
        if isinstance(cnt, int) and cnt > 0:
            return True, f"verify_api count={cnt}"
        if verified_info.get("status") == 200 and verified_info.get("audio_indicators"):
            return True, "verify_api 200 + audio indicators"
    if _notes_has_evidence(notes):
        return True, "NOTES contains specific evidence"
    return False, (
        "no verification evidence: verify_api had no count and no audio "
        "indicators, and NOTES has no quoted numeric claim"
    )


# ------------------------------------------------------------------ #
#  OLLAMA CHAT                                                         #
# ------------------------------------------------------------------ #

def chat_with_ollama(messages, model):
    try:
        resp = requests.post(
            OLLAMA_URL,
            json={
                "model": model,
                "messages": messages,
                "stream": False,
                "options": {
                    "temperature": TEMPERATURE,
                    "num_predict": NUM_PREDICT,
                },
            },
            timeout=180,
        )
        resp.raise_for_status()
        return resp.json().get("message", {}).get("content", "")
    except requests.exceptions.ConnectionError:
        console.print(
            f"\n[red]Cannot connect to Ollama. "
            f"Run 'ollama serve' and 'ollama pull {model}'.[/red]"
        )
        sys.exit(1)
    except Exception as e:
        console.print(f"\n[red]Ollama error: {e}[/red]")
        return ""


def ollama_alive():
    try:
        requests.get("http://localhost:11434/api/tags", timeout=5)
        return True
    except Exception:
        return False


def list_installed_models():
    """Return list of model names the local ollama has pulled."""
    try:
        resp = requests.get("http://localhost:11434/api/tags", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        return [m.get("name") for m in (data.get("models") or []) if m.get("name")]
    except Exception:
        return []


def ensure_model_installed(model):
    """Exit cleanly if the requested model isn't pulled."""
    installed = list_installed_models()
    if model in installed:
        return
    # Some models can match by family even when tag differs (e.g. user passed
    # 'llama3.1' but only 'llama3.1:latest' is installed). Be a little forgiving.
    base = model.split(":")[0]
    families = {m.split(":")[0] for m in installed}
    console.print(f"[red]ERROR: model {model!r} not found.[/red]")
    if installed:
        console.print(f"[yellow]Installed models:[/yellow]")
        for m in installed:
            console.print(f"  {m}")
    else:
        console.print("[yellow]No models installed.[/yellow]")
    console.print(f"[yellow]Run:[/yellow] ollama pull {model}")
    if base in families:
        same_family = [m for m in installed if m.split(":")[0] == base]
        console.print(
            f"[yellow]Or use:[/yellow] --model {same_family[0]}"
        )
    elif installed:
        console.print(f"[yellow]Or use:[/yellow] --model {installed[0]}")
    sys.exit(1)


# ------------------------------------------------------------------ #
#  ACTION PARSER                                                       #
# ------------------------------------------------------------------ #

def _summarize_action(action_tuple):
    """Short human-readable summary of a parsed action — used to remind the LLM
    of actions it queued in a multi-action response."""
    if not action_tuple:
        return "(unparseable)"
    kind = action_tuple[0]
    if kind == "search":
        return f"SEARCH: {action_tuple[1][:80]}"
    if kind == "fetch":
        return f"FETCH: {action_tuple[1]}"
    if kind == "verify_api":
        return f"VERIFY_API: {action_tuple[1]} | {action_tuple[2]}"
    if kind == "log_rejection":
        return f"LOG_REJECTION: {action_tuple[1]}"
    if kind == "log_candidate":
        fields = action_tuple[1] if len(action_tuple) > 1 else {}
        return f"LOG_CANDIDATE for {fields.get('name','?')} ({fields.get('url','?')})"
    if kind == "done":
        return "DONE"
    return f"({kind})"


# Action keywords at start-of-line (after optional markdown decoration or one
# of the framing prefixes the LLM sometimes wraps actions in: "NEXT ACTION:",
# "Next:", or the ReAct "Action:" prefix).
_ACTION_PREFIX = (
    r"(?:"
    r"NEXT[\s_-]+ACTION\s*:\s*"
    r"|NEXT\s*:\s*"
    r"|ACTION\s*:\s*"
    r")?"
)
_ACTION_KEYWORD_RE = re.compile(
    r"^[\s>*#`-]*" + _ACTION_PREFIX +
    r"(SEARCH|FETCH|VERIFY_API|LOG_REJECTION|LOG_CANDIDATE|DONE)\b",
    re.IGNORECASE | re.MULTILINE,
)


def parse_actions(response):
    """
    Return ordered list of action tuples found in `response`. Empty list if none.

    Tuples are one of:
      ("done", None)
      ("search", query)
      ("fetch", url)
      ("verify_api", url, fmt)
      ("log_candidate", fields_dict)
      ("log_rejection", name, url, reason)

    Multiple actions in one response are returned in order of appearance (FIFO).
    The caller decides how to dispatch.
    """
    text = response or ""
    if not text.strip():
        return []

    matches = list(_ACTION_KEYWORD_RE.finditer(text))
    if not matches:
        return []

    out = []
    for i, m in enumerate(matches):
        keyword = m.group(1).upper()
        block_start = m.start()
        block_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[block_start:block_end]
        action = _parse_block(keyword, block)
        if action is not None:
            out.append(action)
    return out


def _parse_block(keyword, block):
    """Parse a single action block starting with `keyword`."""
    # The block may start with leading whitespace/newline because the keyword
    # regex consumed leading-line padding. Use the first non-empty line.
    first_line = next((ln for ln in block.split("\n") if ln.strip()), "")

    if keyword == "DONE":
        return ("done", None)

    if keyword == "SEARCH":
        m = re.match(
            r"^[\s>*#`-]*(?:NEXT[\s_-]+ACTION\s*:\s*|NEXT\s*:\s*|ACTION\s*:\s*)?"
            r"SEARCH\s*:\s*(.+?)\s*$",
            first_line, re.IGNORECASE,
        )
        if m and len(m.group(1).strip()) >= 1:
            return ("search", m.group(1).strip().strip('"\''))
        return None

    if keyword == "FETCH":
        m = re.match(
            r"^[\s>*#`-]*(?:NEXT[\s_-]+ACTION\s*:\s*|NEXT\s*:\s*|ACTION\s*:\s*)?"
            r"FETCH\s*:\s*(\S+)",
            first_line, re.IGNORECASE,
        )
        if m:
            return ("fetch", m.group(1).strip().strip("[]<>"))
        return None

    if keyword == "VERIFY_API":
        m = re.match(
            r"^[\s>*#`-]*(?:NEXT[\s_-]+ACTION\s*:\s*|NEXT\s*:\s*|ACTION\s*:\s*)?"
            r"VERIFY_API\s*:\s*(\S+)\s*\|\s*(\w+)",
            first_line, re.IGNORECASE,
        )
        if m:
            return ("verify_api", m.group(1).strip(), m.group(2).strip().lower())
        return None

    if keyword == "LOG_REJECTION":
        # Single-line: LOG_REJECTION: name | url | reason
        m = re.match(
            r"^[\s>*#`-]*(?:NEXT[\s_-]+ACTION\s*:\s*|NEXT\s*:\s*|ACTION\s*:\s*)?"
            r"LOG_REJECTION\s*:\s*(.+?)\s*$",
            first_line, re.IGNORECASE,
        )
        if m:
            inline = m.group(1).strip()
            if "|" in inline:
                parts = [p.strip() for p in inline.split("|")]
                if len(parts) >= 3:
                    return ("log_rejection", parts[0], parts[1],
                            "|".join(parts[2:]).strip())
                if len(parts) == 2:
                    return ("log_rejection", parts[0], parts[1], "no reason given")
        # Multi-line block: NAME / URL / REASON on subsequent lines
        name_m = re.search(r"^\s*NAME\s*:\s*(.+?)\s*$", block, re.IGNORECASE | re.MULTILINE)
        url_m = re.search(r"^\s*URL\s*:\s*(.+?)\s*$", block, re.IGNORECASE | re.MULTILINE)
        reason_m = re.search(r"^\s*REASON\s*:\s*(.+?)\s*$", block, re.IGNORECASE | re.MULTILINE)
        if name_m and url_m:
            reason = reason_m.group(1).strip() if reason_m else "no reason given"
            return ("log_rejection", name_m.group(1).strip(),
                    url_m.group(1).strip(), reason)
        return None

    if keyword == "LOG_CANDIDATE":
        fields = {}
        # Field names also accept lowercase or paraphrased shapes the LLMs emit.
        # Map of canonical key -> regex of accepted variants.
        for canonical, variants in (
            ("name",                    r"NAME"),
            ("url",                     r"URL"),
            ("region",                  r"REGION(?:AL[\s_-]+SCENE)?"),
            ("license_posture",         r"LICENSE[\s_-]?(?:POSTURE|POSITION)"),
            ("access_method",           r"ACCESS[\s_-]?METHOD"),
            ("audio_format",            r"AUDIO[\s_-]?FORMAT"),
            ("coverage",                r"COVERAGE"),
            ("cultural_posture",        r"CULTURAL[\s_-]?(?:POSTURE|POSITION)"),
            ("integration_difficulty", r"INTEGRATION[\s_-]?DIFFICULTY"),
            ("notes",                   r"NOTES"),
        ):
            m = re.search(
                rf"^\s*{variants}\s*:\s*(.+?)\s*$",
                block, re.IGNORECASE | re.MULTILINE,
            )
            if m:
                fields[canonical] = m.group(1).strip()
        if fields.get("name") and fields.get("url"):
            return ("log_candidate", fields)
        return None

    return None


# ------------------------------------------------------------------ #
#  AGENT LOOP                                                          #
# ------------------------------------------------------------------ #

def scout(model, max_turns, *, hours=None, until_convergence=False, smoke=False, mode=""):
    blocklist = load_blocklist()
    conn = db_open()

    session_id = str(uuid.uuid4())
    session_start(conn, session_id, model, mode)
    final_status = "running"

    deadline = time.time() + hours * 3600 if hours else None
    convergence_window = []
    # url -> full verify_api info dict (status, count, audio_indicators, ...)
    verified_results = {}

    user_kickoff = (
        "Begin scouting. The blocklist already excludes everything LumpyLP has "
        "integrated or rejected — you don't need to re-investigate those. Find "
        "new sources.\n\nStart by issuing one SEARCH action."
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_kickoff},
    ]

    candidates_logged = 0
    rejections_logged = 0
    turn = 0

    try:
        while turn < max_turns:
            # Pre-action stop conditions — checked BEFORE incrementing turn
            # so total_turns reflects turns actually executed, not started.
            if deadline and time.time() > deadline:
                console.print("\n[yellow]Hit --hours deadline. Stopping.[/yellow]")
                final_status = "timed_out"
                break

            if smoke and turn >= SMOKE_TURNS:
                console.print(
                    f"\n[green]Smoke test: completed {SMOKE_TURNS} turns.[/green]"
                )
                final_status = "completed"
                break

            turn += 1

            console.print(
                f"\n[dim]── Turn {turn}/{max_turns}  "
                f"(candidates: {candidates_logged}, rejections: {rejections_logged}) ──[/dim]"
            )

            # Snapshot the prompt we're about to send (for the JSONL record)
            messages_in_snapshot = [dict(m) for m in messages]
            t0 = time.time()
            response = chat_with_ollama(messages, model)
            elapsed_ms = int((time.time() - t0) * 1000)

            if not response:
                console.print("[red]Empty response — retrying.[/red]")
                jsonl_append({
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "session_id": session_id, "model": model,
                    "turn_number": turn,
                    "messages_in": messages_in_snapshot,
                    "response": "",
                    "action_parsed": None, "action_params": None,
                    "tool_result": None,
                    "elapsed_ms": elapsed_ms,
                })
                continue

            snippet = response if len(response) <= 600 else response[:600] + "..."
            console.print("[dim italic]AI:[/dim italic]")
            for ln in snippet.split("\n"):
                console.print(f"  [dim]{ln}[/dim]")

            actions = parse_actions(response)
            messages.append({"role": "assistant", "content": response})
            candidate_added_this_turn = False
            tool_result = None
            action_params = None

            # FIFO: dispatch the first action; the rest get summarized back to
            # the LLM as a "you queued these other actions" reminder, and the
            # LLM decides what to do next given the executed result.
            queued_summaries = []
            if actions:
                first, *queued = actions
                action = first[0]
                rest = list(first[1:])
                for q in queued:
                    queued_summaries.append(_summarize_action(q))
            else:
                action = None
                rest = []

            if action == "search":
                query = rest[0]
                action_params = {"query": query}
                console.print(f"[green]> SEARCH:[/green] {query}")
                results, n = tool_search(query, blocklist)
                log_search_row(conn, query, n)
                tool_result = {"result_count": n, "preview": results[:2000]}
                messages.append({
                    "role": "user",
                    "content": (
                        f"Search results ({n} after blocklist filter):\n\n"
                        f"{results}\n\nNext action."
                    ),
                })

            elif action == "fetch":
                url = rest[0]
                action_params = {"url": url}
                if is_blocked(url, blocklist):
                    console.print(f"[yellow]> FETCH blocked by blocklist:[/yellow] {url}")
                    tool_result = {"blocked": True}
                    messages.append({
                        "role": "user",
                        "content": "That URL is on the blocklist. Pick a different lead.",
                    })
                else:
                    console.print(f"[green]> FETCH:[/green] {url}")
                    body, status = tool_fetch(url)
                    tool_result = {"status": status, "preview": body[:2000]}
                    messages.append({
                        "role": "user",
                        "content": f"Fetch result:\n\n{body}\n\nNext action.",
                    })

            elif action == "verify_api":
                url, fmt = rest
                action_params = {"url": url, "format": fmt}
                if is_blocked(url, blocklist):
                    console.print(f"[yellow]> VERIFY_API blocked:[/yellow] {url}")
                    tool_result = {"blocked": True}
                    messages.append({
                        "role": "user",
                        "content": "That URL is on the blocklist. Pick a different lead.",
                    })
                else:
                    console.print(f"[green]> VERIFY_API:[/green] {url} ({fmt})")
                    info = tool_verify_api(url, fmt)
                    info["verified_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    verified_results[url] = info
                    tool_result = info
                    pretty = json.dumps(info, indent=2)[:2500]
                    messages.append({
                        "role": "user",
                        "content": (
                            f"verify_api result:\n\n{pretty}\n\n"
                            "If this looks viable, run LOG_CANDIDATE. "
                            "Otherwise LOG_REJECTION or move on."
                        ),
                    })

            elif action == "log_candidate":
                fields = rest[0]
                action_params = dict(fields)
                url = fields.get("url", "")
                name = fields.get("name", "")
                notes = fields.get("notes", "")
                if is_blocked(url, blocklist) or is_blocked(name, blocklist):
                    console.print(
                        f"[yellow]> LOG_CANDIDATE rejected — on blocklist:[/yellow] {name}"
                    )
                    tool_result = {"saved": False, "reason": "blocklist"}
                    messages.append({
                        "role": "user",
                        "content": "That source is on the blocklist. Don't re-log it.",
                    })
                else:
                    vinfo = verified_results.get(url)
                    eligible, reason = is_log_candidate_eligible(vinfo, notes)
                    if not eligible:
                        console.print(
                            f"[yellow]> LOG_CANDIDATE rejected — {reason}[/yellow]"
                        )
                        tool_result = {"saved": False, "reason": reason}
                        messages.append({
                            "role": "user",
                            "content": (
                                f"Log rejected — {reason}. "
                                "Run VERIFY_API again on a more specific endpoint, "
                                "add a quoted numeric claim to NOTES, or LOG_REJECTION."
                            ),
                        })
                    else:
                        vc = vinfo.get("count") if vinfo else None
                        vat = vinfo.get("verified_at") if vinfo else None
                        rc, msg = log_candidate_row(conn, fields, vc, vat)
                        candidates_logged += rc
                        if rc:
                            candidate_added_this_turn = True
                            console.print(
                                f"[green]> LOG_CANDIDATE saved:[/green] {name}  "
                                f"count={vc}  ({reason})"
                            )
                        else:
                            console.print(f"[red]> LOG_CANDIDATE failed: {msg}[/red]")
                        tool_result = {
                            "saved": bool(rc), "reason": reason,
                            "verified_count": vc, "db_message": msg,
                        }
                        messages.append({
                            "role": "user",
                            "content": (
                                f"Logged ({reason}). Bound verified_count={vc}. "
                                "Continue scouting or DONE."
                            ),
                        })

            elif action == "log_rejection":
                name, url, reason = rest
                action_params = {"name": name, "url": url, "reason": reason}
                log_rejection_row(conn, name, url, reason)
                rejections_logged += 1
                console.print(f"[yellow]> LOG_REJECTION:[/yellow] {name} — {reason}")
                tool_result = {"saved": True}
                messages.append({
                    "role": "user",
                    "content": "Logged rejection. Next action.",
                })

            elif action == "done":
                console.print("[green]> DONE.[/green]")
                final_status = "completed"
                # JSONL the DONE turn before breaking
                jsonl_append({
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "session_id": session_id, "model": model,
                    "turn_number": turn,
                    "messages_in": messages_in_snapshot,
                    "response": response,
                    "action_parsed": "done", "action_params": None,
                    "tool_result": None, "elapsed_ms": elapsed_ms,
                })
                session_progress(conn, session_id, turn, candidates_logged, rejections_logged)
                break

            else:
                console.print("[yellow]> No action parsed. Nudging.[/yellow]")
                tool_result = {"parse_failed": True}
                messages.append({
                    "role": "user",
                    "content": (
                        "I couldn't parse your response into an action. Respond with "
                        "exactly one of: SEARCH | FETCH | VERIFY_API | LOG_CANDIDATE | "
                        "LOG_REJECTION | DONE."
                    ),
                })

            # FIFO multi-action: if the LLM crammed multiple actions into one
            # response, append a reminder to the user message so it knows the
            # rest were not silently lost — it gets to reconsider in light of
            # what just happened.
            if queued_summaries and messages and messages[-1].get("role") == "user":
                queued_note = (
                    f"\n\nNOTE: your previous response contained {len(actions)} "
                    f"actions. I executed the first one. The other "
                    f"{len(queued_summaries)} action(s) you proposed were:\n"
                    + "\n".join(f"  - {s}" for s in queued_summaries)
                    + "\n\nReconsider these in light of the result above, then "
                      "respond with exactly one action."
                )
                messages[-1]["content"] = messages[-1]["content"] + queued_note
                console.print(
                    f"[cyan]> queued {len(queued_summaries)} additional action(s) "
                    f"as feedback to LLM[/cyan]"
                )

            # Always JSONL-log the turn
            jsonl_append({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "session_id": session_id, "model": model,
                "turn_number": turn,
                "messages_in": messages_in_snapshot,
                "response": response,
                "action_parsed": action,
                "action_params": action_params,
                "action_queue_len": len(actions),
                "queued_summaries": queued_summaries,
                "tool_result": tool_result,
                "elapsed_ms": elapsed_ms,
            })

            # Persist progress so a crash mid-loop doesn't lose the session row
            session_progress(conn, session_id, turn, candidates_logged, rejections_logged)

            # Convergence
            convergence_window.append(candidate_added_this_turn)
            if len(convergence_window) > CONVERGENCE_TURNS:
                convergence_window.pop(0)
            if (until_convergence
                    and len(convergence_window) == CONVERGENCE_TURNS
                    and not any(convergence_window)):
                console.print(
                    f"\n[yellow]Convergence: no new candidates in "
                    f"{CONVERGENCE_TURNS} turns. Stopping.[/yellow]"
                )
                final_status = "completed"
                break

            # Bound message history so context doesn't grow unbounded over hours
            if len(messages) > 64:
                messages = [messages[0]] + messages[-32:]

        else:
            # while-loop exited via condition (turn >= max_turns)
            if final_status == "running":
                final_status = "completed"

    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted by user (Ctrl-C).[/yellow]")
        final_status = "interrupted"
    except Exception as e:
        console.print(f"\n[red]Crashed: {e}[/red]")
        final_status = "crashed"
        raise
    finally:
        session_progress(conn, session_id, turn, candidates_logged, rejections_logged)
        session_end(conn, session_id, final_status)
        conn.close()

    return candidates_logged


# ------------------------------------------------------------------ #
#  REPORT                                                              #
# ------------------------------------------------------------------ #

def report():
    if not DB_PATH.exists():
        console.print(f"[yellow]No database at {DB_PATH} yet.[/yellow]")
        return

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM candidates"); cnum = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM rejections"); rnum = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM search_history"); snum = cur.fetchone()[0]

    console.print(Panel(
        f"Candidates: [cyan]{cnum}[/cyan]\n"
        f"Rejections: [cyan]{rnum}[/cyan]\n"
        f"Searches:   [cyan]{snum}[/cyan]",
        title="Liberate-Scout report",
    ))

    cur.execute("""
      SELECT name, region, verified_count, license_posture,
             integration_difficulty, cultural_posture
      FROM candidates
      ORDER BY (verified_count IS NULL), verified_count DESC, discovered_at DESC
      LIMIT 30
    """)
    rows = cur.fetchall()
    if rows:
        t = Table(title="Top 30 candidates")
        t.add_column("name")
        t.add_column("region")
        t.add_column("count")
        t.add_column("license")
        t.add_column("ease")
        t.add_column("posture")
        for name, region, count, lic, ease, posture in rows:
            t.add_row(
                str(name)[:40],
                str(region or "-")[:18],
                str(count if count is not None else "-"),
                str(lic or "-")[:30],
                str(ease or "-")[:14],
                str(posture or "-")[:14],
            )
        console.print(t)

    cur.execute(
        "SELECT name, reason FROM rejections ORDER BY rejected_at DESC LIMIT 15"
    )
    rejs = cur.fetchall()
    if rejs:
        t = Table(title="Recent rejections")
        t.add_column("name")
        t.add_column("reason")
        for name, reason in rejs:
            t.add_row(str(name or "-")[:40], str(reason or "-")[:60])
        console.print(t)

    conn.close()


# ------------------------------------------------------------------ #
#  MAIN                                                                #
# ------------------------------------------------------------------ #

def main():
    p = argparse.ArgumentParser(prog="liberate_scout")
    p.add_argument("--hours", type=float, default=None,
                   help="Run for at most N hours, then stop.")
    p.add_argument("--until-convergence", action="store_true",
                   help=f"Stop after {CONVERGENCE_TURNS} consecutive turns with no new candidate.")
    p.add_argument("--report", action="store_true",
                   help="Print a summary of scout.db and exit (no LLM calls).")
    p.add_argument("--smoke-test", action="store_true",
                   help=f"Run exactly {SMOKE_TURNS} LLM turns and exit.")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"Ollama model (default: {DEFAULT_MODEL}).")
    p.add_argument("--max-turns", type=int, default=MAX_TURNS_DEFAULT,
                   help=f"Hard cap on turns per session (default {MAX_TURNS_DEFAULT}).")
    args = p.parse_args()

    if args.report:
        report()
        return

    console.print(
        "[bold cyan]Liberate-Scout[/bold cyan]  "
        "[dim]autonomous CC/PD music source discovery[/dim]"
    )

    # Pre-flight: ollama reachable + requested model installed.
    if not ollama_alive():
        console.print("[red]ERROR: Ollama is not running at localhost:11434.[/red]")
        console.print(f"[yellow]Run:[/yellow] ollama serve")
        console.print(f"[yellow]Then:[/yellow] ollama pull {args.model}")
        sys.exit(1)
    ensure_model_installed(args.model)

    if args.smoke_test:
        mode_label = "smoke-test"
        mode_human = f"smoke test ({SMOKE_TURNS} turns)"
    elif args.hours:
        mode_label = "hours"
        mode_human = f"run for {args.hours}h"
    elif args.until_convergence:
        mode_label = "until-convergence"
        mode_human = f"until convergence ({CONVERGENCE_TURNS} dry turns)"
    else:
        mode_label = "max-turns"
        mode_human = f"up to --max-turns ({args.max_turns}) then stop"

    console.print(f"  model      = {args.model}")
    console.print(f"  db         = {DB_PATH}")
    console.print(f"  blocklist  = {BLOCKLIST_PATH}")
    console.print(f"  jsonl      = {JSONL_PATH}")
    console.print(f"  mode       = {mode_human}")

    n = scout(
        args.model,
        args.max_turns,
        hours=args.hours,
        until_convergence=args.until_convergence,
        smoke=args.smoke_test,
        mode=mode_label,
    )

    console.print(
        f"\n[bold]Session complete.[/bold]  Candidates logged: [cyan]{n}[/cyan]"
    )


if __name__ == "__main__":
    main()
