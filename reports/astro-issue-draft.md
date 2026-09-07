# Draft: Astro bug report

Fields follow `.github/ISSUE_TEMPLATE/---01-bug-report.yml`. Checklist passes: astro
7.3.1 is current on npm, node v22.22.2 is above the required v22.12.0.

Before filing, replace `<REPRO_URL>` with the link to `repro/astro-middleware` on a public
branch or its own repository.

---

## Astro Info

```
Astro                    v7.3.1
Node                     v22.22.2
System                   Linux (x64)
Package Manager          pnpm
Output                   server
Adapter                  @astrojs/cloudflare
Integrations             none
```

## Describe the Bug

Since 7.2.1 the middleware Vite plugin invalidates its virtual module on every file
change under the Vite root, whether or not the changed file is the middleware. Any
process writing a file inside the project causes a middleware invalidation on each write.

7.2.0 checked before invalidating:

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

7.2.1 replaced that with a `hotUpdate` handler declared with no parameters, so it has no
access to the change it is reacting to:

```js
// astro 7.3.1, same file
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

On each call this discards the virtual module's cached transform result and its
`ssrModule`, then walks up to every importer that has not accepted it and invalidates
those too. `isHmr` defaults to `false`, so it is a plain invalidation rather than an HMR
update. In this project that reaches six modules per request, against two when the path
check is present. Six re-transforms at a few milliseconds each are not the cost; the cost
is what an SSR invalidation makes workerd redo on the next request.

`isMiddlewarePath` is still defined and exported in 7.2.1 and 7.3.1 with no callers.
Counting occurrences of `isMiddlewarePath(` in the shipped file gives two in 7.2.0 and
one, the definition, in both later versions.

This appears to come from #17605, merged 2026-08-06, which closed #17590 by making
transitive imports of the middleware trigger HMR. Widening what counts as a relevant
change is the intent of that PR, and dropping the path check looks incidental rather than
deliberate. The `hotUpdate` hook still receives `ctx`, so a check on `ctx.file` would
restore the old behaviour without losing what #17605 added.

### Measurements

Minimal reproduction, five requests after warm-up, Linux, astro 7.3.1:

| | per request |
| --- | --- |
| as shipped | 0.46s to 0.58s |
| `src/middleware.ts` deleted | 0.13s to 0.17s |
| as shipped, with the 7.2.0 path check patched back in | 0.07s to 0.10s |

On a real application the same patch takes page loads from 7.13s to 0.12s:

| route | as shipped | path check restored |
| --- | --- | --- |
| `/` | 6.88s | 0.13s |
| `/posts` | 7.11s | 0.13s |
| `/plain` | 6.64s | 0.12s |
| `/bare-query` | 7.13s | 0.12s |

Both arms of that run are the same machine, same process, same versions; the only
difference is the guard. The cost scales with the size of the SSR module graph, which is
why the minimal reproduction shows a smaller multiple than a real app does.

### Why the reproduction uses the Cloudflare adapter

Something has to change a file for the bug to be observable, and `@cloudflare/vite-plugin`
writes Miniflare state under `.wrangler/state` on every request, inside the Vite root, so
the reproduction needs no editing or scripting. workerd is also where an SSR invalidation
is expensive enough to notice: under `@astrojs/node` the same invalidation costs about
0.11s and nothing is visible, though `hotUpdate` fires there identically.

Those writes are a separate matter for `@cloudflare/vite-plugin` and are being reported
there. They are harmless for a plugin that checks what changed: the same writes under
Cloudflare's stock TanStack Start scaffold cost nothing, because its two `hotUpdate(ctx)`
handlers read `ctx.modules`, which is empty for these paths.

## What's the expected result?

A file change that is neither the middleware nor anything the middleware imports should
not invalidate the middleware virtual module, as in 7.2.0 and earlier.

## Link to Minimal Reproducible Example

<REPRO_URL>

Three dependencies, one page, one pass-through middleware. `pnpm install && pnpm dev`,
then request `/` a few times. Deleting `src/middleware.ts` makes it about three times
faster; nothing else in the project changes.

## Participation

- [x] I am willing to submit a pull request for this issue.
