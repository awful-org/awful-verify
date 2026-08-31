/**
 * Rebuild what an instance declares, and compare it to what the instance
 * actually served.
 *
 * This is the strongest check the tool can make, and the only one that needs
 * no published hashes: the instance says which repository, which commit and
 * which plugins, so you build that yourself and diff. Nothing is trusted
 * except your own toolchain and source you can read.
 *
 * Deliberately NOT in core.mjs. That file runs unchanged in a browser, and
 * this one spawns git and pnpm - keeping them apart is what stops a browser
 * build from silently depending on Node.
 *
 * SECURITY: this executes the declared repository's build. `pnpm install`
 * runs whatever lifecycle scripts that tree contains, on your machine, as
 * you. An instance chooses the repository it points at, so the caller is
 * shown exactly what will be cloned and built, and a repository that is not
 * upstream is refused unless explicitly allowed. Fingerprinting is safe
 * against a hostile instance; rebuilding is not, and the difference must not
 * be blurred.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The project this tool is named after. */
export const UPSTREAM = "github.com/awful-org/awful.chat";

/** Long enough for a cold pnpm install and a full vite build. */
const STEP_TIMEOUT_MS = 20 * 60 * 1000;

async function step(cmd, args, opts = {}) {
  return run(cmd, args, {
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

/** Is this tool able to rebuild at all on this machine? */
export async function toolchainMissing() {
  const missing = [];
  for (const [cmd, args] of [
    ["git", ["--version"]],
    ["pnpm", ["--version"]],
  ]) {
    try {
      await step(cmd, args);
    } catch {
      missing.push(cmd);
    }
  }
  return missing;
}

/**
 * PLUGIN_SOURCES that reproduces the declared plugin set.
 *
 * In-tree plugins need no entry: they are in the commit being checked out.
 * A fetched plugin needs its source and ref, and several plugins commonly
 * come from ONE repository - listing that repository once is both correct
 * and what the operator originally wrote.
 */
export function pluginSources(plugins = []) {
  const seen = new Map();
  let unpinned = false;
  for (const p of plugins) {
    if (p?.origin !== "fetched" || !p.source) continue;
    if (!p.pinned) unpinned = true;
    // @, not #. This is handed straight to a child process so a # would
    // survive, but the same string is what a person copies into a .env to
    // reproduce a build by hand - and there it would be truncated at the #,
    // silently unpinning what they were trying to pin.
    const spec = p.pinned && p.ref ? `${p.source}@${p.ref}` : p.source;
    if (!seen.has(spec)) seen.set(spec, true);
  }
  return { sources: [...seen.keys()].join(","), unpinned };
}

/**
 * Every repository that went into this build, with a url to read it at.
 *
 * The point of the whole exercise. A match proves an instance runs exactly
 * these sources; it says nothing about whether the sources are safe, and the
 * only thing that can answer that is a person reading them. So the report
 * has to hand over somewhere to read, not just a green line.
 */
export function sourceLinks(claim) {
  const out = [
    {
      repo: claim.repository,
      ref: claim.commit,
      url: `https://${claim.repository}/tree/${claim.commit}`,
      provides: ["the app"],
      pinned: true,
    },
  ];
  const byRepo = new Map();
  for (const p of claim.plugins ?? []) {
    if (p?.origin !== "fetched" || !p.source) continue;
    const key = `${p.source}@${p.ref}`;
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: `github.com/${p.source}`,
        ref: p.ref,
        url: `https://github.com/${p.source}/tree/${p.ref}`,
        provides: [],
        pinned: !!p.pinned,
        declaredSha256: p.sha256 ?? null,
      });
    }
    byRepo.get(key).provides.push(p.id);
  }
  // In-tree plugins are part of the app's own repository, so they belong on
  // its line rather than inventing a source for them.
  const inTree = (claim.plugins ?? [])
    .filter((p) => p?.origin === "in-tree")
    .map((p) => p.id);
  if (inTree.length) out[0].provides.push(...inTree);
  return [...out, ...byRepo.values()];
}

/** Every file under dir, as paths relative to it with a leading slash. */
async function walk(dir, base = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Compare a built dist directory against a fingerprint of a live instance.
 *
 * The instance is the side that decides which paths matter: it is what
 * people actually load. A file present in the rebuild but never served is
 * reported separately rather than counted as a difference, because a build
 * emits things a server may legitimately not route.
 */
export async function compareToDist(fingerprintResult, distDir) {
  // The query is a cache-buster, and a path ending in "/" is the index the
  // server hands out for it. Applied in ONE place: computing notServed with
  // the raw paths instead reported index.html as built-but-never-served,
  // because the instance serves it as "/".
  const toFile = (urlPath) => {
    const rel = decodeURIComponent(urlPath.split("?")[0]);
    return rel.endsWith("/") ? `${rel}index.html` : rel;
  };
  const identical = [];
  const differing = [];
  const notBuilt = [];
  for (const f of fingerprintResult.files) {
    if (!f.hash) continue;
    const rel = toFile(f.path);
    const local = join(distDir, rel);
    try {
      if (!(await stat(local)).isFile()) throw new Error("not a file");
    } catch {
      notBuilt.push(f.path);
      continue;
    }
    ((await sha256File(local)) === f.hash ? identical : differing).push(f.path);
  }
  const servedPaths = new Set(fingerprintResult.files.map((f) => toFile(f.path)));
  const notServed = (await walk(distDir)).filter((p) => !servedPaths.has(p));
  // A bare count of unchecked files reads as a hole whether or not it is
  // one. What matters is whether any of them can RUN: an unfetched image or
  // robots.txt is nothing, an unfetched script is the whole point of the
  // tool going unexamined.
  const notServedExecutable = notServed.filter((p) =>
    /\.(?:js|mjs|css|wasm|html?)$/i.test(p)
  );
  return { identical, differing, notBuilt, notServed, notServedExecutable };
}

/**
 * Clone the declared source, build it, and diff against what was served.
 *
 * @param {object} result a fingerprint() result, for its claim and its files
 * @param {object} opts
 * @param {boolean} [opts.allowFork] build a repository that is not upstream
 * @param {(msg: string) => void} [opts.onStep] progress, one line per phase
 * @param {string} [opts.keep] keep the checkout at this path instead of a
 *   temp dir that is deleted, so a difference can be inspected afterwards
 */
export async function rebuild(result, opts = {}) {
  const { allowFork = false, onStep = () => {}, keep } = opts;
  const claim = result.claim;
  // Validated before it reaches git, symmetrically with the published-record
  // lookup. It is a single execFile argument so there is no shell to inject
  // into, but a value starting with "-" would be read as an option.
  if (claim?.commit && !/^[0-9a-f]{7,64}$/i.test(String(claim.commit))) {
    throw new Error(
      `this instance declares a commit that is not a sha: ${String(claim.commit).slice(0, 64)}`
    );
  }
  if (!claim?.repository || !claim?.commit) {
    throw new Error(
      "this instance does not declare a repository and commit, so there is " +
        "nothing to rebuild - /.well-known/awful-build.json is missing or " +
        "predates that field"
    );
  }
  if (claim.repository !== UPSTREAM && !allowFork) {
    throw new Error(
      `this instance declares ${claim.repository}, not ${UPSTREAM}.\n` +
        `  Rebuilding RUNS that repository's build scripts on your machine. ` +
        `Read it first, then pass --allow-fork if you want to proceed.`
    );
  }
  const missing = await toolchainMissing();
  if (missing.length) {
    throw new Error(
      `rebuilding needs ${missing.join(" and ")} on PATH. Without it, run ` +
        `without --rebuild to fingerprint the instance instead.`
    );
  }

  const dir = keep
    ? resolve(keep)
    : await mkdtemp(join(tmpdir(), "awful-verify-"));
  const cleanup = async () => {
    if (!keep) await rm(dir, { recursive: true, force: true });
  };

  try {
    const url = `https://${claim.repository}.git`;
    onStep(`cloning ${claim.repository}`);
    // Full history: the declared commit may be any ancestor, and a shallow
    // clone of the default branch would simply not contain it.
    await step("git", ["clone", "--quiet", url, dir]);
    onStep(`checking out ${String(claim.commit).slice(0, 8)}`);
    try {
      await step("git", ["-C", dir, "checkout", "--quiet", claim.commit]);
    } catch (err) {
      // The common cause is not a broken clone: the declared commit is
      // simply not there any more. A force-push to a deployed branch does
      // exactly this - the instance keeps serving a build whose source no
      // longer exists, and nobody can check it until it redeploys. Raw git
      // says "unable to read tree", which explains none of that.
      if (/unable to read tree|did not match any|unknown revision/i.test(String(err.stderr ?? err))) {
        throw new Error(
          `${claim.repository} has no commit ${claim.commit}.\n` +
            `  The instance is serving a build whose source is not in that ` +
            `repository - history rewritten since it deployed, a deleted ` +
            `branch, or a private fork it did not name. Nothing can verify ` +
            `it until it redeploys from a commit that exists.`
        );
      }
      throw err;
    }

    const frontend = join(dir, "frontend");
    const { sources, unpinned } = pluginSources(claim.plugins);
    const env = {
      ...process.env,
      PLUGIN_SOURCES: sources,
      // The declaration records what was built, including an unpinned
      // fetch. Refusing it here would make an unpinned instance
      // unrebuildable for a second reason, on top of the real one - that
      // what comes back may no longer be what it built.
      PLUGIN_SOURCES_ALLOW_UNPINNED: unpinned ? "1" : "",
      // Not set: the build resolves the commit from the checkout's own .git,
      // which is the whole point of having cloned it.
      APP_COMMIT: "",
    };

    onStep("installing dependencies");
    await step("pnpm", ["install", "--frozen-lockfile"], { cwd: frontend, env });
    let pluginBytes = null;
    if (sources) {
      onStep(`fetching plugins: ${sources}`);
      const { stdout } = await step("node", ["scripts/fetch-plugins.mjs"], {
        cwd: frontend,
        env,
      });
      // The declaration records the sha256 of each tarball that was fetched
      // when the instance was built. Comparing it to what we just fetched is
      // the one question it can answer: did this ref still resolve to the
      // same bytes? For a pinned ref that is a formality. For an unpinned
      // one it is the difference between "the plugin code has moved since
      // they deployed" and a mismatch nobody can explain.
      const got = new Set(
        [...stdout.matchAll(/tarball sha256:\s*([0-9a-f]{64})/g)].map((m) => m[1])
      );
      const declared = new Set(
        (claim.plugins ?? [])
          .filter((p) => p?.origin === "fetched" && p.sha256)
          .map((p) => p.sha256)
      );
      if (declared.size && got.size) {
        pluginBytes = [...declared].every((d) => got.has(d));
      }
    }
    onStep("building");
    await step("pnpm", ["build"], {
      cwd: frontend,
      env: { ...env, NODE_OPTIONS: "--max-old-space-size=4096" },
    });

    onStep("comparing");
    const diff = await compareToDist(result, join(frontend, "dist"));
    return {
      ...diff,
      dir: keep ? dir : null,
      unpinned,
      sources,
      pluginBytes,
      links: sourceLinks(claim),
    };
  } finally {
    await cleanup();
  }
}
