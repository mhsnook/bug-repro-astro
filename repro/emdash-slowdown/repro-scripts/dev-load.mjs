#!/usr/bin/env node
// One harness for the slow-dev-server repro. Runs one or more variants of this
// project against a freshly started Astro dev server on workerd, times a few
// routes, and reports whether the setup is healthy enough for those timings to
// mean anything.
//
// Two things are NOT symptoms. Both show up on healthy setups:
//   - "[setup-dev-bypass] Seed applied: 0 collections, 0 fields". Auto-seeded
//     default collections run first, so seed.json has nothing left to apply.
//   - GET /_emdash/admin returning 302. That is the redirect to sign-in, which
//     is why this script completes setup before it measures anything.
//
// Usage:
//   node repro-scripts/dev-load.mjs                        # baseline only
//   node repro-scripts/dev-load.mjs --variants=all
//   node repro-scripts/dev-load.mjs --compare=results      # join JSON from CI legs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Resolved on demand: --compare only reads JSON, and the job that runs it has
// no node_modules to resolve against.
let astroBin;
const resolveAstroBin = () => {
	astroBin ??= join(dirname(require.resolve("astro/package.json")), "bin", "astro.mjs");
	return astroBin;
};
const devLogPath = join(projectRoot, ".astro", "dev.log");
const pkgPath = join(projectRoot, "package.json");
const lockPath = join(projectRoot, "pnpm-lock.yaml");

// An empty flag counts as absent, so a caller can pass an unset value straight
// through (`--variants="$VARIANTS"`) and get the default below rather than
// having to carry a copy of it.
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a) => {
			const [k, v = "true"] = a.replace(/^--/, "").split("=");
			return [k, v];
		})
		.filter(([, v]) => v !== ""),
);

const PORT = Number(args.port ?? 4321);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPEATS = Number(args.repeats ?? 3);
const MAX_BAD = Number(args["max-bad"] ?? 3);
// Healthy content pages measure tens of KB. A broken setup serves ~200-byte
// shells that render fast and read as a speedup, so size gates the timings.
const MIN_BYTES = Number(args["min-bytes"] ?? 1_000);
const REQUEST_TIMEOUT_MS = Number(args["request-timeout"] ?? 60_000);
const STARTUP_TIMEOUT_MS = Number(args["startup-timeout"] ?? 120_000);
const START_ATTEMPTS = Number(args["start-attempts"] ?? 2);
const SLOW_THRESHOLD_MS = Number(args.threshold ?? 2_000);

// Page loads separate by better than an order of magnitude, and every group
// moves together on a faster or slower machine, so a fixed threshold drifts
// into one of them: at 5s it once called a leg serving 4.9s pages "working".
const BIMODAL_MIN_SPREAD = 10;
// A break has to be a real jump, not the widest of a smear.
const BREAK_MIN_RATIO = 2.5;
// Steps at least half as wide as the widest, in log terms, are breaks too. This
// data has more than one: macOS pages, the admin route on affected platforms
// (warmed by setup before timing starts), and their content routes are three
// groups, not two.
const BREAK_RELATIVE = 0.5;
// A lone timing sitting nearly as far from its own group as the groups sit from
// each other is not really in it. Fraction of the widest break in log terms;
// tuned against observed runs rather than derived.
const DETACHED_LOG_FRACTION = 0.4;

// Groups are found per run: the timings are sorted and cut at every step wide
// enough to be a break. Slowest group fails, fastest works, anything between is
// reported as neither. Ratios decide throughout, so a uniformly faster or
// slower machine moves every group together and the verdicts hold.
//
// Without a wide enough spread, or without any real jump in it, there is
// nothing to cut and callers get an absolute answer instead.
function splitByMode(valuesMs, absoluteMs = SLOW_THRESHOLD_MS) {
	const sorted = valuesMs.filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
	if (sorted.length < 2) return null;
	const lo = sorted[0];
	const hi = sorted[sorted.length - 1];
	const spread = hi / lo;
	const absolute = (why) => ({
		bimodal: false,
		why,
		lo,
		hi,
		spread,
		absoluteMs,
		isSlow: (ms) => (ms ?? hi) >= absoluteMs,
		isAmbiguous: () => false,
	});

	if (spread < BIMODAL_MIN_SPREAD) return absolute("tight");

	const steps = sorted
		.slice(1)
		.map((v, i) => ({ ratio: v / sorted[i], from: sorted[i], to: v }))
		.sort((a, b) => b.ratio - a.ratio);
	const widest = steps[0];
	if (widest.ratio < BREAK_MIN_RATIO) return absolute("smear");

	const breaks = steps
		.filter((st) => Math.log(st.ratio) >= Math.log(widest.ratio) * BREAK_RELATIVE)
		.sort((a, b) => a.from - b.from);
	const edges = breaks.map((b) => b.to);
	const groupOf = (ms) => edges.filter((e) => ms >= e).length;
	const top = breaks.length;

	// Nearest neighbour inside the same group. Far from it means the value is
	// carried by nothing and should not firm up a verdict on its own.
	const detached = (ms) => {
		const peers = sorted.filter((v) => v !== ms && groupOf(v) === groupOf(ms));
		if (peers.length === 0) return true;
		const nearest = peers.reduce((best, v) =>
			Math.abs(Math.log(v / ms)) < Math.abs(Math.log(best / ms)) ? v : best,
		);
		const apart = Math.max(nearest / ms, ms / nearest);
		return Math.log(apart) / Math.log(widest.ratio) >= DETACHED_LOG_FRACTION;
	};

	const isAmbiguous = (ms) => {
		const g = groupOf(ms);
		return (g > 0 && g < top) || detached(ms);
	};

	return {
		bimodal: true,
		lo,
		hi,
		spread,
		gap: widest,
		breaks,
		groups: top + 1,
		bandLo: widest.from,
		bandHi: widest.to,
		isAmbiguous,
		// Not firmly in the slowest group means not firm evidence of it.
		isSlow: (ms) => groupOf(ms) === top && !isAmbiguous(ms),
	};
}
// In CI the leg names itself, so the workflow carries no --label or --out and
// stays untouched when the reporting changes.
const CI_LEG = process.env.GITHUB_ACTIONS
	? `${(process.env.RUNNER_OS ?? process.platform).toLowerCase()}-node${process.versions.node.split(".")[0]}`
	: null;
const LABEL = args.label ?? CI_LEG ?? `${process.platform}-${process.arch}`;
const OUT = args.out ? resolve(args.out) : CI_LEG ? resolve(`dev-load-${CI_LEG}.json`) : null;

// A variant is a way of setting this project up. `install` swaps npm packages
// (a pnpm reinstall, far cheaper than another CI runner); `vite` is applied
// through a generated config so the committed astro.config.mjs stays stock.
const VARIANTS = [
	{
		id: "baseline",
		description: "package.json and lockfile exactly as committed",
	},
	{
		id: "watch-ignore-wrangler",
		description: "keep Vite's file watcher out of .wrangler, where Miniflare writes state on every request",
		vite: { server: { watch: { ignored: ["**/.wrangler/**"] } } },
	},
	{
		id: "emdash-latest",
		description: "emdash and @emdash-cms/cloudflare at latest",
		install: { emdash: "latest", "@emdash-cms/cloudflare": "latest" },
	},
	{
		id: "astro-latest",
		description: "astro and @astrojs/cloudflare at latest",
		install: { astro: "latest", "@astrojs/cloudflare": "latest" },
	},
	{
		// 7.2.0 is the last release whose middleware plugin checked the changed
		// path before invalidating; 7.2.1 replaced that with a hotUpdate handler
		// taking no arguments. The adapter pinned here declares peer astro ^7.2.0,
		// so this downgrades astro alone and nothing else moves.
		id: "astro-7.2.0",
		description: "astro pinned to 7.2.0, the last release that checked which file changed",
		install: { astro: "7.2.0" },
	},
];

const LOG_SIGNATURES = [
	["staleChunk", "does not exist at"],
	["depsChanged", "optimized dependencies changed"],
	["programReload", "program reload"],
	["uncaughtException", "Uncaught exception"],
	["unresolved", "Unable to resolve"],
];

// /plain and /bare-query are controls: an Astro page with no EmDash in it, and
// one with a single collection query and nothing else. Where the time lands
// between those and the real pages says which layer is slow.
const ROUTES = [
	{ path: "/_emdash/admin", name: "admin" },
	{ path: "/", name: "home" },
	{ path: "/posts", name: "posts" },
	{ path: "/plain", name: "plain" },
	{ path: "/bare-query", name: "bare-query" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (ms) => (ms / 1000).toFixed(2);
const fmt = (v) => (v === null || v === undefined ? "—" : `${seconds(v)}s`);

function run(cmd, argv, { timeout = 600_000 } = {}) {
	return new Promise((done) => {
		const child = spawn(cmd, argv, {
			cwd: projectRoot,
			env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, out });
		});
	});
}

const astro = (argv) => run(process.execPath, [resolveAstroBin(), ...argv]);
// npm_execpath is only set when this runs as a package script; run it through
// node when it is a JS entry point, and fall back to the shim otherwise.
const pnpm = (argv) => {
	const exec = process.env.npm_execpath;
	if (exec && /\.[cm]?js$/.test(exec)) return run(process.execPath, [exec, ...argv]);
	return run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", argv);
};

function tailDevLog(lines = 30) {
	if (!existsSync(devLogPath)) return "(no .astro/dev.log)";
	return readFileSync(devLogPath, "utf8")
		.replace(/\[[0-9;]*m/g, "")
		.trim()
		.split("\n")
		.slice(-lines)
		.join("\n");
}

function logSignals() {
	if (!existsSync(devLogPath)) return {};
	const log = readFileSync(devLogPath, "utf8");
	const signals = Object.fromEntries(
		LOG_SIGNATURES.map(([key, needle]) => [key, log.split(needle).length - 1]),
	);
	signals.lateDeps = [...new Set(log.match(/dependency optimized: [^"\\]+/g) ?? [])].map((s) =>
		s.replace("dependency optimized: ", ""),
	);
	return signals;
}

function installedVersions() {
	const names = ["astro", "emdash", "@astrojs/cloudflare", "@emdash-cms/cloudflare"];
	const versions = {};
	for (const name of names) {
		try {
			versions[name] = require(join(projectRoot, "node_modules", name, "package.json")).version;
		} catch {
			versions[name] = null;
		}
	}
	try {
		const entry = readdirSync(join(projectRoot, "node_modules", ".pnpm")).find((d) =>
			d.startsWith("workerd@"),
		);
		versions.workerd = entry ? entry.slice("workerd@".length).split("_")[0] : null;
	} catch {
		versions.workerd = null;
	}
	return versions;
}

// --- one cookie jar per variant: dev-bypass hands back a session on a redirect,
// and fetch's own redirect following would swallow that Set-Cookie.
function makeJar() {
	const jar = new Map();
	return {
		header: () =>
			[...jar].map(([k, v]) => `${k}=${v}`).join("; "),
		absorb: (res) => {
			for (const raw of res.headers.getSetCookie?.() ?? []) {
				const pair = raw.split(";")[0];
				const eq = pair.indexOf("=");
				if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
			}
		},
	};
}

async function request(url, jar) {
	const started = performance.now();
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let current = url;
	try {
		for (let hop = 0; hop < 6; hop++) {
			const headers = jar.header() ? { cookie: jar.header() } : {};
			const res = await fetch(current, { redirect: "manual", headers, signal });
			jar.absorb(res);
			const location = res.headers.get("location");
			if (res.status >= 300 && res.status < 400 && location) {
				await res.arrayBuffer().catch(() => {});
				current = new URL(location, current).toString();
				continue;
			}
			const body = await res.arrayBuffer();
			return {
				ms: Math.round(performance.now() - started),
				status: res.status,
				bytes: body.byteLength,
				finalUrl: current,
			};
		}
		return { ms: Math.round(performance.now() - started), status: null, error: "too many redirects" };
	} catch (err) {
		return {
			ms: Math.round(performance.now() - started),
			status: null,
			error: err?.name === "TimeoutError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String(err),
		};
	}
}

// A sample counts only if the request succeeded AND returned a real page. A 404
// and a 200-shaped empty shell are both fast, and both would flatter the median.
function why(sample) {
	if (sample.status === null) return sample.error?.startsWith("timeout") ? "timeout" : "error";
	if (sample.status !== 200) return String(sample.status);
	if (sample.bytes < MIN_BYTES) return `empty(${sample.bytes}b)`;
	if (/\/_emdash\/admin\/(login|setup)/.test(sample.finalUrl ?? "")) return "signed-out";
	return null;
}

async function startDevServer(configPath) {
	const attempts = [];
	for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
		const argv = ["dev", "--background", `--port=${PORT}`, "--host=127.0.0.1"];
		if (configPath) argv.push(`--config=${configPath}`);
		await astro(argv);
		const startedAt = Date.now();
		let ready = false;
		while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
			const probe = await request(`${ORIGIN}/_emdash/admin`, makeJar());
			if (probe.status !== null) {
				ready = true;
				break;
			}
			const status = await astro(["dev", "status"]);
			if (/No dev server is running/.test(status.out)) break;
			await sleep(1_000);
		}
		attempts.push({
			attempt,
			ready,
			seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
			devLog: ready ? null : tailDevLog(),
		});
		console.log(
			ready
				? `  dev server ready on attempt ${attempt} (${attempts.at(-1).seconds}s)`
				: `  dev server FAILED to start on attempt ${attempt}`,
		);
		if (!ready) console.log(tailDevLog().replace(/^/gm, "    "));
		if (ready) return { ready: true, attempts };
		await stopDevServer();
	}
	return { ready: false, attempts };
}

// `astro dev stop` returns before workerd has exited, and Windows will not
// delete files a live process still holds open.
async function stopDevServer() {
	await astro(["dev", "stop"]);
	for (let i = 0; i < 20; i++) {
		const { out } = await astro(["dev", "status"]);
		if (/No dev server is running/.test(out)) break;
		await sleep(500);
	}
	await sleep(1_000);
}

function clearCaches() {
	const failed = [];
	for (const dir of [".astro", ".wrangler", "node_modules/.vite"]) {
		try {
			rmSync(join(projectRoot, dir), {
				recursive: true,
				force: true,
				maxRetries: 20,
				retryDelay: 250,
			});
		} catch (err) {
			failed.push(`${dir} (${err.code ?? err.message})`);
		}
	}
	return failed;
}

// ps's pcpu is CPU time over the process's whole life, which after a slow
// startup reads as a busy server even when it is asleep. Sample cumulative
// CPU time twice instead and report the rate over the gap.
async function processStats(pid) {
	if (!pid || process.platform === "win32") return null;
	const sample = async () => {
		const { out, code } = await run("ps", ["-o", "time=,rss=", "-p", String(pid)], { timeout: 10_000 });
		if (code !== 0) return null;
		const [time, rss] = out.trim().split(/\s+/);
		const parts = time.split(/[:.]/).map(Number);
		const cpuSeconds = parts.reduce((total, part) => total * 60 + part, 0);
		return { cpuSeconds, rssMb: Math.round(Number(rss) / 1024) };
	};
	const before = await sample();
	if (!before) return null;
	const gapMs = 3_000;
	await sleep(gapMs);
	const after = await sample();
	if (!after) return null;
	return {
		cpuPercent: Math.round(((after.cpuSeconds - before.cpuSeconds) / (gapMs / 1000)) * 100),
		rssMb: after.rssMb,
	};
}

async function devServerPid() {
	const { out } = await astro(["dev", "status"]);
	return Number(out.match(/pid (\d+)/)?.[1]) || null;
}

function writeVariantConfig(variant) {
	if (!variant.vite) return null;
	// Astro rejects an absolute --config path, and the dev server runs with
	// projectRoot as its cwd, so hand it the bare filename.
	const name = `dev-load-${variant.id}.config.mjs`;
	const path = join(projectRoot, name);
	writeFileSync(
		path,
		`import base from "./astro.config.mjs";\n` +
			`export default { ...base, vite: { ...base.vite, ...${JSON.stringify(variant.vite)} } };\n`,
	);
	return { name, path };
}

async function applyInstall(variant) {
	if (!variant.install) return false;
	copyFileSync(pkgPath, `${pkgPath}.dev-load-backup`);
	copyFileSync(lockPath, `${lockPath}.dev-load-backup`);
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	Object.assign(pkg.dependencies, variant.install);
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	console.log(`  installing ${Object.entries(variant.install).map(([k, v]) => `${k}@${v}`).join(" ")}`);
	const { code, out } = await pnpm(["install", "--no-frozen-lockfile"]);
	if (code !== 0) console.log(out.trim().split("\n").slice(-15).join("\n").replace(/^/gm, "    "));
	return true;
}

function restoreInstall() {
	for (const path of [pkgPath, lockPath]) {
		if (existsSync(`${path}.dev-load-backup`)) {
			copyFileSync(`${path}.dev-load-backup`, path);
			unlinkSync(`${path}.dev-load-backup`);
		}
	}
}

async function measureVariant(variant) {
	console.log(`\n=== ${variant.id} — ${variant.description}`);
	let installed = false;
	let configFile = null;
	try {
		installed = await applyInstall(variant);
		configFile = writeVariantConfig(variant);

		// D1 persists under .wrangler in the project, so this is also a fresh database.
		await stopDevServer();
		const cacheFailures = clearCaches();
		if (cacheFailures.length) {
			console.log(`  could not clear ${cacheFailures.join(", ")} — this run is not cold`);
		}

		const versions = installedVersions();
		const startup = await startDevServer(configFile?.name);
		if (!startup.ready) {
			return {
				...variant,
				versions,
				startup: summariseStartup(startup),
				cacheFailures,
				setup: null,
				routes: [],
				signals: logSignals(),
				process: null,
				healthy: false,
				verdict: "DEAD — dev server never became ready",
			};
		}

		const jar = makeJar();
		const setup = await request(
			`${ORIGIN}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`,
			jar,
		);
		console.log(`  setup dev-bypass: ${setup.status ?? "ERR"} in ${seconds(setup.ms)}s`);

		const routes = [];
		for (const route of ROUTES) {
			const ok = [];
			const bad = [];
			while (ok.length < REPEATS && bad.length < MAX_BAD) {
				const sample = await request(`${ORIGIN}${route.path}`, jar);
				const reason = why(sample);
				(reason ? bad : ok).push(reason ? { ...sample, reason } : sample);
				console.log(
					`  ${route.path} ${reason ? "!!" : `#${ok.length}`}: ${sample.status ?? "ERR"} ` +
						`${sample.bytes ?? 0}b in ${seconds(sample.ms)}s${reason ? ` — ${reason}, not counted` : ""}`,
				);
			}
			const ms = ok.map((s) => s.ms);
			routes.push({
				...route,
				wanted: REPEATS,
				ok: ok.length,
				complete: ok.length === REPEATS,
				okSamples: ok,
				badSamples: bad,
				bytes: ok[0]?.bytes ?? null,
				finalUrl: ok[0]?.finalUrl ?? bad[0]?.finalUrl ?? null,
				firstMs: ms[0] ?? null,
				medianMs: ms.length ? [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] : null,
				maxMs: ms.length ? Math.max(...ms) : null,
			});
		}

		const stats = await processStats(await devServerPid());
		const signals = logSignals();
		await stopDevServer();

		const healthy = setup.status === 200 && routes.every((r) => r.complete);
		const timed = routes.filter((r) => r.medianMs !== null);
		const worst = timed.length ? Math.max(...timed.map((r) => r.medianMs)) : null;
		const split = splitByMode(timed.map((r) => r.medianMs));
		const verdict = !healthy
			? `BROKEN — ${describeUnhealthy(setup, routes)}; do not compare these timings`
			: !split
				? "NO DATA — nothing timed"
				: !split.bimodal
					? `${split.isSlow() ? "SLOW" : "FAST"} — every route within ${split.spread.toFixed(1)}x of the others, worst ${seconds(worst)}s, judged against ${seconds(split.absoluteMs)}s`
					: timed.some((r) => split.isSlow(r.medianMs))
						? `SLOW — ${timed.filter((r) => split.isSlow(r.medianMs)).length} of ${timed.length} routes over ${seconds(split.bandHi)}s, worst ${seconds(worst)}s`
						: `FAST — every route under ${seconds(split.bandHi)}s, worst ${seconds(worst)}s`;

		console.log(`  ${verdict}`);
		return {
			...variant,
			versions,
			startup: summariseStartup(startup),
			cacheFailures,
			setup: { status: setup.status, ms: setup.ms },
			routes,
			signals,
			process: stats,
			healthy,
			worstMedianMs: worst,
			verdict,
		};
	} finally {
		await stopDevServer();
		if (configFile) rmSync(configFile.path, { force: true });
		if (installed) {
			restoreInstall();
			await pnpm(["install", "--frozen-lockfile"]);
		}
	}
}

function summariseStartup(startup) {
	return {
		ready: startup.ready,
		attemptsUsed: startup.attempts.length,
		coldStartCrashed: !startup.attempts[0].ready,
		attempts: startup.attempts,
	};
}

function describeUnhealthy(setup, routes) {
	const reasons = [];
	if (setup.status !== 200) reasons.push(`dev-bypass returned ${setup.status ?? "no response"}`);
	for (const r of routes.filter((x) => !x.complete)) {
		reasons.push(`${r.path} gave up at ${r.ok}/${r.wanted} (${[...new Set(r.badSamples.map((s) => s.reason))].join(", ")})`);
	}
	return reasons.join("; ");
}

function variantTable(variants) {
	const paths = ROUTES.map((r) => r.path);
	return [
		`| variant | ${paths.map((p) => `\`${p}\``).join(" | ")} | cold start | health |`,
		`| --- | ${paths.map(() => "---").join(" | ")} | --- | --- |`,
		...variants.map((v) => {
			const cells = paths.map((p) => {
				const r = v.routes.find((x) => x.path === p);
				if (!r) return "—";
				const bad = r.badSamples.length ? ` (${r.badSamples.length} ✗)` : "";
				return `${fmt(r.medianMs)}${bad}`;
			});
			const cold = !v.startup.ready
				? "dead"
				: v.startup.coldStartCrashed
					? `crashed, ok on ${v.startup.attemptsUsed}`
					: "ok";
			return `| \`${v.id}\` | ${cells.join(" | ")} | ${cold} | ${v.healthy ? "ok" : "**broken**"} |`;
		}),
	];
}

// Upserts one comment on the pull request, keyed on a marker, so each run
// replaces the last rather than stacking. Lives here rather than in the
// workflow so a change to it is an ordinary push.
const COMMENT_MARKER = "<!-- dev-load-report -->";

async function postComment(markdown) {
	const token = process.env.GITHUB_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!token || !repo || !eventPath || !existsSync(eventPath)) {
		console.log("Not a pull request build with a token; skipping the comment.");
		return;
	}
	const event = JSON.parse(readFileSync(eventPath, "utf8"));
	const pr = event.pull_request?.number;
	if (!pr) {
		console.log("No pull request in the event payload; skipping the comment.");
		return;
	}

	const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
	const api = (path, init = {}) =>
		fetch(`${base}/repos/${repo}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
				...init.headers,
			},
		});

	const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
	const runUrl = `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
	// GITHUB_SHA is the throwaway merge commit on a pull_request event, and it
	// exists on no branch. The head sha is the one worth printing.
	const sha = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? "";
	const body = [
		COMMENT_MARKER,
		markdown,
		"",
		`[Run ${process.env.GITHUB_RUN_NUMBER}](${runUrl})${sha ? ` on \`${sha}\`` : ""}.`,
	].join("\n");

	// Walk every page: the marker can sit anywhere in a long thread.
	let existing = null;
	for (let page = 1; page <= 20 && !existing; page++) {
		const res = await api(`/issues/${pr}/comments?per_page=100&page=${page}`);
		if (!res.ok) throw new Error(`listing comments failed: ${res.status} ${await res.text()}`);
		const batch = await res.json();
		existing = batch.find((c) => c.body?.startsWith(COMMENT_MARKER)) ?? null;
		if (batch.length < 100) break;
	}

	const res = existing
		? await api(`/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
		: await api(`/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
	if (!res.ok) throw new Error(`posting the comment failed: ${res.status} ${await res.text()}`);
	console.log(`${existing ? "Updated" : "Posted"} the report comment on #${pr}.`);
}

// --- compare mode: join the JSON one CI leg per platform leaves behind -------
if (args.compare) {
	const dir = resolve(args.compare);
	// Every measure leg can fail before uploading anything, in which case the
	// download step leaves no directory at all.
	if (!existsSync(dir)) {
		console.log(`No results at ${dir}: every measuring job failed before uploading.`);
		process.exit(0);
	}
	const runs = [];
	const watchers = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
			if (Array.isArray(parsed.variants) && parsed.label) runs.push(parsed);
			else if (parsed.label && typeof parsed.hotUpdatesPerRequest === "number") {
				watchers.push(parsed);
			} else console.log(`Skipping ${file}: not a dev-load or watcher result.`);
		} catch (err) {
			// One unreadable artifact should not take the whole report down with it.
			console.log(`Skipping ${file}: ${err.message}`);
		}
	}
	runs.sort((a, b) => a.label.localeCompare(b.label));
	watchers.sort((a, b) => a.label.localeCompare(b.label));

	if (runs.length === 0 && watchers.length === 0) {
		console.log("No results to compare.");
		process.exit(0);
	}

	// A leg earns its place in the matrix by showing at least one symptom.
	// Page loads land in one of two places, with nothing in between: a fraction
	// of a second, or seconds. The threshold sits in that gap.
	const rendersOf = (run) => {
		const split = splits.get(run.label);
		const timed = run.variants.flatMap((v) => v.routes.filter((r) => r.medianMs !== null));
		if (timed.length === 0 || !split) return "—";
		if (timed.some((r) => split.isSlow(r.medianMs))) return "**failing**";
		if (timed.some((r) => split.isAmbiguous(r.medianMs))) return "unclear";
		return "working";
	};

	const symptomsOf = (run) => {
		const split = splits.get(run.label);
		const seen = new Set();
		// Worst across variants, counted once: two variants seeing 2 and 3 slow
		// routes is one symptom at its worst, not two separate findings.
		let slowest = 0;
		let middling = 0;
		for (const v of run.variants) {
			if (!v.startup?.ready) seen.add("dev server dead");
			else if (v.startup.coldStartCrashed) seen.add("cold-start crash");
			if (!v.healthy) seen.add("broken setup");
			if (v.routes.reduce((n, r) => n + r.badSamples.length, 0)) {
				seen.add("non-200 or empty responses");
			}
			slowest = Math.max(
				slowest,
				v.routes.filter((r) => r.medianMs !== null && split?.isSlow(r.medianMs)).length,
			);
			middling = Math.max(
				middling,
				v.routes.filter((r) => r.medianMs !== null && split?.isAmbiguous(r.medianMs)).length,
			);
		}
		if (slowest) seen.add(`up to ${slowest} slow route${slowest === 1 ? "" : "s"}`);
		if (middling) seen.add(`${middling} route${middling === 1 ? "" : "s"} in neither group`);
		return [...seen];
	};

	// One split for the whole report, pooled across every leg, so the platforms
	// are read against each other rather than each against its own spread.
	// One split per leg, over that leg's own timings. Pooling every leg would put
	// the widest break on the platform boundary — macOS against Windows, which is
	// already known — instead of on the structure inside one machine, and would
	// make each leg's verdict depend on which other legs happened to run.
	const splits = new Map(
		runs.map((r) => [
			r.label,
			splitByMode(
				r.variants.flatMap((v) =>
					v.routes.filter((x) => x.medianMs !== null).map((x) => x.medianMs),
				),
			),
		]),
	);

	// Where a leg's own timings separate. A leg whose routes all land together
	// has no structure to read and is judged against the absolute threshold.
	const groupsOf = (run) => {
		const split = splits.get(run.label);
		if (!split) return "—";
		if (!split.bimodal) return `${seconds(split.lo)}–${seconds(split.hi)}s, one group`;
		const edges = [split.lo, ...split.breaks.map((b) => b.to)];
		const ends = [...split.breaks.map((b) => b.from), split.hi];
		return edges
			.map((from, i) => (from === ends[i] ? `${seconds(from)}s` : `${seconds(from)}–${seconds(ends[i])}s`))
			.join(" · ");
	};

	const ids = [...new Set(runs.flatMap((r) => r.variants.map((v) => v.id)))];
	const paths = [...new Set(runs.flatMap((r) => r.variants.flatMap((v) => v.routes.map((x) => x.path))))];
	const md = [
		"## Dev server load times",
		"",
		...(runs.length === 0
			? ["Every measuring leg failed before uploading a result, so there are no timings."]
			: [
					`Median of ${runs[0].settings.repeats} healthy 200s per route. A response that was not 200,`,
					`came back under ${runs[0].settings.minBytes} bytes, or landed on the sign-in page is excluded`,
					"and counted as ✗. Rows marked broken served empty pages, so their timings mean nothing.",
				]),
		"",
		...ids.flatMap((id) => [
			`### \`${id}\``,
			"",
			`| platform | ${paths.map((p) => `\`${p}\``).join(" | ")} | cold start | health |`,
			`| --- | ${paths.map(() => "---").join(" | ")} | --- | --- |`,
			...runs.map((run) => {
				const v = run.variants.find((x) => x.id === id);
				if (!v) return `| ${run.label} | ${paths.map(() => "—").join(" | ")} | — | not run |`;
				const cells = paths.map((p) => {
					const r = v.routes.find((x) => x.path === p);
					if (!r) return "—";
					return `${fmt(r.medianMs)}${r.badSamples.length ? ` (${r.badSamples.length} ✗)` : ""}`;
				});
				const cold = !v.startup.ready
					? "dead"
					: v.startup.coldStartCrashed
						? `crashed, ok on ${v.startup.attemptsUsed}`
						: "ok";
				return `| ${run.label} | ${cells.join(" | ")} | ${cold} | ${v.healthy ? "ok" : "**broken**"} |`;
			}),
			"",
		]),
		...(runs.length === 0
			? []
			: [
					"### Which legs reproduce anything",
					"",
					"This repo exists to show the bug. A leg that stays clean across every",
					"variant is not evidence of health, it is a leg with nothing to report,",
					"and it can come out of the matrix.",
					"",
					"Renders are read as a verdict, not a score, and each leg is read on its",
					"own timings: they are sorted and cut at every step wide enough to be a",
					"break, the slowest group failing and the fastest working, with anything",
					"between reported as neither. Ratios decide, so a uniformly faster or",
					"slower machine moves its groups together and its verdict holds.",
					"",
					"Legs are never pooled. The widest break across all of them would fall on",
					"the platform boundary, which is the thing being measured, and every leg's",
					`verdict would then depend on which others ran. A leg whose routes all land`,
					`together has no groups to find and is judged against ${seconds(SLOW_THRESHOLD_MS)}s outright.`,
					"",
					"| platform | renders | groups | symptoms |",
					"| --- | --- | --- | --- |",
					...runs.map(
						(r) =>
							`| ${r.label} | ${rendersOf(r)} | ${groupsOf(r)} | ${symptomsOf(r).join(", ") || "**none**"} |`,
					),
					"",
					(() => {
						const clean = runs.filter((r) => symptomsOf(r).length === 0).map((r) => r.label);
						return clean.length
							? `Reproduced nothing, so candidates to strike: ${clean.join(", ")}.`
							: "Every leg reproduced at least one symptom.";
					})(),
					"",
				]),
		...(watchers.length === 0
			? []
			: [
					"### Why those legs and not the others",
					"",
					"`repro/minimal` on the same runners: vite plus `@cloudflare/vite-plugin`,",
					"no framework, no bindings, nothing edited. It counts how many `hotUpdate`",
					"hooks a request causes, which is a property of the platform's file watcher.",
					"",
					"| platform | hooks per request | files written under `.wrangler/state` | requests |",
					"| --- | --- | --- | --- |",
					...watchers.map(
						(w) =>
							`| ${w.label} | ${w.hotUpdatesPerRequest === 0 ? "**0**" : w.hotUpdatesPerRequest} | ${w.wranglerFiles} | ${w.requests}${w.allRequestsOk ? "" : ", **not all 200**"} |`,
					),
					"",
					watchers.some((w) => w.hotUpdatesPerRequest === 0)
						? `Every platform writes the same files. ${watchers
								.filter((w) => w.hotUpdatesPerRequest === 0)
								.map((w) => w.label)
								.join(", ")} never sees them, so nothing is invalidated and nothing costs anything there.`
						: "Every platform's watcher reports the writes.",
					"",
				]),
		...(runs.length === 0
			? []
			: [
					"| platform | node | astro | emdash | workerd |",
					"| --- | --- | --- | --- | --- |",
					...runs.map((r) => {
						const v = r.variants[0]?.versions ?? {};
						return `| ${r.label} | ${r.node} | ${v.astro ?? "?"} | ${v.emdash ?? "?"} | ${v.workerd ?? "?"} |`;
					}),
				]),
	].join("\n");

	console.log(md);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
	if (args.comment) await postComment(md);
	process.exit(0);
}

// --- measure mode -----------------------------------------------------------
const selected =
	args.variants === "all"
		? VARIANTS
		: (() => {
				const asked = (args.variants ?? "baseline").split(",").map((id) => id.trim());
				const found = asked
					.map((id) => VARIANTS.find((v) => v.id === id))
					.filter((v, i) => {
						// A retired variant left behind in a caller's default should not
						// take the whole run down with it.
						if (!v) console.error(`Skipping unknown variant "${asked[i]}".`);
						return Boolean(v);
					});
				if (found.length === 0) {
					console.error(`No known variants in "${asked.join(",")}". Known: ${VARIANTS.map((v) => v.id).join(", ")}`);
					process.exit(2);
				}
				return found;
			})();

const results = [];
for (const variant of selected) {
	results.push(await measureVariant(variant));
}

const anyReady = results.some((v) => v.startup.ready);
const healthy = results.filter((v) => v.healthy);
const slowest = healthy.length ? Math.max(...healthy.map((v) => v.worstMedianMs ?? 0)) : null;
const runSplit = splitByMode(
	healthy.flatMap((v) => v.routes.filter((r) => r.medianMs !== null).map((r) => r.medianMs)),
);
const affected = runSplit?.bimodal
	? healthy.some((v) => v.routes.some((r) => r.medianMs !== null && runSplit.isSlow(r.medianMs)))
	: runSplit?.isSlow();
const verdict = !anyReady
	? "DEAD — no variant produced a running dev server"
	: healthy.length === 0
		? "BROKEN — no variant produced a healthy setup, so nothing here is comparable"
		: !runSplit
			? "NO DATA — nothing timed"
			: affected
				? `AFFECTED — slowest healthy median ${seconds(slowest)}s${runSplit.bimodal ? `, against a fast group topping out at ${seconds(runSplit.bandLo)}s` : ""}`
				: `NOT AFFECTED — slowest healthy median ${seconds(slowest)}s`;

const result = {
	label: LABEL,
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	settings: {
		repeats: REPEATS,
		maxBad: MAX_BAD,
		minBytes: MIN_BYTES,
		thresholdMs: SLOW_THRESHOLD_MS,
	},
	variants: results,
	verdict,
};

const md = [
	`### ${LABEL} — ${verdict}`,
	"",
	`Node ${process.version} · ${REPEATS} healthy 200s per route · pages under ${MIN_BYTES} bytes rejected`,
	"",
	...variantTable(results),
	"",
	...results.flatMap((v) => {
		const notes = [];
		if (v.signals?.staleChunk) notes.push(`${v.signals.staleChunk}× stale optimizer chunk`);
		if (v.signals?.lateDeps?.length) notes.push(`late deps: ${v.signals.lateDeps.join(", ")}`);
		if (v.process) notes.push(`idle ${v.process.cpuPercent}% cpu, ${v.process.rssMb} MB`);
		if (v.cacheFailures?.length) notes.push(`**not a cold start**: ${v.cacheFailures.join(", ")} survived`);
		return notes.length ? [`- \`${v.id}\`: ${notes.join(" · ")}`] : [];
	}),
].join("\n");

console.log(`\n${md}\n`);
if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);

// Only an unusable setup fails the run; slowness is the finding, not an error.
process.exit(anyReady ? 0 : 1);
