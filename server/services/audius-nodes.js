// Audius discovery-node pool with health tracking.
// Audius doesn't currently expose a public node-list endpoint
// (https://api.audius.co just self-points). We keep a hardcoded list of
// known providers; getDiscoveryNode() rotates and tracks per-node failures.
//
// When a single node fails (e.g. broken Postgres backend), we mark it for
// a cooldown window and pick another. When all nodes are cooled-off we
// fall back to round-robin so we still attempt something.

const COOLDOWN_MS = 60 * 1000;

// Hardcoded list. Edit when Audius's network rotates. The official
// providers are first; community-run / load-balanced entries follow.
const HARDCODED_NODES = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
  'https://api.audius.co',
];

let nodes = [...HARDCODED_NODES];
const failedAt = new Map(); // node URL -> ms timestamp of last failure
const usageCounter = new Map(); // for round-robin fallback
let lastRefresh = 0;

export function listNodes() {
  return [...nodes];
}

export function getDiscoveryNode() {
  const now = Date.now();
  const eligible = nodes.filter((n) => {
    const t = failedAt.get(n);
    return !t || (now - t) > COOLDOWN_MS;
  });
  if (eligible.length === 0) {
    // All nodes cooled off recently — pick the least-recently-failed and
    // try anyway. Audius might have recovered.
    const sorted = [...nodes].sort((a, b) => (failedAt.get(a) || 0) - (failedAt.get(b) || 0));
    return sorted[0];
  }
  // Random pick weighted by inverse usage (cheap load balancing).
  const idx = Math.floor(Math.random() * eligible.length);
  const pick = eligible[idx];
  usageCounter.set(pick, (usageCounter.get(pick) || 0) + 1);
  return pick;
}

export function markNodeFailed(url) {
  if (!url) return;
  failedAt.set(url, Date.now());
}

export function markNodeOk(url) {
  if (!url) return;
  failedAt.delete(url);
}

export function nodeStats() {
  const now = Date.now();
  return nodes.map((n) => ({
    node: n,
    cooled_off: failedAt.has(n) && (now - failedAt.get(n)) <= COOLDOWN_MS,
    last_failure_ago_s: failedAt.has(n) ? Math.round((now - failedAt.get(n)) / 1000) : null,
    used: usageCounter.get(n) || 0,
  }));
}

// Optional periodic refresh. Currently a no-op since Audius doesn't expose
// a node-list endpoint, but the structure is here so we can wire it up
// if/when one returns.
export async function refreshNodes() {
  if (Date.now() - lastRefresh < 30 * 60 * 1000) return;
  lastRefresh = Date.now();
  // Future: fetch a registry endpoint here, parse, replace `nodes`.
  nodes = [...HARDCODED_NODES];
}

// Wrap fetch with multi-node failover. Pass a path like "/v1/tracks/X/stream".
// On 5xx or network error, marks the node failed and retries with another.
// Returns the fetch Response (caller decides what to do with it) + the node
// URL that ultimately answered.
export async function fetchWithFailover(pathAndQuery, fetchInit = {}, maxAttempts = 3) {
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const node = getDiscoveryNode();
    if (tried.has(node)) {
      // All viable nodes already attempted in this call — bail out.
      break;
    }
    tried.add(node);
    const url = `${node}${pathAndQuery}`;
    try {
      const res = await fetch(url, fetchInit);
      if (res.status >= 500) {
        markNodeFailed(node);
        lastErr = new Error(`${node} → ${res.status}`);
        continue;
      }
      // Treat 4xx as authoritative — do not retry, but also don't blame the node.
      return { res, node };
    } catch (err) {
      markNodeFailed(node);
      lastErr = err;
    }
  }
  throw lastErr || new Error('all discovery nodes failed');
}
