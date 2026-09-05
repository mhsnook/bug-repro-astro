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

## Measuring dev server load times

`scripts/measure-dev-load.mjs` starts the dev server, records whether it survived
startup, and times a few requests to the admin, home and posts routes:

```bash
pnpm measure:dev-load
```

It prints a table of first/median/max response times and writes JSON with
`--out=<path>`. The `Dev server load` workflow runs it on every pull request
across Linux, macOS and Windows runners — each installs its own workerd binary
through the normal postinstall — and `scripts/compare-dev-load.mjs` joins the
three results into one table in the job summary.

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
