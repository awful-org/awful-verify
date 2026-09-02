import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAssetRefs,
  compare,
  extractPrecachePaths,
  fingerprint,
  looksLikeSpaFallback,
  normalizeOrigin,
  overallDigest,
  sameOriginPath,
  sha256Hex,
} from "../src/core.mjs";

test("normalizeOrigin assumes https and keeps only the origin", () => {
  assert.equal(normalizeOrigin("chat.example.com"), "https://chat.example.com");
  assert.equal(
    normalizeOrigin("https://chat.example.com/app?x=1"),
    "https://chat.example.com"
  );
  assert.equal(normalizeOrigin("http://localhost:8000"), "http://localhost:8000");
  assert.throws(() => normalizeOrigin("ftp://example.com"), /Unsupported scheme/);
});

test("sameOriginPath refuses to leave the instance", () => {
  const o = "https://chat.example.com";
  // The file list comes FROM the instance. Without this it could aim the
  // tool at any host and have the bytes fetched and reported back.
  assert.equal(sameOriginPath(o, "/assets/index.js"), "/assets/index.js");
  assert.equal(sameOriginPath(o, "assets/x.js"), "/assets/x.js");
  assert.equal(sameOriginPath(o, "https://evil.example/x.js"), null);
  assert.equal(sameOriginPath(o, "//evil.example/x.js"), null);
  assert.equal(sameOriginPath(o, "http://chat.example.com/x.js"), null); // scheme differs
});

test("sameOriginPath keeps query strings, which are part of the url", () => {
  assert.equal(
    sameOriginPath("https://a.example", "/index.html?v=2"),
    "/index.html?v=2"
  );
});

test("extractPrecachePaths reads urls out of a workbox manifest", () => {
  const sw = 'x([{"revision":"abc","url":"index.html"},{"revision":null,"url":"assets/a-1.js"}])';
  assert.deepEqual(extractPrecachePaths(sw), ["index.html", "assets/a-1.js"]);
});

test("extractPrecachePaths dedupes and survives escapes", () => {
  const sw = '[{"url":"a.js"},{"url":"a.js"},{"url":"b\\u002Dc.js"}]';
  assert.deepEqual(extractPrecachePaths(sw), ["a.js", "b-c.js"]);
});

test("sha256Hex matches a known vector", async () => {
  // "abc" - the canonical NIST test vector.
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("overallDigest ignores the order files arrived in", async () => {
  const a = [
    { path: "/a", hash: "1" },
    { path: "/b", hash: "2" },
  ];
  const b = [
    { path: "/b", hash: "2" },
    { path: "/a", hash: "1" },
  ];
  assert.equal(await overallDigest(a), await overallDigest(b));
});

test("overallDigest changes when any hash changes", async () => {
  const before = await overallDigest([{ path: "/a", hash: "1" }]);
  const after = await overallDigest([{ path: "/a", hash: "2" }]);
  assert.notEqual(before, after);
});

test("overallDigest is not fooled by swapping paths and hashes", async () => {
  // The NUL separator is what stops "/ab" + "c" colliding with "/a" + "bc".
  const x = await overallDigest([{ path: "/ab", hash: "c" }]);
  const y = await overallDigest([{ path: "/a", hash: "bc" }]);
  assert.notEqual(x, y);
});

test("compare spots a file served differently to two people", () => {
  const a = {
    origin: "https://x.example",
    digest: "d1",
    files: [{ path: "/a.js", hash: "aaa" }],
  };
  const b = {
    origin: "https://x.example",
    digest: "d2",
    files: [{ path: "/a.js", hash: "bbb" }],
  };
  const diff = compare(a, b);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.differing, [{ path: "/a.js", a: "aaa", b: "bbb" }]);
});

test("compare spots a file present for one run and missing for the other", () => {
  const a = { origin: "o", digest: "d", files: [{ path: "/a", hash: "1" }] };
  const b = { origin: "o", digest: "d", files: [] };
  assert.deepEqual(compare(a, b).differing, [{ path: "/a", a: "1", b: null }]);
});

test("identical runs compare clean", () => {
  const r = {
    origin: "https://x.example",
    digest: "same",
    files: [{ path: "/a.js", hash: "aaa" }],
  };
  assert.equal(compare(r, structuredClone(r)).identical, true);
});

test("fingerprint refuses off-origin urls the instance asked for", async () => {
  const served = {
    "/sw.js": '[{"url":"/good.js"},{"url":"https://evil.example/bad.js"}]',
    "/good.js": "console.log(1)",
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (!(path in served)) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(served[path]).buffer,
    };
  };
  const r = await fingerprint("https://x.example", { fetchImpl });
  assert.deepEqual(r.skippedForeignUrls, ["https://evil.example/bad.js"]);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["/good.js", "/sw.js"]);
  assert.ok(r.digest);
});

test("fingerprint treats a missing build declaration as a normal answer", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/sw.js") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("[]").buffer,
      };
    }
    return { ok: false, status: 404 };
  };
  const r = await fingerprint("https://x.example", { fetchImpl });
  assert.equal(r.claim, null);
  assert.match(r.claimError, /not declared/);
});

test("fingerprint fails loudly when the origin serves no sw.js", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    () => fingerprint("https://x.example", { fetchImpl }),
    /may not be an awful\.chat instance/
  );
});

test("looksLikeSpaFallback spots the catch-all index", () => {
  // A single-page app answers 200 with index.html for unknown paths, so a
  // status code cannot tell "missing" from "present but malformed".
  assert.equal(looksLikeSpaFallback("text/html; charset=utf-8", ""), true);
  assert.equal(looksLikeSpaFallback("", "<!doctype html>\n<html>"), true);
  assert.equal(looksLikeSpaFallback("", "  <html lang=\"en\">"), true);
  assert.equal(looksLikeSpaFallback("application/json", '{"commit":"a"}'), false);
  assert.equal(looksLikeSpaFallback("", '{"commit":"a"}'), false);
});

test("fingerprint reports an SPA fallback as not declared, not as bad JSON", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const body = path === "/sw.js" ? "[]" : "<!doctype html><html></html>";
    return {
      ok: true,
      status: 200,
      headers: { get: () => (path === "/sw.js" ? "text/javascript" : "text/html") },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  const r = await fingerprint("https://x.example", { fetchImpl });
  assert.equal(r.claim, null);
  assert.match(r.claimError, /not declared/);
  assert.doesNotMatch(r.claimError, /valid JSON/);
});

test("extractAssetRefs resolves against the file that named them", () => {
  const src = [
    'import("./lazy-abc12345.js")',
    'new URL("./wasm/onig.wasm", import.meta.url)',
    'addModule("/audio-worklet.js?v=844c74a2")',
    'x="../langs/tsx-DEF.js"',
    'y="https://www.youtube.com/iframe_api.js"',
    'z="react.js"',
  ].join(";");
  assert.deepEqual(extractAssetRefs(src, "/assets/index-abc.js"), [
    "/assets/lazy-abc12345.js",
    "/assets/wasm/onig.wasm",
    // The cache-buster is dropped: it names the same file, and keeping it
    // fetched the 8 MB worklet twice.
    "/audio-worklet.js",
    "/langs/tsx-DEF.js",
  ]);
});

// The whole point of the walk. The service worker's manifest deliberately
// leaves out the on-demand chunks, so a tool that trusted it would call an
// instance verified while every lazily loaded script went unlooked at.
test("fingerprint follows what the code loads, not just the manifest", async () => {
  const served = {
    "/sw.js": '[{"url":"/assets/index-a.js"}]',
    "/assets/index-a.js": 'import("./lang-b.js");x="/worklet.js"',
    "/assets/lang-b.js": 'import("./deep-c.js")',
    "/assets/deep-c.js": "leaf",
    "/worklet.js": "wasm-ish",
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (!(path in served)) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(served[path]).buffer,
    };
  };
  const r = await fingerprint("https://x.example", { fetchImpl });
  assert.deepEqual(
    r.files.map((f) => f.path),
    [
      "/assets/deep-c.js",
      "/assets/index-a.js",
      "/assets/lang-b.js",
      "/sw.js",
      "/worklet.js",
    ]
  );
  assert.equal(r.files.filter((f) => f.source === "referenced").length, 3);
  assert.equal(r.truncated, null);
});

// A regex over minified JavaScript matches strings that only look like
// paths. Those are guesses, and a guess that 404s is not a finding - but a
// path the instance's OWN manifest named still is.
test("a guessed path that is not there is dropped, a declared one is reported", async () => {
  const served = {
    "/sw.js": '[{"url":"/assets/index-a.js"},{"url":"/gone.js"}]',
    "/assets/index-a.js": 'x="./not-a-file.js";y="./real-b.js"',
    "/assets/real-b.js": "b",
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/assets/not-a-file.js") {
      // A single-page host answers an unknown path with the app, not a 404.
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        arrayBuffer: async () =>
          new TextEncoder().encode("<!doctype html><html></html>").buffer,
      };
    }
    if (!(path in served)) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(served[path]).buffer,
    };
  };
  const r = await fingerprint("https://x.example", { fetchImpl });
  assert.deepEqual(
    r.files.map((f) => f.path),
    ["/assets/index-a.js", "/assets/real-b.js", "/gone.js", "/sw.js"]
  );
  const gone = r.files.find((f) => f.path === "/gone.js");
  assert.equal(gone.hash, null);
  assert.match(gone.error, /404/);
});

// index.html is where the app starts, so it is read for references too. A
// page that grew a second <script> is caught by its own hash either way, but
// the chunk it pulls in has to be fetched or the comparison never sees the
// code that was actually added.
test("an extra script in index.html pulls its chunk into the run", async () => {
  const served = {
    "/sw.js": '[{"url":"/index.html"},{"url":"/assets/app-a.js"}]',
    "/index.html":
      '<!doctype html><html><script type="module" src="/assets/app-a.js"></script>' +
      '<script src="/assets/extra-b.js"></script></html>',
    "/assets/app-a.js": "legit",
    "/assets/extra-b.js": "smuggled",
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (!(path in served)) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      headers: { get: () => (path.endsWith(".html") ? "text/html" : "text/javascript") },
      arrayBuffer: async () => new TextEncoder().encode(served[path]).buffer,
    };
  };
  const r = await fingerprint("https://x.example", { fetchImpl });
  assert.ok(r.files.some((f) => f.path === "/assets/extra-b.js" && f.hash));
});

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareToDist, pluginSources, rebuild } from "../src/rebuild.mjs";

test("pluginSources reproduces the declared set, one entry per repository", () => {
  // Several plugins commonly come from one repository, and listing it once
  // is both correct and what the operator originally wrote.
  const { sources, unpinned } = pluginSources([
    { id: "wheel", origin: "in-tree" },
    { id: "a", origin: "fetched", source: "o/r", ref: "d00d9db", pinned: true },
    { id: "b", origin: "fetched", source: "o/r", ref: "d00d9db", pinned: true },
  ]);
  // @, not #: this string is also what a person copies into a .env to
  // reproduce a build by hand, and there a # truncates it.
  assert.equal(sources, "o/r@d00d9db");
  assert.equal(unpinned, false);
});

// An unpinned instance is already unreproducible; refusing to try would hide
// that behind a second, unrelated failure.
test("pluginSources drops an unpinned ref and says so", () => {
  const { sources, unpinned } = pluginSources([
    { id: "a", origin: "fetched", source: "o/r", ref: "HEAD", pinned: false },
  ]);
  assert.equal(sources, "o/r");
  assert.equal(unpinned, true);
});

test("compareToDist separates matching, differing, and never-built files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rb-"));
  try {
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets/same.js"), "same");
    await writeFile(join(dir, "assets/other.js"), "LOCAL");
    await writeFile(join(dir, "assets/never-served.js"), "spare");
    await writeFile(join(dir, "robots.txt"), "nothing runnable");
    await writeFile(join(dir, "index.html"), "<html>");
    const hash = async (s) =>
      (await import("../src/core.mjs")).sha256Hex(new TextEncoder().encode(s));
    const result = {
      files: [
        { path: "/assets/same.js", hash: await hash("same") },
        { path: "/assets/other.js", hash: await hash("SERVED") },
        { path: "/assets/gone.js", hash: await hash("x") },
        // The server's index, and a cache-buster that names a real file.
        { path: "/", hash: await hash("<html>") },
      ],
    };
    const out = await compareToDist(result, dir);
    assert.deepEqual(out.identical, ["/assets/same.js", "/"]);
    assert.deepEqual(out.differing, ["/assets/other.js"]);
    assert.deepEqual(out.notBuilt, ["/assets/gone.js"]);
    assert.deepEqual(out.notServed.sort(), [
      "/assets/never-served.js",
      "/robots.txt",
    ]);
    // A bare count of unchecked files reads as a hole whether or not it is
    // one. An unfetched robots.txt is nothing; an unfetched script is the
    // tool's whole subject going unexamined.
    assert.deepEqual(out.notServedExecutable, ["/assets/never-served.js"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Rebuilding runs the declared repository's build scripts on this machine.
// Fingerprinting is safe against a hostile instance; this is not, and the
// difference must not be blurred by a flag nobody had to type.
test("rebuild refuses a fork unless it is explicitly allowed", async () => {
  const claim = { repository: "github.com/someone/evil", commit: "a".repeat(40) };
  await assert.rejects(
    () => rebuild({ claim, files: [] }),
    /not github\.com\/awful-org\/awful\.chat/
  );
});

test("rebuild refuses an instance that declares nothing to build", async () => {
  await assert.rejects(
    () => rebuild({ claim: null, files: [] }),
    /does not declare a repository and commit/
  );
});

import { checkAgainstRecord, publishedRecord, samePluginSet } from "../src/core.mjs";

// This test used to assert that a differing plugin set short-circuited to a
// soft "different-configuration" result. That WAS the behaviour, and it was
// a bypass: the plugin list is operator-written and unhashed, so one invented
// entry stopped the bytes being compared at all. The digest decides now, and
// the plugin difference rides along as an explanation - see the phantom
// plugin test below. Kept as a note so the old shape is not reintroduced.

test("samePluginSet ignores order but not identity", () => {
  const a = [
    { id: "x", origin: "fetched", source: "o/r", ref: "v1" },
    { id: "y", origin: "in-tree" },
  ];
  assert.ok(samePluginSet(a, [a[1], a[0]]));
  assert.ok(!samePluginSet(a, [{ ...a[0], ref: "v2" }, a[1]]));
});

test("a matching digest for the same plugin set verifies", () => {
  const result = { claim: { plugins: [] }, digest: "abc", files: [] };
  assert.equal(checkAgainstRecord(result, { plugins: [], digest: "abc" }).status, "verified");
});

// A mismatch has to say WHICH files, in both directions: served-but-not-
// published, and published-but-not-served.
test("a mismatch names the files, including ones that were never served", () => {
  const result = {
    claim: { plugins: [] },
    digest: "different",
    files: [
      { path: "/same.js", hash: "1" },
      { path: "/changed.js", hash: "2" },
      { path: "/extra.js", hash: "3" },
    ],
  };
  const record = {
    plugins: [],
    digest: "published",
    files: { "/same.js": "1", "/changed.js": "9", "/missing.js": "8" },
  };
  const out = checkAgainstRecord(result, record);
  assert.equal(out.status, "mismatch");
  assert.deepEqual(out.differing.map((d) => d.path).sort(), [
    "/changed.js",
    "/extra.js",
    "/missing.js",
  ]);
});

// Records only exist for commits that reached main, so a fork, a branch
// deploy or an older instance simply has none. That is not a failure.
test("no published record is a normal answer", async () => {
  const notFound = async () => ({ ok: false, status: 404 });
  assert.equal(await publishedRecord("a".repeat(40), { fetchImpl: notFound }), null);
  assert.equal(await publishedRecord(null, { fetchImpl: notFound }), null);
  // A host that answers unknown paths with html must not be parsed as one.
  const html = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    arrayBuffer: async () => new TextEncoder().encode("<!doctype html><html>").buffer,
  });
  assert.equal(await publishedRecord("a".repeat(40), { fetchImpl: html }), null);
});

// The lookup address must never come from the instance: one that could name
// its own source of truth would point at hashes it wrote itself.
test("a commit that is not a hex sha is never fetched", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: false, status: 404 };
  };
  assert.equal(await publishedRecord("../../evil", { fetchImpl: spy }), null);
  assert.equal(called, false);
});

// The bypass this ordering exists to prevent. The declaration is written by
// the operator and is not part of what gets hashed, so gating the digest
// comparison on the plugin set let one invented plugin entry turn a
// byte-level mismatch into a benign "different configuration" and exit 0 -
// without the served bytes ever being compared.
test("a phantom plugin cannot soften a digest mismatch", () => {
  const tampered = {
    claim: {
      plugins: [
        { id: "wheel", origin: "in-tree" },
        { id: "phantom", origin: "fetched", source: "who/cares", ref: "v1" },
      ],
    },
    digest: "TAMPERED",
    files: [{ path: "/assets/app.js", hash: "backdoored" }],
  };
  const record = {
    plugins: [{ id: "wheel", origin: "in-tree" }],
    digest: "GENUINE",
    files: { "/assets/app.js": "honest" },
  };
  const out = checkAgainstRecord(tampered, record);
  // Never "verified": the served bytes are not the published build, whatever
  // the declaration says about why.
  assert.notEqual(out.status, "verified");
  // The comparison still HAPPENED and its result is carried, so the report
  // can show what differs rather than waving the difference away. That is
  // the property the bypass broke - it returned before comparing at all.
  assert.deepEqual(out.differing.map((d) => d.path), ["/assets/app.js"]);
  assert.equal(out.configurationDiffers, true);
  // A declared plugin CI cannot have built makes the comparison
  // inconclusive rather than an accusation - an honest instance with a
  // plugin would otherwise be told 25 files are wrong. The exit code stays
  // non-zero either way, so this is not a pass.
  assert.equal(out.status, "not-comparable");
  assert.deepEqual(out.unbuiltPlugins, ["phantom"]);
});

// The honest case still has to read as benign: a self-hoster who added a
// plugin has a different bundle on purpose, and their digest legitimately
// differs from the canonical record.
test("a different plugin set with no record match is still a mismatch, flagged as such", () => {
  const out = checkAgainstRecord(
    { claim: { plugins: [{ id: "extra", origin: "in-tree" }] }, digest: "x", files: [] },
    { plugins: [], digest: "y", files: {} }
  );
  assert.equal(out.status, "mismatch");
  assert.equal(out.configurationDiffers, true);
});

// A matching digest is the end of the argument: the bytes ARE the published
// build, whatever the declaration says about plugins.
test("a matching digest verifies even if the declaration lies about plugins", () => {
  const out = checkAgainstRecord(
    { claim: { plugins: [{ id: "lie", origin: "in-tree" }] }, digest: "same", files: [] },
    { plugins: [], digest: "same" }
  );
  assert.equal(out.status, "verified");
});

test("rebuild refuses a commit that is not a sha", async () => {
  await assert.rejects(
    () =>
      rebuild({
        claim: { repository: "github.com/awful-org/awful.chat", commit: "--upload-pack=evil" },
        files: [],
      }),
    /not a sha/
  );
});

// Records are published for upstream only. Looking a fork's commit up there
// always misses, and reporting that as "no build has been published for this
// commit" reads as "not yet" when the truth is "never, and not here".
test("a fork is not looked up in upstream's build records", async () => {
  let fetched = false;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/awful-org/awful.chat/builds/")) fetched = true;
    if (path === "/.well-known/awful-build.json") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        arrayBuffer: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              repository: "github.com/someone/fork",
              commit: "a".repeat(40),
              plugins: [],
            })
          ).buffer,
      };
    }
    if (path === "/sw.js") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('[{"url":"/x.js"}]').buffer,
      };
    }
    if (path === "/x.js") {
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("x").buffer };
    }
    return { ok: false, status: 404 };
  };
  const r = await fingerprint("https://fork.example", { fetchImpl });
  assert.equal(r.claim.repository, "github.com/someone/fork");
  // fingerprint() itself must not reach for a record; that is the CLI's call,
  // and it declines for a fork.
  assert.equal(fetched, false);
});

// An instance that honestly installed plugins must not be told its files are
// wrong: CI builds this repository alone, so those digests can never agree,
// at this commit or any other.
test("an instance with fetched plugins is inconclusive, not accused", () => {
  const withPlugins = {
    claim: {
      plugins: [
        { id: "wheel", origin: "in-tree" },
        { id: "waffle-party", origin: "fetched", source: "o/r", ref: "d00d9db" },
      ],
    },
    digest: "different-because-of-the-plugin",
    files: [{ path: "/assets/app.js", hash: "with-plugin" }],
  };
  const record = {
    plugins: [{ id: "wheel", origin: "in-tree" }],
    digest: "ci-build",
    files: { "/assets/app.js": "without-plugin" },
  };
  const out = checkAgainstRecord(withPlugins, record);
  assert.equal(out.status, "not-comparable");
  assert.deepEqual(out.unbuiltPlugins, ["waffle-party"]);
});

// With no fetched plugins there is nothing to explain the difference, so it
// is a finding and has to read like one.
test("a plugin-free instance that differs is a mismatch", () => {
  const out = checkAgainstRecord(
    { claim: { plugins: [{ id: "wheel", origin: "in-tree" }] },
      digest: "tampered", files: [{ path: "/a.js", hash: "bad" }] },
    { plugins: [{ id: "wheel", origin: "in-tree" }],
      digest: "genuine", files: { "/a.js": "good" } }
  );
  assert.equal(out.status, "mismatch");
  assert.deepEqual(out.differing.map((d) => d.path), ["/a.js"]);
});
