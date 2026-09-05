# @cloudflare/vite-plugin invalidates the dev server against itself

Minimal reproduction: `vite` plus `@cloudflare/vite-plugin`, one worker that returns
`"hello"`, no bindings, no `observability` config, no framework.

Miniflare persists state under `.wrangler/state`, which is inside the Vite root and
is not excluded from the watcher. Every request writes there, so Vite reports a file
change and runs every plugin's `hotUpdate` hook — while the user edits nothing.

## Running it

```bash
pnpm install
pnpm dev            # http://localhost:5173
```

Then request the page a few times and watch the terminal.

## What it shows

Six requests, nothing edited, on `@cloudflare/vite-plugin` 1.54.2 and vite 8.2.2:

```
#1: 200 0.020s   #2: 200 0.022s   #3: 200 0.020s
#4: 200 0.025s   #5: 200 0.019s   #6: 200 0.020s

[counts-hot-updates] hotUpdate #28 in env "client"
[counts-hot-updates] hotUpdate #29 in env "ssr"
[counts-hot-updates] hotUpdate #30 in env "bare_cf"
```

`vite.config.ts` contains a plugin that does nothing but count `hotUpdate` calls.

`count-hot-updates.mjs` reports the same thing with startup separated out, which is the
number worth quoting:

```
$ node count-hot-updates.mjs
### linux
requests            6, all 200: true
timings             31ms, 30ms, 23ms, 24ms, 29ms, 27ms
hotUpdate hooks     18 during requests (3/request)
files in .wrangler  9
```

Three per request, every request, with nothing edited. Starting the server accounts for
another 57, which is expected and not the point.

The writes behind it, with `DEBUG=vite:hmr pnpm dev`:

```
vite:hmr [file change] .wrangler/state/v3/observability/miniflare-wobs-trace-store/<hash>.sqlite-wal
vite:hmr (ssr)     [no modules matched] …
vite:hmr (bare_cf) [no modules matched] …
vite:hmr (client)  [no modules matched] …
```

Nine files under `.wrangler/state` are touched per request — the observability trace
store and the cache metadata store, neither of which this project configures.

## Why it is usually invisible, and when it is not

Vite matches no modules for these paths, so on its own nothing rebuilds and requests
stay in the 20ms range. The events still reach every plugin's `hotUpdate` hook, and a
plugin that invalidates without inspecting which file changed will do so on every
request forever.

Astro's middleware plugin is one. Its handler takes no arguments, so it cannot check:

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

On an Astro site whose middleware pulls in a large SSR graph, that invalidation makes
workerd re-bundle the worker entry on every request. Measured on the parent repository
of this reproduction: **8 to 16 seconds per page load, repeatably**, with nothing edited.

Two comparisons place the cost:

- The same site on `@astrojs/node` serves in **0.11s**. It invalidates too; rebuilding
  in-process is just cheap. Forcing a watcher event there with `touch data.db` changed
  nothing (0.114s against a 0.114s baseline).
- macOS reproduces the startup faults but not the slow renders, which fits FSEvents
  surfacing sqlite WAL writes differently from inotify and ReadDirectoryChangesW.

## The fix

Excluding the persist directory from the watcher removes it:

```js
vite: { server: { watch: { ignored: ["**/.wrangler/**"] } } }
```

Measured on the parent repository: first request 8.3s to compile, then **0.14s** each,
against 16s every time without it. Ignoring `.astro` instead changed nothing, which is
what rules out watcher volume as the explanation — `.astro/dev.log` produced more events
than `.wrangler` did.

The plugin already knows this path; it defines `defaultPersistPath = ".wrangler/state"`.
Nothing in its dist sets `server.watch.ignored`.

## Versions

`@cloudflare/vite-plugin` 1.54.2 · vite 8.2.2 · wrangler 4.129.0 · node 22.22.2 · Linux x64
