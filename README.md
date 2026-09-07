# Two reproductions of one dev-server bug

`@cloudflare/vite-plugin` persists Miniflare state under `.wrangler/state`, inside the
Vite root, and never excludes it from the dev-server watcher. Every request writes there,
so Vite reports a file change and runs every plugin's `hotUpdate` hook — while nobody has
edited anything.

That is harmless on its own and expensive in company. This repository holds both halves.

| | what it shows | framework |
| --- | --- | --- |
| [`repro/minimal`](repro/minimal) | the **trigger**: 3 `hotUpdate` hooks per request, nothing edited | none |
| [`repro/emdash-slowdown`](repro/emdash-slowdown) | the **cost**: 9 to 10 seconds a page, and 12× better with one line | Astro + EmDash |

Each is a standalone project with its own `package.json` and lockfile. They are
deliberately not a pnpm workspace: `repro/minimal` is only worth anything if its
lockfile contains no framework, and sharing one would quietly undo that.

Two exhibits rather than one because the cost could not be synthesised. A 400-module
graph with the same invalidation shape was measured at 30ms a request, with the
invalidation confirmed firing 71 times. Whatever makes this expensive scales with the
real graph, so the framework has to stay in order to show it.

## The trigger

```bash
cd repro/minimal
pnpm install
node count-hot-updates.mjs
```

```
requests            6, all 200: true
timings             36ms, 32ms, 30ms, 36ms, 29ms, 33ms
hotUpdate hooks     18 during requests (3/request)
files in .wrangler  18
```

No bindings, no `observability` config, no framework. Eighteen files under
`.wrangler/state` for a project that configures no storage at all. Most are created once
at startup; the observability trace store among them is written to on every request, and
that is what the watcher reports.

Requests stay fast there because Vite matches no modules for those paths, so nothing
rebuilds. The hooks still run, and a plugin that invalidates without checking which file
changed will do so on every request forever.

## The cost

```bash
cd repro/emdash-slowdown
pnpm install
pnpm dev-load
```

Astro's middleware plugin is such a plugin. Its `hotUpdate` handler takes no arguments,
so it cannot inspect the change:

```js
// astro/dist/core/middleware/vite-plugin.js
hotUpdate: {
  handler() {
    if (!isAstroServerEnvironment(this.environment)) return;
    const middlewareVirtualMod = this.environment.moduleGraph
      .getModuleById(MIDDLEWARE_RESOLVED_MODULE_ID);
    if (!middlewareVirtualMod) return;
    this.environment.moduleGraph.invalidateModule(middlewareVirtualMod);
    this.environment.hot.send("astro:middleware-updated", {});
  }
}
```

Measured here by `pnpm dev-load`, median of three healthy responses a route, with
`vite.server.watch.ignored` set against unset:

| route | baseline | with `**/.wrangler/**` ignored |
| --- | --- | --- |
| `/` | 9.31s | 0.80s |
| `/posts` | 10.20s | 0.75s |
| `/plain` | 9.85s | 0.76s |
| `/bare-query` | 9.55s | 0.65s |
| `/_emdash/admin` | 1.03s | 0.22s |

Both arms of that table come from one linux machine, which is slower than the CI runners
— they put the same baseline at 4.05s where this one puts it at 9.31s. Read the ratio
rather than the seconds. The arms are only comparable to each other, and only CI's
numbers are comparable across platforms.

Under `DEBUG=vite:transform` the same change measured 7.98s → 1.41s, and six modules
re-transforming per request against two. The instrumentation inflates both arms, so again
the ratio is the finding rather than the absolute times.

## When this started

Version 0.0.1, on 2025-01-22. The initial beta release already resolved
`.wrangler/state` against the Vite root by default, in a `getPersistence(root,
persistState)` that is the same shape as today's, and documented it in its README. No
release since has excluded that directory from the watcher: `git log -S
'"**/.wrangler/**"'` over the plugin's source returns two commits, the one adding it to
`server.fs.deny` and the one fixing this.

So any project whose Worker writes storage while serving a request has been affected for
nineteen months. Measured on `repro/minimal` with local observability off, so that the
only writer is the Worker itself:

| what the Worker does per request | `hotUpdate` hooks per request |
| --- | --- |
| nothing | 0 |
| binds KV, writes nothing | 0 |
| one `env.KV.put()` | **9** |

The binding alone changes nothing, which is what identifies the write rather than the
configuration as the cause. Nine hooks is three times what an idle project pays.

What changed recently is that this reached projects that write nothing at all:

| date | change | effect here |
| --- | --- | --- |
| 2025-01-22 | plugin 0.0.1 | persistence defaults to `.wrangler/state` inside the Vite root, and the watcher is never told |
| 2026-04-14 | [#13427](https://github.com/cloudflare/workers-sdk/pull/13427), plugin 1.32.3 | `.wrangler` added to `server.fs.deny`, classified as must-not-be-served |
| 2026-07-23 | [#14633](https://github.com/cloudflare/workers-sdk/pull/14633), miniflare | local observability captures request traces and console logs, opt-in |
| 2026-07-31 | [#14944](https://github.com/cloudflare/workers-sdk/pull/14944), wrangler 4.118.0 | that capture becomes **on by default**, so every request writes there whatever the Worker does |
| 2026-09-03 | [#15401](https://github.com/cloudflare/workers-sdk/pull/15401), miniflare `5.20260903.0-alpha` | D1, KV and R2 stores no longer need configured bindings, taking this project from nine files a run to eighteen |

Turning that writer back off, on the same versions and the same stock config, with only
`X_LOCAL_OBSERVABILITY=false`:

| route | default | observability off |
| --- | --- | --- |
| `/` | 9.31s | 0.67s |
| `/posts` | 10.20s | 0.60s |
| `/plain` | 9.85s | 0.58s |
| `/bare-query` | 9.55s | 0.58s |

That is a diagnostic rather than a fix: it identifies which writer drives the watcher, and
nobody should have to turn observability off. A project escapes this today by moving
persistence out of the Vite root, by setting `vite.server.watch.ignored` itself, or by
being on macOS, whose watcher reports none of these writes. The third is why nineteen
months produced no report.

## What this does not claim

The open question on [cloudflare/workers-sdk#13425](https://github.com/cloudflare/workers-sdk/issues/13425)
is whether an HMR update re-bundles the whole app graph. A maintainer's answer there is
that `import.meta.hot.accept()` creates a boundary so only the relevant parts update, and
that is correct — six modules re-transform per request, not the graph.

Nothing here depends on that being wrong. **Six modules cannot be seven seconds**;
individual transforms in that log run 2 to 6ms. The expense is not re-transformation, it
is what an SSR invalidation costs on the workerd side. The same site on `@astrojs/node`
serves in 0.11s with the same invalidation happening, because rebuilding in-process is
cheap.

The finding sits one link earlier than the disputed one: updates are being generated at
all, three per request, forever, with nobody editing anything.

## Platforms

The `watcher` CI job runs `repro/minimal` on all three runners. Six requests, nothing
edited:

| platform | `hotUpdate` hooks per request | files under `.wrangler` |
| --- | --- | --- |
| ubuntu-latest | 3 to 9.5 | 18 |
| windows-latest | 3 | 18 |
| macos-latest | **0** | 18 |

Measured on `@cloudflare/vite-plugin` 1.54.4 over four CI runs. Windows and macOS
returned the same figure every time. Ubuntu did not: 18, 18, 21 and 57 hooks across six
requests, so 3 per request three times and 9.5 once. Take the ubuntu number as a floor
rather than a rate — how many events the watcher raises for one burst of writes is not
fixed, and the same six requests cost three times as much in one run as in the next.

Against the same table on 1.54.2 the counts are in the same range — 4, 3 and 0 — while
the file count doubled on every platform, so what 1.54.4 added is more state, not more
reporting.

macOS is the useful case, because nobody configured it. It writes the same eighteen
files, its watcher reports none of them, and `repro/emdash-slowdown` on the same commit
serves the same routes in a different order of magnitude:

| platform | `/` | `/posts` | `/plain` | `/bare-query` |
| --- | --- | --- | --- | --- |
| macos node 26 | **0.06s** | 0.05s | 0.04s | 0.04s |
| macos node 22 | **0.15s** | 0.09s | 0.08s | 0.13s |
| linux node 22 | 4.05s | 3.98s | 3.61s | 3.99s |
| linux node 26 | 5.26s | 4.97s | 4.33s | 4.67s |
| windows node 22 | 5.52s | 6.06s | 5.26s | 6.10s |
| windows node 26 | 8.25s | 7.63s | 7.15s | 8.06s |

Same versions, same lockfile, same code on every row. The only thing that differs is
whether the platform's watcher reports the writes, and the platform that does not report
them is two orders of magnitude faster — which is the same result as setting
`watch.ignored`, arrived at without setting anything.

Why the writes go unreported on macOS is still open — chokidar's polling and FSEvents
defaults are the obvious places to look, and neither has been checked.

There is no data yet for the edit-driven path that #13425 is about, on any platform.

## The fix

Updating does not help: every measurement above is on the versions listed at the end of
this file, all current. 1.54.4 leaves twice as many files under `.wrangler` as 1.54.2 and
reports the same three hooks.

The plugin already knows `.wrangler` is its own, and already names it — in
`server.fs.deny`, which governs only what may be served, not what the watcher reports:

```ts
// packages/vite-plugin-cloudflare/src/plugins/config.ts
server: {
  allowedHosts: getAllowedHosts(...),
  watch: { ignored: ["**/.wrangler/**"] },   // this line
  fs: { deny: [...defaultDeniedFiles, ...configPaths] },
},
```

Excluding only `.wrangler` is deliberate rather than reusing the deny list: `.dev.vars`
and the Wrangler config files are denied too, but the plugin watches those on purpose to
restart the dev server, so ignoring them would break config reload.

Applied to the installed 1.54.4 and run against this repository's stock
`astro.config.mjs`, with no user-side Vite configuration at all, `/` goes from 9.31s to
0.77s and `repro/minimal` from three `hotUpdate` hooks a request to none. Three
interventions land in the same place — this patch, `vite.server.watch.ignored` set by
hand, and disabling the writer with `X_LOCAL_OBSERVABILITY=false` — which is what ties
the chain together.

The change, with a test covering both the exclusion and the merge with a user's own
`server.watch.ignored`, is at
[mhsnook/workers-sdk@`6d9b689`](https://github.com/mhsnook/workers-sdk/commit/6d9b689).

## Also here

- [#1](../../issues/1) — the running log of what has been established and corrected
- [#13](../../issues/13) — the cold-start crash, still open: `astro/app/manifest` was
  fixed in `@astrojs/cloudflare` 14.3.0 and emdash 0.36.0, and `astro/logger/console`
  took its place. It costs most cold starts here a retry.
- `repro/emdash-slowdown/repro-scripts/dev-load.mjs` — the harness behind
  `pnpm dev-load`. Counts only
  responses that were 200, cleared a byte floor, and did not land on the sign-in page,
  because a broken setup serves ~200-byte shells that look like a speedup.

Versions: astro 7.3.1 · `@astrojs/cloudflare` 14.3.0 · emdash 0.36.0 · vite 8.2.2 ·
`@cloudflare/vite-plugin` 1.54.4 · wrangler 4.129.0 · miniflare 5.20260903.0-alpha ·
workerd 1.20260903.1

Every one of those is the latest published release as of 2026-09-07, except
`@cloudflare/workers-types`, held at 5.20260906.1 by this repository's 24-hour
`minimumReleaseAge` policy.
