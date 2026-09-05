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
//   node scripts/dev-load.mjs                        # baseline only
//   node scripts/dev-load.mjs --variants=all
//   node scripts/dev-load.mjs --compare=results      # join JSON from CI legs
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
const astroBin = join(dirname(require.resolve("astro/package.json")), "bin", "astro.mjs");
const devLogPath = join(projectRoot, ".astro", "dev.log");
const pkgPath = join(projectRoot, "package.json");
const lockPath = join(projectRoot, "pnpm-lock.yaml");

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v = "true"] = a.replace(/^--/, "").split("=");
		return [k, v];
	}),
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
const SLOW_THRESHOLD_MS = Number(args.threshold ?? 5_000);
const LABEL = args.label ?? `${process.platform}-${process.arch}`;
const OUT = args.out ? resolve(args.out) : null;

// A variant is a way of setting this project up. `install` swaps npm packages
// (a pnpm reinstall, far cheaper than another CI runner); `vite` is applied
// through a generated config so the committed astro.config.mjs stays stock.
const VARIANTS = [
	{
		id: "baseline",
		description: "package.json and lockfile exactly as committed",
	},
	{
		id: "optimizedeps-include",
		description: "pre-bundle astro/app/manifest instead of discovering it late",
		vite: { ssr: { optimizeDeps: { include: ["astro/app/manifest"] } } },
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
];

const LOG_SIGNATURES = [
	["staleChunk", "does not exist at"],
	["depsChanged", "optimized dependencies changed"],
	["programReload", "program reload"],
	["uncaughtException", "Uncaught exception"],
	["unresolved", "Unable to resolve"],
];

const ROUTES = [
	{ path: "/_emdash/admin", name: "admin" },
	{ path: "/", name: "home" },
	{ path: "/posts", name: "posts" },
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

const astro = (argv) => run(process.execPath, [astroBin, ...argv]);
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

async function processStats(pid) {
	if (!pid || process.platform === "win32") return null;
	const { out, code } = await run("ps", ["-o", "pcpu=,rss=", "-p", String(pid)], { timeout: 10_000 });
	if (code !== 0) return null;
	const [pcpu, rss] = out.trim().split(/\s+/);
	return { cpuPercent: Number(pcpu), rssMb: Math.round(Number(rss) / 1024) };
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
		const verdict = !healthy
			? `BROKEN — ${describeUnhealthy(setup, routes)}; do not compare these timings`
			: worst >= SLOW_THRESHOLD_MS
				? `SLOW — worst median ${seconds(worst)}s, over the ${seconds(SLOW_THRESHOLD_MS)}s threshold`
				: `FAST — worst median ${seconds(worst)}s, under the ${seconds(SLOW_THRESHOLD_MS)}s threshold`;

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

// --- compare mode: join the JSON one CI leg per platform leaves behind -------
if (args.compare) {
	const dir = resolve(args.compare);
	const runs = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
			if (Array.isArray(parsed.variants) && parsed.label) runs.push(parsed);
			else console.log(`Skipping ${file}: not a dev-load result.`);
		} catch (err) {
			// One unreadable artifact should not take the whole report down with it.
			console.log(`Skipping ${file}: ${err.message}`);
		}
	}
	runs.sort((a, b) => a.label.localeCompare(b.label));

	if (runs.length === 0) {
		console.log("No results to compare.");
		process.exit(0);
	}

	// A leg earns its place in the matrix by showing at least one symptom.
	const symptomsOf = (run) => {
		const seen = new Set();
		for (const v of run.variants) {
			if (!v.startup?.ready) seen.add("dev server dead");
			else if (v.startup.coldStartCrashed) seen.add("cold-start crash");
			if (!v.healthy) seen.add("broken setup");
			const bad = v.routes.reduce((n, r) => n + r.badSamples.length, 0);
			if (bad) seen.add("non-200 or empty responses");
			const slow = v.routes.filter(
				(r) => r.medianMs !== null && r.medianMs >= run.settings.thresholdMs,
			);
			if (slow.length) seen.add(`${slow.length} slow route${slow.length === 1 ? "" : "s"}`);
		}
		return [...seen];
	};

	const ids = [...new Set(runs.flatMap((r) => r.variants.map((v) => v.id)))];
	const paths = [...new Set(runs.flatMap((r) => r.variants.flatMap((v) => v.routes.map((x) => x.path))))];
	const md = [
		"## Dev server load times",
		"",
		`Median of ${runs[0].settings.repeats} healthy 200s per route. A response that was not 200,`,
		`came back under ${runs[0].settings.minBytes} bytes, or landed on the sign-in page is excluded`,
		"and counted as ✗. Rows marked broken served empty pages, so their timings mean nothing.",
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
		"### Which legs reproduce anything",
		"",
		"This repo exists to show the bug. A leg that stays clean across every",
		"variant is not evidence of health, it is a leg with nothing to report,",
		"and it can come out of the matrix.",
		"",
		"| platform | symptoms |",
		"| --- | --- |",
		...runs.map((r) => `| ${r.label} | ${symptomsOf(r).join(", ") || "**none**" } |`),
		"",
		(() => {
			const clean = runs.filter((r) => symptomsOf(r).length === 0).map((r) => r.label);
			return clean.length
				? `Reproduced nothing, so candidates to strike: ${clean.join(", ")}.`
				: "Every leg reproduced at least one symptom.";
		})(),
		"",
		"| platform | node | astro | emdash | workerd |",
		"| --- | --- | --- | --- | --- |",
		...runs.map((r) => {
			const v = r.variants[0]?.versions ?? {};
			return `| ${r.label} | ${r.node} | ${v.astro ?? "?"} | ${v.emdash ?? "?"} | ${v.workerd ?? "?"} |`;
		}),
	].join("\n");

	console.log(md);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
	process.exit(0);
}

// --- measure mode -----------------------------------------------------------
const selected =
	args.variants === "all"
		? VARIANTS
		: (args.variants ?? "baseline").split(",").map((id) => {
				const found = VARIANTS.find((v) => v.id === id.trim());
				if (!found) {
					console.error(`Unknown variant "${id}". Known: ${VARIANTS.map((v) => v.id).join(", ")}`);
					process.exit(2);
				}
				return found;
			});

const results = [];
for (const variant of selected) {
	results.push(await measureVariant(variant));
}

const anyReady = results.some((v) => v.startup.ready);
const healthy = results.filter((v) => v.healthy);
const slowest = healthy.length ? Math.max(...healthy.map((v) => v.worstMedianMs ?? 0)) : null;
const verdict = !anyReady
	? "DEAD — no variant produced a running dev server"
	: healthy.length === 0
		? "BROKEN — no variant produced a healthy setup, so nothing here is comparable"
		: slowest >= SLOW_THRESHOLD_MS
			? `AFFECTED — slowest healthy median ${seconds(slowest)}s, over the ${seconds(SLOW_THRESHOLD_MS)}s threshold`
			: `NOT AFFECTED — slowest healthy median ${seconds(slowest)}s, under the ${seconds(SLOW_THRESHOLD_MS)}s threshold`;

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
