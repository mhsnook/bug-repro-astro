# The middleware plugin invalidates on every file change

Minimal reproduction for an Astro regression: since 7.2.1 the middleware Vite plugin
invalidates its virtual module on any file change anywhere under the Vite root, not only
on changes to the middleware.

Three dependencies, one page, one pass-through middleware. Nothing needs to be edited
while it runs: `@cloudflare/vite-plugin` writes Miniflare state under `.wrangler/state`
on every request, inside the Vite root, and each of those writes is a file change.

```bash
pnpm install
pnpm dev
# then request http://localhost:4321/ a few times and watch the timings
```

## What it does

Measured on Linux, astro 7.3.1, five requests after warm-up:

| | per request |
| --- | --- |
| as shipped | 0.46s to 0.58s |
| `src/middleware.ts` deleted | 0.13s to 0.17s |
| as shipped, with the 7.2.0 guard patched back in | 0.07s to 0.10s |

Deleting a pass-through middleware makes a trivial page three times faster. Restoring the
check Astro used to do makes it six times faster and keeps the middleware.

## What changed

7.2.0 watched for changes itself and returned early twice:

```js
// astro 7.2.0, dist/core/middleware/vite-plugin.js
server.watcher.on("change", (path) => {
  const normalizedPath = viteNormalizePath(path);
  if (!normalizedPath.startsWith(normalizedSrcDir)) return;
  const relativePath = normalizedPath.slice(normalizedSrcDir.length);
  if (!isMiddlewarePath(relativePath)) return;
  // ...invalidate
});
```

7.2.1 replaced it with a handler that takes no arguments, so it cannot check:

```js
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

`isMiddlewarePath` is still defined and still exported in 7.2.1 and 7.3.1, with no
callers. Counting `isMiddlewarePath(` in the shipped file gives two in 7.2.0 and one, the
definition, in both later versions.

The change came from [withastro/astro#17605](https://github.com/withastro/astro/pull/17605),
merged 2026-08-06, which closed [#17590](https://github.com/withastro/astro/issues/17590)
by making transitive imports of the middleware trigger HMR. Widening what counts as a
change is the point of that PR; losing the path check reads as incidental to it. The
`hotUpdate` hook still receives `ctx`, so the check can be restored without giving that up.

## Why Cloudflare is in a minimal reproduction

Something has to change a file. Under `@astrojs/node` the invalidation costs about 0.11s
and nothing is visible. `@cloudflare/vite-plugin` writes its own state on every request,
so the reproduction needs no file edits and no scripting, and workerd is where an SSR
invalidation is expensive enough to see.

The writes themselves are a separate issue against that plugin. They are harmless where a
plugin checks what changed: the same writes on Cloudflare's stock TanStack Start scaffold
cost nothing, because its `hotUpdate(ctx)` handlers read `ctx.modules` and find it empty.

## Versions

astro 7.3.1 · `@astrojs/cloudflare` 14.3.0 · wrangler 4.129.0 · node 22.22.2 · Linux x64
