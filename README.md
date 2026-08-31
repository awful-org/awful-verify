<p align="center">
  <img src="logo.svg" alt="awful-verify" width="140">
</p>

<h1 align="center">awful-verify</h1>

<p align="center">
  Check that an <a href="https://awful.chat">awful.chat</a> instance runs the code it says it runs.
</p>

```sh
npx github:awful-org/awful-verify chat.example.com
```

## The problem

A web app is delivered fresh from its server on every visit. Whatever its
source repository says, the server can send you something else - to everyone,
to you specifically, or only sometimes. Nothing about being open source
prevents that, and nothing in your browser tells you it happened.

Reading the source cannot detect it. The only thing that can is comparing the
bytes you were served against the bytes that source produces.

## What it does

An instance declares what it was built from, at
`/.well-known/awful-build.json`: a repository, a commit, and every plugin
compiled into it with the repository and ref that plugin came from.

That is a build recipe, so this executes it. Clone the app at that commit,
fetch those plugins at those refs, build, and compare the result against every
file the instance actually served.

```

  https://dev.awful.chat
  fetched 2026-08-31T16:55:05.814Z

  claims     github.com/awful-org/awful.chat @ c3447c65 v0.0.0
             plugin ping             in this repository
             plugin poll             in this repository
             plugin soundboard       awful-org/awfully-awesome@d00d9db
             plugin steam-roulette   awful-org/awfully-awesome@d00d9db
             plugin waffle-party     awful-org/awfully-awesome@d00d9db
             plugin wheel            in this repository
  files      331 hashed, 21.0 MB
             30 from the precache manifest, 301 found by following what the code loads

  digest     099a4ef350248f8e02cb0f5c6825f4587c18254d3e01d2a7cf2f7c8577de69b8

  published    no build has been published for this commit

  rebuild    cloning github.com/awful-org/awful.chat...
  rebuild    checking out c3447c65...
  rebuild    installing dependencies...
  rebuild    fetching plugins: awful-org/awfully-awesome@d00d9db...
  rebuild    building...
  rebuild    comparing...

  verified   331 files, byte-identical to a build of everything
             this instance declares
             12 built file(s) were never served, so not checked (none of them executable)

  sources
    github.com/awful-org/awful.chat @ c3447c655501
      the app, ping, poll, wheel
      https://github.com/awful-org/awful.chat/tree/c3447c655501683abf1db32e52c7ef1feb69286f
    github.com/awful-org/awfully-awesome @ d00d9db
      soundboard, steam-roulette, waffle-party
      https://github.com/awful-org/awfully-awesome/tree/d00d9db

  A match proves this instance runs exactly these sources. It does not
  say the sources are safe. That is what the links are for.
```

Exit code is 1 on any difference, so this drops into CI against your own
deployment.

## Without a toolchain: the published build

Every commit on the project's main branch is built by its CI, which publishes
the hash of every file that build serves. The report looks that record up for
the commit an instance declares, so a plain run already answers the question
for anyone who trusts the project's source and does not want to install
anything:

```
  ci build   matches - GitHub Actions built this commit into these exact bytes
             that is CI's word, not this instance's
```

That is a different statement from a rebuild, not a weaker version of it. The
published record says *GitHub Actions built this commit into these bytes*; a
rebuild says *this source builds into these bytes on my machine*. If you
already trust the source, the first is enough and costs one HTTP request. If
you would rather not trust a CI system either, rebuild.

A fork is not looked up at all. Records are published for the upstream
repository only, so a fork's commit would always miss - and reporting that as
"no build has been published" would read as *not yet* when the truth is
*never, and not here*. Rebuilding is the check that applies to a fork.

A record describes a commit **and** a plugin set, because plugins compile
into the app. An instance running a different set genuinely has different
bytes, so its digest will not match the published one - the report says the
instance says so, and says that it has not checked that claim, because the
plugin list is written by the operator and is not part of what gets hashed.
It is an explanation, not an excuse: a digest that does not match is reported
as a mismatch either way, and rebuilding is what settles it.

The address those records are fetched from is compiled into this tool and is
never taken from the instance. An instance able to name its own source of
truth would point at hashes it had written itself, and every check would
pass. `--no-published` skips the lookup.

## Why the declaration does not have to be trusted

An operator writes that file, and it is not part of what gets hashed. It could
say anything.

It does not need to be trusted, because the bytes settle it. An instance that
hides a plugin builds a bundle without that plugin, and what it serves will
not match. An instance naming a commit it did not build fails the same way.
The declaration says what to check; checking it is the entire operation.

That property has to be maintained deliberately. An earlier version compared
the declared plugin set *before* the digest and reported a difference as a
benign "different configuration" - so adding one invented plugin entry made a
byte-level mismatch exit 0 without the served bytes ever being compared. The
digest is compared first now, and anything the declaration says about why is
attached to the result as the instance's own unverified account.

## What a match proves, and what it does not

That the instance runs exactly the sources it names. **Not** that those
sources are safe. No hash can tell you that, which is why the report ends with
a link to every repository that went into the build. That is the part a person
has to read.

Two things in that list deserve attention on sight:

- **A repository that is not the upstream one.** Forks are legitimate, but a
  fork's operator controls both the instance and the source it would be
  checked against. A match there proves the code is *readable*, not that it is
  trustworthy and not that anyone has read it. A backdoored fork matches its
  own source every time. Rebuilding one requires `--allow-fork`.
- **A plugin not pinned to a commit sha.** Only a sha names bytes. A build
  that fetched a default branch is obviously unreproducible, but so is one
  that used a tag or a branch name, because either can be moved after the
  fact - and that one looks pinned to whoever wrote it. Both are reported,
  distinctly. The declaration records the sha256 of each fetched tarball, so
  when the code has moved since the instance was built, that is reported
  too.

A difference cannot be attributed to one component. Plugins compile *into* the
app, so everything shares one bundle: you learn that something does not match,
and which files, not whose fault it is.

And it says nothing about whether the code is any *good*. A match means the
bytes came from source you can read. Reading it is still a person's job.

## It checks the app, not the servers behind it

This hashes what your browser downloads. An awful.chat instance also runs
three server-side services, and **none of them are checked here** - they serve
no files to hash, so none of them are visible to this tool at all.

| | handles | can see |
| --- | --- | --- |
| **relay** | peer discovery, offline mailbox, link previews, TURN credentials | peer ids and room codes, and that an identity has mail waiting. Not message or file content: traffic between peers is encrypted end to end, and mailbox blobs are sealed to the recipient. |
| **SFU** | video and screen sharing in calls | **the video and screen streams it routes.** Voice does not pass through it. |
| **coturn** | relaying call media between peers that cannot connect directly | who is talking to whom, and how much traffic there is. |

Their addresses come from `/config.json`, which is deliberately excluded from
the digest, because those values are *supposed* to differ between instances -
it is what lets two instances of one build match at all. The consequence is
worth stating plainly: **an instance can point at any relay, SFU or TURN
server it likes and still verify perfectly.**

Verifying the code tells you what the page will do. It does not tell you where
the operator sends what leaves it. `/config.json` is one request and is not
minified - read it yourself if that matters to you.

## Requirements, and the risk

Needs `git`, `pnpm` and `node` on PATH, a few minutes, and a few hundred MB of
dependencies.

> **It runs the declared repository's build.** `pnpm install` executes
> whatever lifecycle scripts that tree contains, on your machine, as you.
> Fingerprinting alone is safe against a hostile instance; this is not. That
> is why a repository which is not the upstream one is refused until you pass
> `--allow-fork`, having read what you are about to build.

`--keep <dir>` keeps the checkout instead of deleting it, so a difference can
be inspected.

## Comparing two runs against each other

`--no-rebuild` fingerprints and stops: every file hashed, reduced to one
digest. That is not a verdict on its own, but two people can compare.

```sh
npx github:awful-org/awful-verify chat.example.com --no-rebuild --json > mine.json
# a friend, on another network, does the same and sends you theirs
npx github:awful-org/awful-verify --compare mine.json theirs.json
```

Different digests mean one of you was served something the other was not -
the one attack no number of solo runs can see, since an instance that serves
clean code to anything resembling a verifier and something else to everybody
else passes every check you run alone.

An instance running its own server can do that. Static hosting cannot: GitHub
Pages has no request-time code and serves the same bytes to everyone.

## How the file list is built

This decides how much of an instance a run actually covers.

1. **What the app declares.** `/sw.js` carries the service worker's precache
   manifest - the app's own list of what it installs, about 30 files. Only the
   paths are taken from it. The revisions beside them are the app's own hashes
   of the same bytes, and trusting a hash the instance supplies to check the
   instance would be circular.
2. **What the app can reach.** Every script, stylesheet and HTML page fetched
   is read for the assets *it* names, and those are fetched too, until a round
   turns up nothing new. The manifest is only the install payload: the app
   keeps its big on-demand pieces out of it - around 300 syntax-highlighting
   chunks, the wasm engines, an 8 MB audio worklet. All executable, all named
   by content hash, and a name is not a hash. This takes the list from about
   30 files to about 330.
3. **Guesses are dropped, declarations are not.** Minified JavaScript contains
   strings that merely look like paths. One that turns out not to exist is a
   bad guess and is dropped silently; a path the manifest declared and then
   cannot serve is reported.

A reference is resolved against the file that named it, since a chunk names
its siblings relatively, and any query string is dropped - a cache-buster
names the same file.

Files the build produces that the instance never served are counted, not
ignored, and the report says whether any of them could execute. Code the app
reaches by a URL assembled at runtime, rather than written down in a file
anybody can read, is outside all of this.

The digest is over `path\0hash` for each file, sorted, so it does not depend
on fetch order. A file present in one run and absent in another changes it,
not only a file whose contents changed.

It excludes `/config.json`, which holds the instance's own relay and SFU
addresses. Those are *supposed* to differ between instances, and keeping them
out of the compiled bundle is what lets two instances of one build match at
all.

## Notes on trust

A tool for checking you are running trusted code is itself code you are
running, so:

- **No dependencies.** Node's own `fetch` and `crypto.subtle`, nothing else.
- **Three small files.** `src/core.mjs` fingerprints and checks published
  records, `src/rebuild.mjs` rebuilds, `src/cli.mjs` prints. Reading them before running is a realistic
  afternoon, not a gesture.
- The file list comes from the instance, so it is treated as hostile: paths
  resolving off-origin are refused rather than fetched, and there are caps on
  file count, per-file size and total bytes. A run that hits a cap says so,
  rather than quietly reporting less than it looked at.

`core.mjs` uses only APIs that exist in both Node and browsers, so the same
fingerprinting logic can back a web version without a second implementation.
`rebuild.mjs` is the part that needs a machine.

## Development

```sh
node --test
```
