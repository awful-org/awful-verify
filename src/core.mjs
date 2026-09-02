/**
 * Fingerprinting an awful.chat instance.
 *
 * Deliberately free of Node APIs and of the DOM: fetch and crypto.subtle
 * exist in both, so this same file backs the CLI and, later, a one-page
 * browser verifier. Everything platform-specific lives in the callers.
 */

/** Caps, because the thing being measured is not trusted. */
export const LIMITS = {
  /**
   * Assets to fetch. The precache manifest is ~28, but the walk below adds
   * everything the code can load on demand - ~300 shiki language chunks, ~70
   * themes, the wasm engines - so the real number is in the hundreds.
   */
  maxFiles: 2000,
  /** Total bytes to pull. A hostile instance must not be able to bill us. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Per-request bytes. */
  maxFileBytes: 32 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  /** Parallel fetches. Enough to be quick, few enough to be polite. */
  concurrency: 6,
};

export function normalizeOrigin(input) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported scheme: ${url.protocol}`);
  }
  return url.origin;
}

/**
 * Resolve a path from the instance's own manifest against its origin, and
 * refuse anything that leaves it.
 *
 * The list of files to check comes FROM the instance, so it is attacker
 * controlled. Without this an instance could point the tool at any URL on
 * the internet and have it fetched from the verifier's machine and its
 * bytes reported back - a scanner and an exfiltration path in one.
 */
export function sameOriginPath(origin, candidate) {
  let resolved;
  try {
    resolved = new URL(candidate, `${origin}/`);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;
  return resolved.pathname + resolved.search;
}

/**
 * Pull the precached asset paths out of a built service worker.
 *
 * Workbox inlines its manifest as an array of {revision, url} objects, and
 * this reads the urls back out of the minified result. Only the paths are
 * taken: the revision is workbox's own md5 of the same bytes, and trusting
 * a hash the instance supplies to check the instance would be circular.
 */
export function extractPrecachePaths(swSource) {
  const paths = [];
  const seen = new Set();
  for (const m of swSource.matchAll(/"url"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let url;
    try {
      url = JSON.parse(`"${m[1]}"`);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    paths.push(url);
  }
  return paths;
}

/**
 * Files worth reading for further references.
 *
 * HTML is in the list because index.html is where the app actually starts:
 * a page that quietly grew a second <script> would otherwise be hashed (it
 * is in the manifest, so the tampering does show) while the extra chunk it
 * pulls in never got fetched at all.
 */
function isScannable(path) {
  return /\.(?:js|mjs|css|html?)(?:\?|$)/i.test(path) || /\/$/.test(path);
}

/**
 * Same-origin asset paths referenced from inside a fetched file.
 *
 * The precache manifest is NOT the full list of code an instance can run.
 * The app deliberately keeps its big rarely-needed assets out of it - the
 * shiki language and theme chunks, the oniguruma wasm, the audio worklet -
 * and loads them on demand. They are named by content hash, but a name is
 * not a hash: nothing stops a server from putting different bytes behind
 * one. Hashing only the manifest would call an instance verified while
 * every lazily loaded chunk went unlooked at.
 *
 * So the file list is walked instead of trusted: whatever a fetched script
 * or stylesheet names, this asks for too, until nothing new turns up.
 *
 * `from` is the path the source was served at, because a chunk names its
 * siblings relatively ("./x-hash.js" inside /assets/index-hash.js is
 * /assets/x-hash.js, not /x-hash.js).
 */
export function extractAssetRefs(source, from = "/") {
  const dir = from.slice(0, from.lastIndexOf("/") + 1) || "/";
  const out = [];
  const seen = new Set();
  // The query is deliberately dropped. A cache-buster ("?v=844c74a2") names
  // the same file on any static host, and keeping it fetched the 8 MB audio
  // worklet twice - once bare, once with the buster the app appends.
  // Nothing is lost: the query lives in the bundle, which is hashed.
  const re = /["'`]([^"'`\s\\]{1,300}?\.(?:js|mjs|css|wasm))(?:\?[^"'`\s]{0,128})?["'`]/g;
  for (const m of source.matchAll(re)) {
    const ref = m[1];
    // Only path-shaped references are followed. A bare specifier
    // ("react.js") is a module id, and an absolute url belongs to somebody
    // else - a bundle is full of youtube and font urls, and listing them
    // would bury the one thing that matters here.
    if (!/^[./]/.test(ref)) continue;
    let resolved;
    try {
      resolved = new URL(ref, `https://x${dir}`);
    } catch {
      continue;
    }
    const path = resolved.pathname + resolved.search;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Is this response the SPA's catch-all index rather than the file asked for?
 *
 * Checked on the body as well as the header, because a static host can
 * serve the fallback with whatever content-type it likes.
 */
export function looksLikeSpaFallback(contentType = "", body = "") {
  if (/^text\/html\b/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html\b)/i.test(body);
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One digest standing for the whole instance.
 *
 * Over "path\0hash" lines, sorted, so it does not depend on the order the
 * files happened to be listed or fetched in. Two people comparing a single
 * short string is the entire point of the tool before any published
 * hashes exist.
 */
export async function overallDigest(files) {
  const body = files
    .filter((f) => f.hash)
    .map((f) => `${f.path}\0${f.hash}`)
    .sort()
    .join("\n");
  return sha256Hex(new TextEncoder().encode(body));
}

async function fetchWithLimits(url, { fetchImpl = fetch, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    LIMITS.requestTimeoutMs
  );
  if (signal) signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "*/*" },
    });
    if (!res.ok) return { status: res.status, bytes: null };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > LIMITS.maxFileBytes) {
      return { status: res.status, bytes: null, error: "file too large" };
    }
    return {
      status: res.status,
      bytes: buf,
      contentType: res.headers?.get?.("content-type") ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run tasks with a bounded number in flight. */
async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Fingerprint an instance: what it says it is, and what it actually served.
 *
 * Returns a plain object suitable for --json and for diffing against
 * another run. No verdict: v1 records, it does not judge, because there is
 * nothing published yet to judge against.
 */
export async function fingerprint(rawOrigin, opts = {}) {
  const { fetchImpl = fetch, onProgress } = opts;
  const origin = normalizeOrigin(rawOrigin);

  // The claim. Absent is a normal answer, not an error - no instance serves
  // this yet.
  let claim = null;
  let claimError = null;
  const claimRes = await fetchWithLimits(
    `${origin}/.well-known/awful-build.json`,
    { fetchImpl }
  ).catch((e) => ({ status: 0, bytes: null, error: String(e) }));
  if (claimRes.bytes) {
    const body = new TextDecoder().decode(claimRes.bytes);
    if (looksLikeSpaFallback(claimRes.contentType, body)) {
      // A single-page app answers 200 with index.html for every unknown
      // path, so a status code cannot tell "missing" from "present". Saying
      // "not valid JSON" here blamed the operator for a file they never
      // claimed to serve.
      claimError = "not declared (the app's index page was served instead)";
    } else {
      try {
        claim = JSON.parse(body);
      } catch {
        claimError = "declared build info is not valid JSON";
      }
    }
  } else {
    claimError = `not declared (HTTP ${claimRes.status})`;
  }

  const swRes = await fetchWithLimits(`${origin}/sw.js`, { fetchImpl });
  if (!swRes.bytes) {
    throw new Error(
      `Could not read ${origin}/sw.js (HTTP ${swRes.status}) - this may not be an awful.chat instance`
    );
  }
  const swText = new TextDecoder().decode(swRes.bytes);

  const paths = [];
  const skipped = [];
  for (const raw of extractPrecachePaths(swText)) {
    const p = sameOriginPath(origin, raw);
    if (p === null) {
      skipped.push(raw);
      continue;
    }
    if (paths.length >= LIMITS.maxFiles) break;
    paths.push(p);
  }
  // sw.js itself is part of what was served, and it is the file that names
  // all the others - leaving it unhashed would leave the list unverifiable.
  if (!paths.includes("/sw.js")) paths.unshift("/sw.js");

  let total = 0;
  let truncated = null;
  const files = [];
  const queued = new Set(paths);

  // Breadth-first over the reference graph. The manifest is only the seed:
  // each fetched script or stylesheet is read for the assets it names, and
  // those are fetched too, until a round turns up nothing new.
  let frontier = paths.map((path) => ({ path, source: "precache" }));
  while (frontier.length) {
    const round = await pooled(frontier, LIMITS.concurrency, async (item) => {
      const { path } = item;
      if (total > LIMITS.maxTotalBytes) {
        truncated ??= "byte budget";
        return { ...item, hash: null, error: "byte budget exhausted", bytes: 0 };
      }
      try {
        const res =
          path === "/sw.js"
            ? swRes
            : await fetchWithLimits(`${origin}${path}`, { fetchImpl });
        if (!res.bytes) {
          // A referenced path that is not there was never a file: the regex
          // that found it matched a string that only looked like one. A
          // MANIFEST path that is not there is a real finding, so only the
          // guesses are dropped.
          if (item.source === "referenced") return null;
          return {
            ...item,
            hash: null,
            error: res.error ?? `HTTP ${res.status}`,
            bytes: 0,
          };
        }
        const text = isScannable(path)
          ? new TextDecoder().decode(res.bytes)
          : null;
        // Same, for a host that answers every unknown path with the app page.
        if (
          item.source === "referenced" &&
          looksLikeSpaFallback(res.contentType, text ?? "")
        ) {
          return null;
        }
        total += res.bytes.byteLength;
        const hash = await sha256Hex(res.bytes);
        onProgress?.(path);
        return { ...item, hash, bytes: res.bytes.byteLength, text };
      } catch (e) {
        if (item.source === "referenced") return null;
        return { ...item, hash: null, error: String(e?.message ?? e), bytes: 0 };
      }
    });

    const next = [];
    for (const f of round) {
      if (!f) continue;
      const { text, ...record } = f;
      files.push(record);
      if (!text) continue;
      for (const raw of extractAssetRefs(text, f.path)) {
        const p = sameOriginPath(origin, raw);
        if (p === null) {
          skipped.push(raw);
          continue;
        }
        if (queued.has(p)) continue;
        if (queued.size >= LIMITS.maxFiles) {
          truncated ??= "file count";
          break;
        }
        queued.add(p);
        next.push({ path: p, source: "referenced" });
      }
    }
    frontier = next;
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    tool: "awful-verify/1",
    origin,
    fetchedAt: new Date().toISOString(),
    claim,
    claimError,
    skippedForeignUrls: skipped,
    files,
    // Never silently. A capped run has seen less than it looks like it has.
    truncated,
    totalBytes: files.reduce((n, f) => n + (f.bytes ?? 0), 0),
    digest: await overallDigest(files),
  };
}

/**
 * Where published build records live.
 *
 * Baked in, and never taken from the instance. An instance that could name
 * its own source of truth would simply point at hashes it wrote itself, and
 * the check would pass every time - so this is the one address in the tool
 * that a caller has to override deliberately.
 */
export const BUILDS_BASE =
  "https://raw.githubusercontent.com/awful-org/awful.chat/builds/builds";

/**
 * The published record for a commit, or null when there is none.
 *
 * Absent is a normal answer, not a failure: records only exist for commits
 * that reached main, so a fork, a branch deploy or an older instance simply
 * has none.
 */
export async function publishedRecord(commit, { fetchImpl = fetch, base = BUILDS_BASE } = {}) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(commit ?? ""))) return null;
  try {
    const res = await fetchWithLimits(`${base}/${commit}.json`, { fetchImpl });
    if (!res.bytes) return null;
    const body = new TextDecoder().decode(res.bytes);
    if (looksLikeSpaFallback(res.contentType, body)) return null;
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Does an instance's own plugin list match the one a record was built with?
 *
 * A record describes a commit AND a plugin set: plugins compile into the
 * app, so an instance running a different set is a different bundle and is
 * SUPPOSED not to match. Comparing digests without checking this would
 * report tampering where there is only configuration.
 */
export function samePluginSet(a = [], b = []) {
  const key = (list) =>
    (list ?? [])
      .map((p) =>
        [p.id, p.origin, p.source ?? "", p.ref ?? ""].join("@")
      )
      .sort()
      .join(",");
  return key(a) === key(b);
}

/**
 * Check a fingerprint against a published record.
 *
 * Returns what was compared as well as the verdict, because "verified" and
 * "no record exists for this configuration" are different answers and only
 * one of them is about the instance.
 */
export function checkAgainstRecord(result, record) {
  if (!record) return { status: "no-record" };
  if (record.digest === result.digest) return { status: "verified", record };

  // The digest decides, and it is compared FIRST. The plugin list lives in
  // the declaration, which the operator writes and which is not part of what
  // gets hashed - so testing it before the digest would let one invented
  // plugin entry turn a byte-level mismatch into a benign configuration
  // difference, with the served bytes never compared at all.
  //
  // A plugin set that differs is still worth saying: it is the innocent
  // explanation for a mismatch, and usually the true one. But it is the
  // instance's own unverified account of itself, so it rides along as a note
  // and is never a reason to stop looking.
  const configurationDiffers = !samePluginSet(
    result.claim?.plugins,
    record.plugins
  );
  const differing = [];
  const published = record.files ?? {};
  for (const f of result.files) {
    if (!f.hash) continue;
    const want = published[f.path];
    if (want === undefined) differing.push({ path: f.path, published: null, served: f.hash });
    else if (want !== f.hash) differing.push({ path: f.path, published: want, served: f.hash });
  }
  const servedPaths = new Set(result.files.map((f) => f.path));
  for (const path of Object.keys(published)) {
    if (!servedPaths.has(path)) {
      differing.push({ path, published: published[path], served: null });
    }
  }
  // A record is a build of the app's own repository, so it has no fetched
  // plugins in it. An instance that compiles some in cannot produce that
  // digest, at this commit or any other, and a difference therefore says
  // nothing about tampering. Reporting it as a mismatch cries wolf at every
  // instance that installed a plugin.
  //
  // It is NOT a pass. Nobody compared these bytes to anything, and the list
  // saying "I have plugins" is written by the operator - believing it far
  // enough to call the instance fine is exactly the bypass this ordering
  // exists to refuse. Inconclusive, and a rebuild settles it.
  const inRecord = new Set(
    (record.plugins ?? []).map((p) => `${p.id}@${p.origin}`)
  );
  const unbuilt = (result.claim?.plugins ?? []).filter(
    (p) => p?.origin === "fetched" && !inRecord.has(`${p.id}@${p.origin}`)
  );
  if (unbuilt.length) {
    return {
      status: "not-comparable",
      record,
      differing,
      configurationDiffers,
      unbuiltPlugins: unbuilt.map((p) => p.id),
    };
  }
  return { status: "mismatch", record, differing, configurationDiffers };
}

/**
 * Compare two fingerprints of the same origin.
 *
 * This is the part that catches an instance serving different code to
 * different people - the one attack a single lookup cannot see.
 */
export function compare(a, b) {
  const map = (r) => new Map(r.files.map((f) => [f.path, f.hash]));
  const [ma, mb] = [map(a), map(b)];
  const paths = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const differing = [];
  for (const p of paths) {
    const ha = ma.get(p) ?? null;
    const hb = mb.get(p) ?? null;
    if (ha !== hb) differing.push({ path: p, a: ha, b: hb });
  }
  return {
    sameOrigin: a.origin === b.origin,
    identical: a.digest === b.digest && differing.length === 0,
    differing,
  };
}
