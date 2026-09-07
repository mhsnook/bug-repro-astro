# The same trigger, on Cloudflare's own scaffold, costing nothing

One of three reproductions in this repository. This one is the control. It shows
that the writes and the watcher events happen here too, in an app Cloudflare
generates, and that they cost nothing — so the seconds measured in
[`repro/emdash-slowdown`](../emdash-slowdown) are not what a `.wrangler` write
costs by itself. [`repro/minimal`](../minimal) shows the trigger with no
framework at all.

Generated with Cloudflare's own CLI, unmodified except for one added plugin:

```bash
pnpm create cloudflare@latest stock-tanstack \
  --experimental --category=web-framework --framework=tanstack-start \
  --no-git --no-deploy
```

Note the flags. On `create-cloudflare` 2.72.5 the documented invocation,
`--framework=tanstack-start` on its own, exits with `Unsupported framework`:
that id exists only in the experimental framework map, and passing `--lang`
filters it back out afterwards. Passing `--accept-defaults` alongside
`--framework` silently builds a Hello World Worker instead, and exits 0.

## What it shows

```bash
pnpm install
node ../watcher-probe.mjs --dir=.
```

```
requests            6, all 200: true
timings             42ms, 37ms, 34ms, 33ms, 32ms, 31ms
hotUpdate hooks     12 during requests (2/request)
  by environment    {"client":6,"ssr":6} (requests only)
files in .wrangler  18
file writes seen     6 (1/request)
```

One write under `.wrangler/state` per request, two `hotUpdate` hooks per write,
nothing edited — and pages in the 30ms range. Alongside the other two:

| reproduction | writes per request | hooks per request | page load |
| --- | --- | --- | --- |
| [`repro/minimal`](../minimal) | 1 | 3 | ~25ms |
| this one | 1 | 2 | ~35ms |
| [`repro/emdash-slowdown`](../emdash-slowdown) | 1 | 3 | 5 to 9 seconds |

## Why it stays fast

The writes are identical. What differs is what the framework's plugin does when
told about them. TanStack Start's two `hotUpdate` hooks take the context and
work from the modules Vite matched:

```js
// @tanstack/start-plugin-core
hotUpdate(ctx) {
  ctx.modules.forEach((m) => { /* ... */ });
}
```

Vite matches no modules for a path under `.wrangler/state`, which is visible
under `DEBUG=vite:hmr` as `[no modules matched]` in every environment. So
`ctx.modules` is empty and both hooks do nothing.

Astro's middleware plugin cannot do that. Its handler takes no arguments, so it
has nothing to check and invalidates every time:

```js
// astro/dist/core/middleware/vite-plugin.js
hotUpdate: {
  handler() {
    const middlewareVirtualMod = this.environment.moduleGraph
      .getModuleById(MIDDLEWARE_RESOLVED_MODULE_ID);
    if (!middlewareVirtualMod) return;
    this.environment.moduleGraph.invalidateModule(middlewareVirtualMod);
    this.environment.hot.send("astro:middleware-updated", {});
  }
}
```

That is the whole difference between 35 milliseconds and 8 seconds.

## What was changed

Two things, both marked in `vite.config.ts`:

- `countsHotUpdates()`, a plugin that logs and invalidates nothing. Without it
  there is no way to count hooks, and a run with no observer reports zero for
  the same reason an unplugged meter does.
- a `REPRO_WATCHER=poll` switch, matching `repro/minimal`, so this app can be
  run against either watcher backend.

The lockfile was regenerated rather than taken from the scaffold, which is also
what `repro/minimal` does.

## Versions

`@cloudflare/vite-plugin` ^1.26.0 · `@tanstack/react-start` latest · vite ^8.0.0 ·
wrangler ^4.129.0 · created with `create-cloudflare` 2.72.5
