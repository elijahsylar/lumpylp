"""
Liberate-Scout TEAM — two-model pipeline.

Phase A: phi4-mini scouts for leads (SEARCH + FETCH only). It identifies
         URLs that look like real CC/PD music sources but doesn't verify
         them. Leads are accumulated.
Phase B: llama3.1 takes the leads list and runs VERIFY_API / LOG_CANDIDATE /
         LOG_REJECTION on each. The disciplined-verifier role.

Reuses everything from liberate_scout.py (DB schema, blocklist, tools,
JSONL, eligibility rule, session tracking).

Usage:
    python3 liberate_scout_team.py --scout-turns 6 --verify-turns 10

Single round; exits when both phases are done. Long-run scheduling is the
single-model script's job; this is a one-shot pairing experiment.
"""

import os
import sys
import time
import json
import uuid
import sqlite3
import argparse
from pathlib import Path
from datetime import datetime, timezone

# Reuse the single-model engine wholesale.
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from liberate_scout import (  # noqa: E402
    chat_with_ollama,
    parse_actions,
    tool_search,
    tool_fetch,
    tool_verify_api,
    log_candidate_row,
    log_rejection_row,
    log_search_row,
    db_open,
    load_blocklist,
    is_blocked,
    is_log_candidate_eligible,
    jsonl_append,
    ollama_alive,
    ensure_model_installed,
    session_start,
    session_progress,
    session_end,
    DB_PATH,
    JSONL_PATH,
    BLOCKLIST_PATH,
    console,
)

SCOUT_MODEL_DEFAULT = "phi4-mini:latest"
VERIFY_MODEL_DEFAULT = "llama3.1:latest"

# --------------------------------------------------------------------- #
#  PHASE A — SCOUT (phi4-mini)                                          #
# --------------------------------------------------------------------- #

SCOUT_SYSTEM_PROMPT = """You are scouting for music archives — Creative Commons, public domain, regional/folk, DIY scenes (netlabels, mod scenes, chiptune crews, traditional archives nobody's bothered to index).

Your one job: FIND LEADS. URLs that might be interesting CC/PD music sources. You don't verify, you don't catalog. A separate disciplined verifier handles that afterwards. You hand off the list of URLs you visited or found promising.

Use only:

  SEARCH: <query>
  FETCH: <url>
  DONE

When you SEARCH, you get back the top 10 results. Pick the ones that smell real (regional archive, niche community, traditional/folk repository, DIY netlabel) and FETCH them to confirm the page exists and has the shape of a music source. Skip SEO bait, AI-music generators, royalty-free corporate stock music, anything that smells fake.

Your output is the trail of URLs you visited and the patterns you noticed. The verifier will get that as a leads list.

You are NOT trying to verify catalog size or license. The verifier does that. You are trying to find a handful of genuinely promising leads — quality over quantity — that are worth a verifier's attention.

Stop with DONE when you have ~5–10 strong leads or run out of fresh search angles.
"""

SCOUT_KICKOFF = (
    "Begin scouting. The blocklist excludes everything LumpyLP already indexes "
    "or has rejected. Find new leads. Start with one SEARCH action."
)

# --------------------------------------------------------------------- #
#  PHASE B — VERIFIER (llama3.1)                                        #
# --------------------------------------------------------------------- #

VERIFY_SYSTEM_PROMPT = """You are the disciplined verifier in a two-model music-archive scouting pipeline. A scout (phi4-mini) just spent some turns finding leads — URLs it thought looked like real CC/PD music sources. Now it's your job to take that list and either confirm or reject each lead with hard evidence.

For each lead:

  1. Run VERIFY_API: <url> | <format>   to check the actual API/feed
     (format = json | xml | html — try json first; if the body is HTML, try html)
  2. Based on the verify_api result, either:
       LOG_CANDIDATE  — if you have evidence of audio + a usable license
       LOG_REJECTION  — if it's defunct, rights-restricted, paywalled, etc.

A LOG_CANDIDATE is accepted ONLY if at least one of:
  (a) verify_api returned a numeric count > 0
  (b) verify_api returned 200 OK + audio indicators (audio/* content-type, or
      mp3/ogg/flac links in body, or <audio> tag)
  (c) NOTES contains a specific verification quote like "12,000 albums"

If you can't verify a lead one way or another after one or two API attempts,
LOG_REJECTION it with a clear reason ("API returned HTML, not JSON" /
"site appears defunct" / "stream-only, no download permission") so we have
the negative result on file.

Be willing to LOG_CANDIDATE — that's the value we want. The eligibility check
catches false positives. Don't be so cautious you reject everything; an
imperfect-but-evidenced candidate is more useful than a clean rejection.

Action protocol (one per response):

  VERIFY_API: <url> | <format>
  LOG_CANDIDATE:
  NAME: ...
  URL: ...
  REGION: ...
  LICENSE_POSTURE: ...
  ACCESS_METHOD: ...
  AUDIO_FORMAT: ...
  COVERAGE: ...
  CULTURAL_POSTURE: cleared | caution | avoid | research-required
  INTEGRATION_DIFFICULTY: easy | moderate | hard | research-required
  NOTES: ...
  LOG_REJECTION: <name> | <url> | <reason>
  DONE

Work through the leads list top to bottom. When you've processed them all
or hit obvious diminishing returns, DONE.
"""


def _verify_kickoff(leads):
    """Format the leads list as the initial user message for the verifier."""
    if not leads:
        return "The scout returned no leads. Just emit DONE."
    lines = ["The scout found these leads. Each is a URL it visited or saw "
             "in a search result that looked promising. Process them top to "
             "bottom — VERIFY_API → LOG_CANDIDATE/LOG_REJECTION."]
    lines.append("")
    for i, lead in enumerate(leads, 1):
        kind = lead["kind"]
        ctx = lead.get("context", "")
        lines.append(f"{i:>2}. [{kind:<14}] {lead['url']}")
        if ctx:
            lines.append(f"      context: {ctx[:120]}")
    lines.append("")
    lines.append("Start with VERIFY_API on lead #1 (or the most promising one).")
    return "\n".join(lines)


# --------------------------------------------------------------------- #
#  ORCHESTRATOR                                                          #
# --------------------------------------------------------------------- #

def run_scout_phase(model, max_turns, blocklist, conn, session_id):
    """Run phi4-mini in scout mode for up to max_turns. Return leads list."""
    console.print(f"\n[bold cyan]══ PHASE A: SCOUT ({model}) ══[/bold cyan]\n")
    leads = []  # [{kind, url, context}]
    seen_urls = set()
    messages = [
        {"role": "system", "content": SCOUT_SYSTEM_PROMPT},
        {"role": "user", "content": SCOUT_KICKOFF},
    ]

    for turn in range(1, max_turns + 1):
        console.print(f"[dim]── Scout T{turn}/{max_turns} ──[/dim]")
        t0 = time.time()
        response = chat_with_ollama(messages, model)
        elapsed_ms = int((time.time() - t0) * 1000)
        if not response:
            console.print("[red]empty scout response[/red]")
            continue

        snippet = response if len(response) <= 400 else response[:400] + "..."
        for ln in snippet.split("\n"):
            console.print(f"  [dim]{ln}[/dim]")

        actions = parse_actions(response)
        messages.append({"role": "assistant", "content": response})
        first_action = actions[0] if actions else None
        kind = first_action[0] if first_action else None

        if kind == "search":
            query = first_action[1]
            console.print(f"[green]> SEARCH:[/green] {query}")
            results, n = tool_search(query, blocklist)
            log_search_row(conn, query, n)
            # Snarf URLs from search results into the leads list
            for ln in results.split("\n"):
                m = ln.strip()
                if m.startswith("URL:"):
                    url = m.split("URL:", 1)[1].strip()
                    if url and url not in seen_urls and not is_blocked(url, blocklist):
                        seen_urls.add(url)
                        leads.append({
                            "kind": "search-hit",
                            "url": url,
                            "context": f"q: {query[:60]}",
                        })
            messages.append({
                "role": "user",
                "content": f"Search results ({n}):\n\n{results}\n\nNext action.",
            })

        elif kind == "fetch":
            url = first_action[1]
            if is_blocked(url, blocklist):
                console.print(f"[yellow]fetch blocked:[/yellow] {url}")
                messages.append({"role": "user",
                                 "content": "That URL is on the blocklist. Pick another."})
            else:
                console.print(f"[green]> FETCH:[/green] {url}")
                body, status = tool_fetch(url)
                if url not in seen_urls and not is_blocked(url, blocklist):
                    seen_urls.add(url)
                    # FETCH'd URL = stronger lead than a passive search-hit
                    leads.append({
                        "kind": "fetched",
                        "url": url,
                        "context": f"HTTP {status}, {len(body)} chars",
                    })
                else:
                    # Already in leads — promote to fetched
                    for ld in leads:
                        if ld["url"] == url and ld["kind"] == "search-hit":
                            ld["kind"] = "fetched"
                            ld["context"] = f"HTTP {status}, fetched in scout phase"
                messages.append({"role": "user",
                                 "content": f"Fetch result:\n\n{body}\n\nNext action."})

        elif kind == "done":
            console.print("[green]> DONE (scout phase)[/green]")
            jsonl_append({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "session_id": session_id, "model": model,
                "phase": "scout", "turn_number": turn,
                "messages_in": [dict(m) for m in messages[:-1]],
                "response": response,
                "action_parsed": "done", "action_params": None,
                "tool_result": None, "elapsed_ms": elapsed_ms,
            })
            break
        else:
            # Scout emitted VERIFY_API / LOG_CANDIDATE / LOG_REJECTION — out of role
            console.print("[yellow]> scout emitted a non-scout action; nudging[/yellow]")
            messages.append({"role": "user",
                             "content": ("In the scout phase, only SEARCH and FETCH "
                                         "are valid. Verification is the next phase. "
                                         "Emit one SEARCH or FETCH (or DONE).")})

        # JSONL the turn
        jsonl_append({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "session_id": session_id, "model": model,
            "phase": "scout", "turn_number": turn,
            "messages_in": [dict(m) for m in messages[:-2]],
            "response": response,
            "action_parsed": kind,
            "action_params": (first_action[1:] if first_action else None),
            "tool_result": None,
            "elapsed_ms": elapsed_ms,
        })

        if len(messages) > 40:
            messages = [messages[0]] + messages[-20:]

    # Promote fetched leads to the top, then search-hits
    leads.sort(key=lambda L: (0 if L["kind"] == "fetched" else 1))
    return leads


def run_verify_phase(model, max_turns, leads, blocklist, conn, session_id):
    """Run llama3.1 in verifier mode against the scout's leads list."""
    console.print(f"\n[bold cyan]══ PHASE B: VERIFY ({model}) ══[/bold cyan]\n")
    if not leads:
        console.print("[yellow]No leads to verify; skipping phase B.[/yellow]")
        return 0, 0

    messages = [
        {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
        {"role": "user", "content": _verify_kickoff(leads)},
    ]

    candidates_logged = 0
    rejections_logged = 0
    verified_results = {}

    for turn in range(1, max_turns + 1):
        console.print(f"[dim]── Verify T{turn}/{max_turns} ──[/dim]")
        t0 = time.time()
        response = chat_with_ollama(messages, model)
        elapsed_ms = int((time.time() - t0) * 1000)
        if not response:
            console.print("[red]empty verifier response[/red]")
            continue

        snippet = response if len(response) <= 600 else response[:600] + "..."
        for ln in snippet.split("\n"):
            console.print(f"  [dim]{ln}[/dim]")

        actions = parse_actions(response)
        messages.append({"role": "assistant", "content": response})
        first_action = actions[0] if actions else None
        kind = first_action[0] if first_action else None
        action_params = None
        tool_result = None

        if kind == "verify_api":
            url, fmt = first_action[1], first_action[2]
            action_params = {"url": url, "format": fmt}
            if is_blocked(url, blocklist):
                console.print(f"[yellow]verify_api blocked:[/yellow] {url}")
                tool_result = {"blocked": True}
                messages.append({"role": "user",
                                 "content": "That URL is on the blocklist. Pick another."})
            else:
                console.print(f"[green]> VERIFY_API:[/green] {url} ({fmt})")
                info = tool_verify_api(url, fmt)
                info["verified_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                verified_results[url] = info
                tool_result = info
                pretty = json.dumps(info, indent=2)[:2200]
                messages.append({"role": "user",
                                 "content": (f"verify_api result:\n\n{pretty}\n\n"
                                             "If viable, run LOG_CANDIDATE. "
                                             "Otherwise LOG_REJECTION or move on.")})

        elif kind == "log_candidate":
            fields = first_action[1]
            action_params = dict(fields)
            url = fields.get("url", "")
            name = fields.get("name", "")
            notes = fields.get("notes", "")
            if is_blocked(url, blocklist) or is_blocked(name, blocklist):
                console.print(f"[yellow]log_candidate blocked:[/yellow] {name}")
                tool_result = {"saved": False, "reason": "blocklist"}
                messages.append({"role": "user",
                                 "content": "That source is on the blocklist."})
            else:
                vinfo = verified_results.get(url)
                eligible, reason = is_log_candidate_eligible(vinfo, notes)
                if not eligible:
                    console.print(f"[yellow]log_candidate rejected ({reason})[/yellow]")
                    tool_result = {"saved": False, "reason": reason}
                    messages.append({"role": "user",
                                     "content": (f"Log rejected — {reason}. "
                                                 "Run VERIFY_API again, add a quoted "
                                                 "claim to NOTES, or LOG_REJECTION.")})
                else:
                    vc = vinfo.get("count") if vinfo else None
                    vat = vinfo.get("verified_at") if vinfo else None
                    rc, msg = log_candidate_row(conn, fields, vc, vat)
                    candidates_logged += rc
                    if rc:
                        console.print(f"[green]> LOG_CANDIDATE saved:[/green] {name}  count={vc}  ({reason})")
                    else:
                        console.print(f"[red]LOG_CANDIDATE failed: {msg}[/red]")
                    tool_result = {"saved": bool(rc), "reason": reason,
                                   "verified_count": vc}
                    messages.append({"role": "user",
                                     "content": (f"Logged ({reason}). count={vc}. "
                                                 "Continue with the next lead, or DONE.")})

        elif kind == "log_rejection":
            name, url, reason = first_action[1], first_action[2], first_action[3]
            action_params = {"name": name, "url": url, "reason": reason}
            log_rejection_row(conn, name, url, reason)
            rejections_logged += 1
            console.print(f"[yellow]> LOG_REJECTION:[/yellow] {name} — {reason}")
            tool_result = {"saved": True}
            messages.append({"role": "user",
                             "content": "Logged rejection. Continue with the next lead, or DONE."})

        elif kind == "done":
            console.print("[green]> DONE (verify phase)[/green]")
            jsonl_append({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "session_id": session_id, "model": model,
                "phase": "verify", "turn_number": turn,
                "messages_in": [dict(m) for m in messages[:-1]],
                "response": response,
                "action_parsed": "done", "action_params": None,
                "tool_result": None, "elapsed_ms": elapsed_ms,
            })
            break

        else:
            console.print("[yellow]verifier produced unparseable / non-verifier action[/yellow]")
            tool_result = {"parse_failed": True}
            messages.append({"role": "user",
                             "content": ("Couldn't parse, or the action wasn't one of "
                                         "VERIFY_API / LOG_CANDIDATE / LOG_REJECTION / "
                                         "DONE. Try again with a single action.")})

        jsonl_append({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "session_id": session_id, "model": model,
            "phase": "verify", "turn_number": turn,
            "messages_in": [dict(m) for m in messages[:-2]],
            "response": response,
            "action_parsed": kind,
            "action_params": action_params,
            "tool_result": tool_result,
            "elapsed_ms": elapsed_ms,
        })

        session_progress(conn, session_id, turn, candidates_logged, rejections_logged)

        if len(messages) > 40:
            messages = [messages[0]] + messages[-20:]

    return candidates_logged, rejections_logged


def main():
    p = argparse.ArgumentParser(prog="liberate_scout_team")
    p.add_argument("--scout-model", default=SCOUT_MODEL_DEFAULT)
    p.add_argument("--verify-model", default=VERIFY_MODEL_DEFAULT)
    p.add_argument("--scout-turns", type=int, default=6)
    p.add_argument("--verify-turns", type=int, default=10)
    args = p.parse_args()

    console.print("[bold cyan]Liberate-Scout TEAM[/bold cyan]  "
                  "[dim]two-model pipeline (phi4 scout → llama3.1 verifier)[/dim]")
    console.print(f"  scout      = {args.scout_model}  ({args.scout_turns} turns max)")
    console.print(f"  verifier   = {args.verify_model}  ({args.verify_turns} turns max)")
    console.print(f"  db         = {DB_PATH}")
    console.print(f"  jsonl      = {JSONL_PATH}")
    console.print(f"  blocklist  = {BLOCKLIST_PATH}")

    if not ollama_alive():
        console.print("[red]Ollama not reachable.[/red]")
        sys.exit(1)
    ensure_model_installed(args.scout_model)
    ensure_model_installed(args.verify_model)

    blocklist = load_blocklist()
    conn = db_open()
    session_id = str(uuid.uuid4())
    session_start(conn, session_id, f"{args.scout_model}+{args.verify_model}", "team")
    final_status = "running"

    try:
        leads = run_scout_phase(args.scout_model, args.scout_turns,
                                blocklist, conn, session_id)
        console.print(
            f"\n[bold]Scout phase complete:[/bold] {len(leads)} unique leads "
            f"({sum(1 for L in leads if L['kind']=='fetched')} fetched, "
            f"{sum(1 for L in leads if L['kind']=='search-hit')} search-hits)\n"
        )

        c, r = run_verify_phase(args.verify_model, args.verify_turns, leads,
                                blocklist, conn, session_id)
        console.print(f"\n[bold]Verify phase complete:[/bold] {c} candidates, {r} rejections")

        final_status = "completed"

    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted.[/yellow]")
        final_status = "interrupted"
    except Exception as e:
        console.print(f"\n[red]Crashed: {e}[/red]")
        final_status = "crashed"
        raise
    finally:
        session_end(conn, session_id, final_status)
        conn.close()


if __name__ == "__main__":
    main()
