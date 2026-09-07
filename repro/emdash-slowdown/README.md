# What the watcher self-invalidation costs

One of two reproductions in this repository. This one shows the **cost**;
[`repro/minimal`](../minimal) shows the **trigger** with no framework at all. The
[root README](../../README.md) explains the split.

An EmDash site on Astro and the Cloudflare adapter, scaffolded from the
`starter-cloudflare` template and stripped down. Every request writes into
`.wrangler/state`, Vite reports the change, and Astro's middleware plugin invalidates
its virtual module without checking which file changed.

```bash
pnpm install
pnpm dev-load
```

## Measured here

With `vite.server.watch.ignored` set against unset:

```
baseline                    with **/.wrangler/** ignored
  7.98s  6 modules            1.41s  2 modules
  7.43s  6 modules            0.92s  2 modules
  8.09s  6 modules            0.93s  2 modules
```

Six modules re-transform either way. Individual transforms run 2 to 6ms, so the seven
seconds are not re-transformation — they are what an SSR invalidation costs on the
workerd side. The same site on `@astrojs/node` serves in 0.11s with the same
invalidation happening.

`DEBUG=vite:transform` inflates both arms. Uninstrumented the same change measured
16s → 0.14s, so the ratio is the finding rather than the absolute times.

## The harness

`repro-scripts/dev-load.mjs` starts the dev server, completes setup through the
dev-bypass endpoint so the admin route is the dashboard rather than a sign-in redirect,
and times the routes. A response counts only if it was 200, cleared a byte floor and did
not land on the sign-in page: a broken setup serves ~200-byte shells that render fast and
read as a speedup.

It retries a failed start once. The `astro/logger/console` cold-start crash
([#13](../../issues/13)) kills most cold starts here.

Variants let one run compare setups — `--variants=all`, or `emdash-latest` and
`astro-latest` to test whether a newer release fixes it.
