#!/usr/bin/env node
/**
 * awful-verify - fingerprint an awful.chat instance.
 *
 * All the logic lives in core.mjs, which runs unchanged in a browser. This
 * file is argv, colour and exit codes.
 */
import { readFile } from "node:fs/promises";
import {
  checkAgainstRecord,
  compare,
  fingerprint,
  publishedRecord,
} from "./core.mjs";
import { rebuild, toolchainMissing, UPSTREAM } from "./rebuild.mjs";

const ESC = "\u001b[";
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (USE_COLOR ? ESC + code + "m" + s + ESC + "0m" : s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const red = (s) => paint("31", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);

const USAGE = `awful-verify - check that an awful.chat instance runs the code it says it runs

  awful-verify <origin>                   verify: rebuild its sources and diff
  awful-verify <origin> --no-rebuild      fingerprint only, no toolchain needed
  awful-verify <origin> --json            machine-readable, for saving
  awful-verify --compare a.json b.json    diff two saved fingerprints

THE PROBLEM

  A web app is delivered fresh from its server on every visit. Whatever its
  source repository says, the server can send you something else - to
  everyone, to you specifically, or only sometimes. Reading the source cannot
  detect that. The only thing that can is comparing the bytes you were served
  against the bytes that source produces.

WHAT IT DOES, BY DEFAULT

  An instance declares what it was built from at
  /.well-known/awful-build.json: a repository, a commit, and every plugin
  compiled into it with the repository and ref it came from.

  That is a build recipe, so this executes it. Clone the app at that commit,
  fetch those plugins at those refs, build, and compare the result against
  every file the instance actually served. Match, and the instance is running
  exactly what it declares.

  The declaration is untrusted - an operator writes it, and it is not part of
  what gets hashed. It does not need to be trusted, because the rebuild
  settles it: an instance that under-declares a plugin builds a bundle
  without that plugin and fails to match. Lying in it buys nothing.

  Needs git, pnpm and node on PATH, a few minutes, and a few hundred MB of
  dependencies. Without them, use --no-rebuild.

    --allow-fork    build a repository that is not the upstream one
    --keep <dir>    keep the checkout, to inspect a difference
    --no-rebuild    skip it, and just fingerprint

  IT RUNS THE DECLARED REPOSITORY'S BUILD. pnpm install executes whatever
  lifecycle scripts that tree contains, on your machine, as you.
  Fingerprinting alone is safe against a hostile instance; this is not, which
  is why a repository that is not upstream is refused until you pass
  --allow-fork, having read what you are about to build.

WHAT IS NOT CHECKED

  The app, not the servers behind it. This hashes what a browser downloads.
  An instance also runs a relay (peer discovery, offline mailbox, link
  previews), an SFU (video and screen sharing - it can see the streams it
  routes; voice does not pass through it), and a TURN server (relays call
  media between peers that cannot connect directly). None of them serve
  files to hash, so none of them are visible here.

  Their addresses come from /config.json, which is deliberately excluded
  from the digest because those values are supposed to differ between
  instances. So an instance can point at any relay, SFU or TURN server and
  still verify perfectly. Verifying the code tells you what the page will
  do, not where the operator sends what leaves it. Read /config.json
  yourself if that matters.

WHAT A MATCH PROVES

  That the instance runs exactly the sources it names. Not that those sources
  are safe - no hash can tell you that. So the report ends with a link to
  every repository that went into the build, which is the part a person has
  to read.

  Two of those links deserve attention on sight:

    - a repository that is not the upstream one. Forks are legitimate, but a
      fork's operator controls both the instance and the source it is checked
      against, so a match there proves the code is READABLE, not trustworthy.
    - a plugin not pinned to a commit sha. Only a sha names bytes: a tag or
      a branch can be moved afterwards, and that one looks pinned to
      whoever wrote it. The declaration records each fetched tarball's
      sha256, so code that has moved since the instance was built is
      reported too.

  A difference cannot be attributed to one component. Plugins compile INTO
  the app, so everything shares a bundle: you learn that something does not
  match, and which files, not whose fault it is.

HOW THE FILE LIST IS BUILT

  1. /sw.js carries the service worker's precache manifest - the app's own
     list of what it installs, about 30 files. Only the paths are taken from
     it; trusting a hash the instance supplies to check the instance would be
     circular.
  2. Every script, stylesheet and html page fetched is read for the assets IT
     names, and those are fetched too, until a round turns up nothing new.
     The manifest is only the install payload - the app keeps its big
     on-demand pieces out of it, around 300 syntax-highlighting chunks, the
     wasm engines, an 8 MB audio worklet. All executable, all named by
     content hash, and a name is not a hash. This takes the list from about
     30 files to about 330.
  3. Minified JavaScript contains strings that merely look like paths. One
     that turns out not to exist is a bad guess and is dropped; a path the
     manifest declared and cannot serve is reported.

  Only same-origin paths are ever fetched: the list comes from the thing
  being measured, so an instance could otherwise have your machine fetch any
  url on the internet. There are caps on file count, per-file size and total
  bytes for the same reason, and a run that hits one says so.

WITHOUT A TOOLCHAIN

  Every commit on the project's main branch is built by its CI, which
  publishes the hash of every file that build serves. This looks that record
  up for the commit an instance declares, on every run, and reports it
  alongside whatever else it did. For somebody who trusts the project's
  source and does not want to install anything, that alone answers the
  question.

  It is a different statement from a rebuild, not a weaker one: the record
  says GitHub Actions built this commit into these bytes, a rebuild says this
  source builds into these bytes on your machine. The address the records
  come from is compiled in and never taken from the instance - one that could
  name its own source of truth would point at hashes it wrote itself.

  A record describes a commit AND a plugin set, so an instance running a
  different set is reported as not covered rather than as a mismatch. A fork
  is not looked up at all: records are published for the upstream repository
  only, so a fork's commit would always miss, and rebuilding is the check
  that applies to it. --no-published skips the lookup.

  --no-rebuild fingerprints and stops: every file hashed, reduced to one
  digest over "path\0hash" sorted, so it does not depend on fetch order. That
  is not a verdict on its own, but two people can compare:

    awful-verify chat.example.com --no-rebuild --json > mine.json
    awful-verify --compare mine.json theirs.json

  Different digests mean one of you was served something the other was not -
  the one attack no number of solo runs can see.

  The digest excludes /config.json, which holds the instance's own relay and
  SFU addresses. Those are supposed to differ between instances; keeping them
  out of the compiled bundle is what lets two instances of one build match at
  all.

Options:
  --no-rebuild    fingerprint only; do not build anything
  --no-published  skip the published-build lookup
  --allow-fork    build a repository that is not the upstream one
  --keep <dir>    keep the rebuild checkout for inspection
  --json          emit JSON instead of a report
  -h, --help      this
`;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function report(result) {
  const ok = result.files.filter((f) => f.hash);
  const failed = result.files.filter((f) => !f.hash);

  console.log(`\n  ${bold(result.origin)}`);
  console.log(dim(`  fetched ${result.fetchedAt}\n`));

  if (result.claim) {
    const { commit, version, repository, plugins } = result.claim;
    console.log(
      `  ${"claims".padEnd(10)} ${repository ?? dim("no repository")} @ ${
        commit ? String(commit).slice(0, 8) : dim("no commit")
      }${version ? dim(` v${version}`) : ""}`
    );
    // Not upstream. Said plainly, because "matches its own source" is a
    // weaker statement than it looks: whoever runs this instance also
    // controls the repository it points at, so a rebuild proves the code is
    // READABLE, not that anybody has read it.
    if (repository && repository !== UPSTREAM) {
      console.log(
        `  ${"".padEnd(10)} ${yellow("fork")} not ${UPSTREAM} - read what it changed before trusting it`
      );
    }
    for (const p of Array.isArray(plugins) ? plugins : []) {
      const where =
        p.origin === "fetched"
          ? `${p.source ?? "?"}@${p.ref ?? "?"}`
          : "in this repository";
      // An unpinned fetch cannot be reproduced once that repo's HEAD moves:
      // the sha256 proves you got different bytes, it cannot get you the
      // right ones. Worth flagging on the instance, not just in the docs.
      // Four states. They all end in "cannot be rebuilt from this later",
      // but they are different mistakes: a moving ref looks pinned to
      // whoever wrote it, and a local directory is not fetchable by anyone
      // at all.
      const pin =
        p.origin !== "fetched" || p.pinned
          ? ""
          : p.ref === "local"
            ? yellow(" built from a directory on the build machine")
            : !p.ref || p.ref === "HEAD"
              ? yellow(" no ref - whatever the default branch held")
              : yellow(` ${p.ref} is a tag or branch, not a sha - can move`);
      console.log(
        `  ${"".padEnd(10)} ${dim("plugin")} ${(p.id ?? "?").padEnd(16)} ${dim(
          where
        )}${pin}`
      );
    }
  } else {
    console.log(`  ${"claims".padEnd(10)} ${dim(result.claimError)}`);
  }

  const walked = ok.filter((f) => f.source === "referenced").length;
  console.log(
    `  ${"files".padEnd(10)} ${ok.length} hashed, ${fmtBytes(
      result.totalBytes
    )}${failed.length ? red(`, ${failed.length} unreadable`) : ""}`
  );
  if (walked) {
    // Worth saying out loud: most of these are not in the service worker's
    // manifest, they were found by reading the code that loads them.
    console.log(
      `  ${"".padEnd(10)} ${dim(
        `${ok.length - walked} from the precache manifest, ${walked} found by following what the code loads`
      )}`
    );
  }
  if (result.truncated) {
    console.log(
      `  ${"".padEnd(10)} ${yellow("!")} stopped early (${
        result.truncated
      } limit) - this run did NOT see the whole app`
    );
  }
  for (const f of failed) {
    console.log(`  ${"".padEnd(10)} ${red("!")} ${f.path} ${dim(f.error)}`);
  }
  if (result.skippedForeignUrls.length) {
    // Not a warning to bury: the instance asked us to fetch somewhere else.
    console.log(
      `  ${"".padEnd(10)} ${yellow("!")} ${
        result.skippedForeignUrls.length
      } off-origin url(s) in the manifest, not fetched`
    );
  }

  console.log(`\n  ${bold("digest")}     ${green(result.digest)}\n`);
}

function reportRebuild(out, result) {
  const matched = out.identical.length;
  const failed = out.differing.length + out.notBuilt.length;
  const withheld = (out.notServedExecutable ?? []).length;
  console.log("");
  if (!failed && !withheld) {
    console.log(
      `  ${green("verified")}   ${matched} files, byte-identical to a build of ` +
        `everything\n             this instance declares`
    );
  } else if (!failed) {
    console.log(
      `  ${yellow("INCOMPLETE")} ${matched} served files match, but the build produced ` +
        `${withheld}\n             executable file(s) this instance would not serve`
    );
  } else {
    console.log(
      `  ${red("MISMATCH")}   ${matched} of ${
        matched + failed
      } served files match a build of that commit`
    );
    for (const p of out.differing) console.log(`    ${red("differs")}  ${p}`);
    for (const p of out.notBuilt) console.log(`    ${red("extra")}    ${p} ${dim("(served, not produced by the build)")}`);
  }
  if (out.notServed.length) {
    // Not a finding on its own: a build emits things a server may
    // legitimately not route. Said out loud so the report never implies the
    // whole build was checked - and split by whether any of it can run,
    // because an unfetched image and an unfetched script are not the same
    // news.
    const exe = out.notServedExecutable ?? [];
    console.log(
      dim(
        `             ${out.notServed.length} built file(s) were never served, so not checked`
      ) +
        (exe.length
          ? ` ${red(`- ${exe.length} of them executable`)}`
          : dim(" (none of them executable)"))
    );
    for (const p of exe) console.log(`             ${red("!")} ${p}`);
  }
  if (out.unpinned) {
    console.log(
      `  ${yellow("!")}          this instance pins no plugin ref, so the plugin code ` +
        `just\n             built is whatever that repository holds NOW, not ` +
        `necessarily\n             what the instance was built from`
    );
  }
  if (out.dir) console.log(dim(`             checkout kept at ${out.dir}`));

  // The audit surface. A match says the instance runs exactly these sources;
  // whether the sources are safe is a question only a person reading them
  // can answer, so the report ends by saying where to read.
  console.log(`\n  ${bold("sources")}`);
  for (const l of out.links) {
    const what = l.provides.join(", ");
    console.log(
      `    ${l.repo} ${dim("@")} ${String(l.ref).slice(0, 12)}${
        l.pinned ? "" : yellow(" (unpinned)")
      }`
    );
    console.log(`      ${dim(what)}`);
    console.log(`      ${l.url}`);
  }
  if (out.pluginBytes === false) {
    console.log(
      `\n  ${yellow("!")}  the plugin code fetched now is NOT the code this instance was\n` +
        `     built from - that repository has moved since it deployed`
    );
  }
  console.log(
    dim(
      "\n  A match proves this instance runs exactly these sources. It does not\n" +
        "  say the sources are safe. That is what the links are for.\n"
    )
  );
}

function reportCompare(diff, a, b) {
  console.log("");
  if (!diff.sameOrigin) {
    console.log(
      `  ${yellow("!")} different origins: ${a.origin} vs ${b.origin}\n`
    );
  }
  if (diff.identical) {
    console.log(`  ${green("identical")} - both runs saw the same code\n`);
    return 0;
  }
  console.log(`  ${red("DIFFERENT")} - these runs did not see the same code\n`);
  for (const d of diff.differing) {
    console.log(`  ${d.path}`);
    console.log(`    a  ${d.a ?? dim("(missing)")}`);
    console.log(`    b  ${d.b ?? dim("(missing)")}`);
  }
  console.log("");
  return 1;
}

async function main(argv) {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    console.log(USAGE);
    return 0;
  }

  if (argv[0] === "--compare") {
    const [, x, y] = argv;
    if (!x || !y) {
      console.error("--compare needs two json files");
      return 2;
    }
    const [a, b] = await Promise.all([
      readFile(x, "utf8").then(JSON.parse),
      readFile(y, "utf8").then(JSON.parse),
    ]);
    return reportCompare(compare(a, b), a, b);
  }

  const json = argv.includes("--json");
  const origin = argv.find((a) => !a.startsWith("-"));
  if (!origin) {
    console.error("give me an instance origin, e.g. chat.example.com");
    return 2;
  }

  const result = await fingerprint(origin);

  // One fetch, when it can mean anything. Records are published for upstream
  // only, so looking a fork's commit up there answers a question nobody
  // asked: it would always miss, and "no build has been published for this
  // commit" reads as "not yet" when the truth is "never, and not here".
  const declaredRepo = result.claim?.repository;
  const foreign = declaredRepo && declaredRepo !== UPSTREAM;
  const record =
    argv.includes("--no-published") || foreign
      ? null
      : await publishedRecord(result.claim?.commit);
  const published = foreign
    ? { status: "not-upstream", repository: declaredRepo }
    : checkAgainstRecord(result, record);



  const why = await cannotRebuild(result, argv);
  if (json && why) {
    console.log(JSON.stringify({ ...result, published }, null, 2));
  } else if (!json) {
    report(result);
    reportPublished(published, result);
  }

  // Rebuilding is the DEFAULT, because it is the only mode that answers the
  // question people actually have. Fingerprinting alone produces a number
  // with nothing to compare it to. Skipped only when it cannot work, or
  // when asked.
  if (!why) {
    const keepAt = argv[argv.indexOf("--keep") + 1];
    let out;
    try {
      out = await rebuild(result, {
        allowFork: argv.includes("--allow-fork"),
        keep: argv.includes("--keep") ? keepAt : undefined,
        onStep: (m) => !json && console.log(`  ${dim("rebuild")}    ${m}...`),
      });
    } catch (err) {
      console.error(`\n  ${red("cannot rebuild")}  ${err.message}\n`);
      return 2;
    }
    if (json) {
      console.log(JSON.stringify({ ...result, published, rebuild: out }, null, 2));
    } else {
      reportRebuild(out, result);
    }
    // An executable file the build produced and the instance never served
    // is not a footnote. It is how a targeted instance hides a backdoored
    // chunk: serve it to users, 404 it to whoever looks like a verifier, and
    // it drops out of the walk entirely. Saying "verified" over that
    // overstates what was checked.
    const bad =
      out.differing.length ||
      out.notBuilt.length ||
      (out.notServedExecutable ?? []).length ||
      // Only a comparison that COULD have matched counts against the
      // instance. The rebuild is the stronger check and it has just run.
      published.status === "mismatch";
    return bad ? 1 : 0;
  }

  if (!json && published.status !== "verified") {
    console.log(`  ${yellow("no rebuild".padEnd(10))} ${why}`);
    // Every remaining status means nobody checked these bytes against
    // anything - including a fork, which is the case most likely to be read
    // as a pass just because nothing went red.
    console.log(
      dim(
        "\n  So nothing above is a verdict on this instance. The digest becomes one\n" +
          "  the moment somebody else runs this too: same digest, same bytes for\n" +
          "  every file listed. Different, and one of you is being served something\n" +
          "  the other is not.\n"
      )
    );
  }
  // Exit 0 means verified. Nothing here verified anything, so anything short
  // of a match against the published build is a non-zero exit - including a
  // comparison that could not apply.
  if (published.status !== "verified") return 1;
  // Unreadable files are a real finding, not a crash.
  return result.files.some((f) => !f.hash) ? 1 : 0;
}

/**
 * What the published record says, if anything.
 *
 * Printed whether or not a rebuild follows: on its own it is the only check
 * available without a toolchain, and beside a rebuild it is a second,
 * independent party saying the same thing about the same commit.
 */
/**
 * What the project's CI said this commit builds to.
 *
 * Labelled "ci build" rather than "published", which named the row without
 * saying what it compared against - and read as a property of the instance
 * rather than as a second opinion about it. The whole value of this line is
 * whose word it is.
 */
function reportPublished(published, result) {
  // Pad the PLAIN label, then colour it. Padding the coloured string counts
  // the ansi escapes, which already exceed the width, so it never padded at
  // all and this row sat hard against its own text while every other row
  // lined up. Ten matches claims / files / digest above.
  const line = (label, paint, rest) =>
    console.log(`  ${paint(label.padEnd(10))} ${rest}`);
  const indent = "             ";
  // The durable reason a CI record can never describe this instance: it
  // compiles in plugins CI does not build. Saying only "no build for this
  // commit" invites waiting for one that is never coming.
  const fetched = (result.claim?.plugins ?? []).filter(
    (p) => p?.origin === "fetched"
  ).length;
  if (published.status === "verified") {
    line(
      "ci build", green,
      "matches - GitHub Actions built this commit into these exact bytes\n" +
        indent + dim("that is CI's word, not this instance's")
    );
  } else if (published.status === "not-comparable") {
    line(
      "ci build", dim,
      dim(
        `cannot apply - this instance declares ${published.unbuiltPlugins.length} plugin(s) CI does not\n` +
          indent + `build (${published.unbuiltPlugins.join(", ")}),\n` +
          indent + `so its bytes cannot match at any commit. ${published.differing.length} file(s) differ,\n` +
          indent + "which that would explain - but the plugin list is the instance's\n" +
          indent + "own claim and nothing here checks it. Rebuild to settle it."
      )
    );
  } else if (published.status === "mismatch") {
    line(
      "CI BUILD", red,
      `does NOT match what CI built for ${String(result.claim?.commit).slice(0, 8)}` +
        ` - ${published.differing.length} file(s) differ`
    );
    for (const d of published.differing.slice(0, 10)) {
      console.log(indent + red("!") + " " + d.path);
    }
    if (published.differing.length > 10) {
      console.log(dim(indent + "...and " + (published.differing.length - 10) + " more"));
    }
    if (published.configurationDiffers) {
      // Its own account of itself, so it is offered as an explanation and
      // labelled as one, never as the verdict.
      console.log(
        dim(
          indent + "this instance says it runs a different plugin set, which\n" +
            indent + "would explain it - but that is its own claim and nothing\n" +
            indent + "here checks it. Rebuild to settle it."
        )
      );
    }
  } else if (published.status === "not-upstream") {
    line(
      "ci build", dim,
      dim("not applicable - CI publishes builds for " + UPSTREAM + "\n" +
          indent + "only, and this is built from " + published.repository)
    );
  } else if (published.status === "different-configuration") {
    line(
      "ci build", dim,
      dim("CI built this commit, but with a different plugin set")
    );
  } else if (fetched) {
    // No record, and there could not be a useful one: CI builds this
    // repository alone.
    line(
      "ci build", dim,
      dim(
        `not applicable - this instance compiles in ${fetched} fetched plugin(s),\n` +
          indent + "which CI does not build. Rebuilding is the check for it."
      )
    );
  } else {
    line("ci build", dim, dim("CI has published no build for this commit"));
  }
  console.log("");
}

/** Why a rebuild will not happen, or "" when it will. */
async function cannotRebuild(result, argv) {
  if (argv.includes("--no-rebuild")) return "--no-rebuild";
  const claim = result.claim;
  if (!claim?.repository || !claim?.commit) {
    return "this instance does not declare a repository and commit";
  }
  if (claim.repository !== UPSTREAM && !argv.includes("--allow-fork")) {
    return (
      `${claim.repository} is not ${UPSTREAM}, and rebuilding runs its\n` +
      `               build on your machine - pass --allow-fork once you have read it`
    );
  }
  const missing = await toolchainMissing();
  if (missing.length) return `${missing.join(" and ")} not on PATH`;
  return "";
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n  ${red("error")}  ${err?.message ?? err}\n`);
    process.exit(2);
  });
