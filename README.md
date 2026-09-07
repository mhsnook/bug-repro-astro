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

No bindings, no `observability` config, no framework. Eighteen files written under
`.wrangler/state` per request by a project that configures no storage at all.

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

Under `DEBUG=vite:transform` the same change measured 7.98s → 1.41s, and six modules
re-transforming per request against two. The instrumentation inflates both arms, so the
ratio is the finding rather than the absolute times.

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

| platform | `hotUpdate` hooks per request | files written under `.wrangler/state` |
| --- | --- | --- |
| ubuntu-latest | 4 | 9 |
| windows-latest | 3 | 9 |
| macos-latest | **0** | 9 |

That table was measured on `@cloudflare/vite-plugin` 1.54.2, which wrote nine files a
request where 1.54.4 writes eighteen; the hook counts are unchanged on the platform
re-measured since. macOS writes the same files per request and its watcher reports none
of them, which is why the same site loads in 0.05s there and 9 to 10s on the other two.
Why the writes go unreported on macOS is still open — chokidar's polling and FSEvents
defaults are the obvious places to look, and neither has been checked.

There is no data yet for the edit-driven path that #13425 is about, on any platform.

## The fix

Updating does not help: every measurement above is on the versions listed at the end of
this file, all current. 1.54.4 writes twice as many files a request as 1.54.2 and reports
the same three hooks.

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
0.77s and `repro/minimal` from three `hotUpdate` hooks a request to none.

The change, with a test covering both the exclusion and the merge with a user's own
`server.watch.ignored`, is at
[mhsnook/workers-sdk@`7115d27`](https://github.com/mhsnook/workers-sdk/commit/7115d27).

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
