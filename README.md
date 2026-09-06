# Two reproductions of one dev-server bug

`@cloudflare/vite-plugin` persists Miniflare state under `.wrangler/state`, inside the
Vite root, and never excludes it from the dev-server watcher. Every request writes there,
so Vite reports a file change and runs every plugin's `hotUpdate` hook — while nobody has
edited anything.

That is harmless on its own and expensive in company. This repository holds both halves.

| | what it shows | framework |
| --- | --- | --- |
| [`repro/bare-cloudflare-vite`](repro/bare-cloudflare-vite) | the **trigger**: 3 `hotUpdate` hooks per request, nothing edited | none |
| the app at the root | the **cost**: 8 to 16 seconds a page, and 8× better with one line | Astro + EmDash |

Two exhibits rather than one because the cost could not be synthesised. A 400-module
graph with the same invalidation shape was measured at 30ms a request, with the
invalidation confirmed firing 71 times. Whatever makes this expensive scales with the
real graph, so the framework has to stay in order to show it.

## The trigger

```bash
cd repro/bare-cloudflare-vite
pnpm install
node count-hot-updates.mjs
```

```
requests            6, all 200: true
timings             32ms, 24ms, 22ms, 26ms, 25ms, 23ms
hotUpdate hooks     18 during requests (3/request)
files in .wrangler  9
```

No bindings, no `observability` config, no framework. Nine files written under
`.wrangler/state` per request by a project that configures no storage at all.

Requests stay fast there because Vite matches no modules for those paths, so nothing
rebuilds. The hooks still run, and a plugin that invalidates without checking which file
changed will do so on every request forever.

## The cost

```bash
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

Measured here, with `vite.server.watch.ignored` set against unset:

```
baseline                    with **/.wrangler/** ignored
  7.98s  6 modules            1.41s  2 modules
  7.43s  6 modules            0.92s  2 modules
  8.09s  6 modules            0.93s  2 modules
```

Uninstrumented the same change measured 16s → 0.14s; `DEBUG=vite:transform` inflates
both arms, so the ratio is the finding rather than the absolute times.

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

Linux and Windows reproduce the slowness; macOS has not. That is still an inference from
timings plus a guess about FSEvents surfacing sqlite WAL writes differently from inotify
and ReadDirectoryChangesW. The `watcher` CI job measures the hook count per platform so
it can be stated as fact or withdrawn.

There is no macOS data at all for the edit-driven path that #13425 is about.

## Also here

- [#1](../../issues/1) — the running log of what has been established and corrected
- [#13](../../issues/13) — the cold-start crash, still open: `astro/app/manifest` was
  fixed in `@astrojs/cloudflare` 14.3.0 and emdash 0.36.0, and `astro/logger/console`
  took its place. It costs most cold starts here a retry.
- `repro-scripts/dev-load.mjs` — the harness behind `pnpm dev-load`. Counts only
  responses that were 200, cleared a byte floor, and did not land on the sign-in page,
  because a broken setup serves ~200-byte shells that look like a speedup.

Versions: astro 7.3.1 · `@astrojs/cloudflare` 14.3.0 · emdash 0.36.0 ·
`@cloudflare/vite-plugin` 1.54.2 · workerd 1.20260828.1
