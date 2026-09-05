# astro-emdash-dev-repro

A website built with [EmDash](https://github.com/emdash-cms/emdash), a full-stack TypeScript CMS on Astro, running on Cloudflare Workers. Scaffolded from the EmDash `starter-cloudflare` template: posts, pages, categories and tags with minimal styling, meant as a base to build on.

## What's Included

- Posts with category and tag archives
- Static pages via slug routing
- Seed data with demo content
- D1 database and R2 storage pre-configured
- Dark/light mode support

## Pages

| Page | Route |
|---|---|
| Homepage | `/` |
| All posts | `/posts` |
| Single post | `/posts/:slug` |
| Category archive | `/category/:slug` |
| Tag archive | `/tag/:slug` |
| Static pages | `/:slug` |
| 404 | fallback |

## Infrastructure

- **Runtime:** Cloudflare Workers
- **Database:** D1
- **Storage:** R2
- **Framework:** Astro with `@astrojs/cloudflare`

## Local Development

```bash
pnpm install
pnpm dev
```

The site runs at http://localhost:4321 and the admin UI at
http://localhost:4321/_emdash/admin. On first run EmDash creates the local
database and loads `seed/seed.json`.

Other scripts: `pnpm build`, `pnpm preview`, `pnpm typecheck`.

## Is your setup affected?

The dev server here is slow, and it is not slow everywhere. To find out whether
your setup is affected, clone this repo, change the dependencies in
`package.json` to match your project, and run the script:

```bash
pnpm dev-load
```

It prints a verdict — `AFFECTED` or `NOT AFFECTED` — and the numbers behind it.

## What the script measures

`scripts/dev-load.mjs` starts the dev server from a clean cache, completes
setup through the dev-bypass endpoint so the admin dashboard is reachable
rather than redirecting to sign-in, then times the admin, home and posts
routes.

A response counts only if it came back 200, was larger than the byte floor,
and did not land on the sign-in page. All three checks matter: a broken setup
serves ~200-byte empty shells that render in a fraction of the time and read
as a speedup, and this server also serves intermittent 404s. Responses that
fail any check are reported separately and kept out of the medians, and a
route that cannot produce enough good responses is marked broken rather than
timed.

It also records what the dev server did to get there: whether the first start
crashed and had to be retried, which dependencies Vite discovered late, and
the process's idle CPU and memory once the requests are done.

## Variants

One run can compare several setups, because reinstalling from pnpm is far
cheaper than moving to another machine:

| id | what it changes |
| --- | --- |
| `baseline` | nothing; `package.json` and the lockfile as committed |
| `optimizedeps-include` | pre-bundles `astro/app/manifest` instead of letting Vite discover it after startup |
| `emdash-latest` | `emdash` and `@emdash-cms/cloudflare` at latest |
| `astro-latest` | `astro` and `@astrojs/cloudflare` at latest |

```bash
pnpm dev-load --variants=baseline,optimizedeps-include
pnpm dev-load --variants=all
```

Variants live in a list at the top of the script; adding one is a few lines.
`install` swaps npm packages, `vite` applies config through a generated file
so the committed `astro.config.mjs` stays stock. Package variants restore
`package.json` and the lockfile when they finish.

Other flags: `--repeats` (good responses wanted per route, default 3),
`--max-bad` (bad responses tolerated before giving up on a route, default 3),
`--min-bytes` (the empty-page floor, default 1000), `--threshold` (the slow
verdict line in ms, default 5000), `--out` (write results as JSON).

## In CI

The `Dev server load` workflow runs the same script on every pull request
across Linux, macOS and Windows on Node 22 and Node 26. Operating system and
Node version are the matrix, since those need separate runners; variants run
inside each leg, where a pnpm install is all it costs. Each leg uploads its
JSON, and `node scripts/dev-load.mjs --compare=results` joins them into one
table per variant in the job summary.

## Deploying

One-time setup in your Cloudflare account (names must match `wrangler.jsonc`):

```bash
npx wrangler d1 create astro-emdash-dev-repro
npx wrangler r2 bucket create astro-emdash-dev-repro-media
```

Then:

```bash
pnpm deploy
```

Sandboxed plugins use Dynamic Workers, which need a paid Cloudflare plan. To
run without them, remove the `worker_loaders` block from `wrangler.jsonc`.

## See Also

- [EmDash documentation](https://github.com/emdash-cms/emdash/tree/main/docs)
- [EmDash templates](https://github.com/emdash-cms/templates)
