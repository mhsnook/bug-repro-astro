#!/usr/bin/env node
// Measures how long the Astro dev server (running on workerd via @astrojs/cloudflare)
// takes to serve a handful of routes, and reports whether it survived startup at all.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const astroBin = join(dirname(require.resolve("astro/package.json")), "bin", "astro.mjs");
const devLogPath = join(projectRoot, ".astro", "dev.log");

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v = "true"] = a.replace(/^--/, "").split("=");
		return [k, v];
	}),
);

const PORT = Number(args.port ?? 4321);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPEATS = Number(args.repeats ?? 3);
const REQUEST_TIMEOUT_MS = Number(args["request-timeout"] ?? 60_000);
const STARTUP_TIMEOUT_MS = Number(args["startup-timeout"] ?? 90_000);
const START_ATTEMPTS = Number(args["start-attempts"] ?? 2);
const SLOW_THRESHOLD_MS = Number(args.threshold ?? 5_000);
const MAX_BAD = Number(args["max-bad"] ?? 3);
const LABEL = args.label ?? `${process.platform}-${process.arch}`;
const OUT = args.out ? resolve(args.out) : null;

const ROUTES = [
	{ path: "/_emdash/admin", name: "admin" },
	{ path: "/", name: "home" },
	{ path: "/posts", name: "posts" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (ms) => (ms / 1000).toFixed(2);

function astro(argv) {
	return new Promise((done) => {
		const child = spawn(process.execPath, [astroBin, ...argv], {
			cwd: projectRoot,
			env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("close", (code) => done({ code, out }));
	});
}

function tailDevLog(lines = 40) {
	if (!existsSync(devLogPath)) return "(no .astro/dev.log)";
	return readFileSync(devLogPath, "utf8")
		.replace(/\[[0-9;]*m/g, "")
		.trim()
		.split("\n")
		.slice(-lines)
		.join("\n");
}

async function probe(timeoutMs) {
	try {
		const res = await fetch(`${ORIGIN}/_emdash/admin`, {
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		await res.arrayBuffer().catch(() => {});
		return true;
	} catch {
		return false;
	}
}

async function startDevServer() {
	const attempts = [];
	for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
		// `astro dev` daemonises, so the spawn resolving tells us nothing about readiness.
		const launch = await astro(["dev", "--background", `--port=${PORT}`, "--host=127.0.0.1"]);
		const startedAt = Date.now();
		let ready = false;
		while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
			if (await probe(5_000)) {
				ready = true;
				break;
			}
			const status = await astro(["dev", "status"]);
			if (/No dev server is running/.test(status.out)) break;
			await sleep(1_000);
		}
		const record = {
			attempt,
			ready,
			seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
			launchOutput: launch.out.trim(),
			devLog: ready ? null : tailDevLog(),
		};
		attempts.push(record);
		console.log(
			ready
				? `dev server ready on attempt ${attempt} after ${record.seconds}s`
				: `dev server FAILED to start on attempt ${attempt}`,
		);
		if (!ready) console.log(record.devLog);
		if (ready) return { ready: true, attempts };
		await astro(["dev", "stop"]);
		await sleep(2_000);
	}
	return { ready: false, attempts };
}

async function time(url) {
	const started = performance.now();
	try {
		const res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await res.arrayBuffer();
		return {
			ms: Math.round(performance.now() - started),
			status: res.status,
			bytes: body.byteLength,
			finalUrl: res.url,
		};
	} catch (err) {
		return {
			ms: Math.round(performance.now() - started),
			status: null,
			error: err?.name === "TimeoutError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String(err),
		};
	}
}

const startup = await startDevServer();
const routes = [];

if (startup.ready) {
	for (const route of ROUTES) {
		// Keep going until REPEATS responses actually came back 200. This dev server
		// serves intermittent 404s, and a fast 404 would drag the median down.
		const ok = [];
		const bad = [];
		while (ok.length < REPEATS && bad.length < MAX_BAD) {
			const sample = await time(`${ORIGIN}${route.path}`);
			(sample.status === 200 ? ok : bad).push(sample);
			console.log(
				`${route.path} ${sample.status === 200 ? `#${ok.length}` : "!!"}: ${
					sample.status ?? "ERR"
				} in ${seconds(sample.ms)}s` +
					(sample.status === 200 ? "" : " — not counted in timings") +
					(sample.error ? ` (${sample.error})` : ""),
			);
		}
		const ms = ok.map((s) => s.ms);
		routes.push({
			...route,
			wanted: REPEATS,
			ok: ok.length,
			complete: ok.length === REPEATS,
			attempts: ok.length + bad.length,
			okSamples: ok,
			badSamples: bad.map((s) => ({ status: s.status, ms: s.ms, error: s.error })),
			finalUrl: ok.find((s) => s.finalUrl)?.finalUrl ?? null,
			firstMs: ms[0] ?? null,
			medianMs: ms.length ? [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] : null,
			maxMs: ms.length ? Math.max(...ms) : null,
		});
	}
	await astro(["dev", "stop"]);
}

// e.g. "404×2, timeout×1" — what came back that was not a 200.
function badSummary(route) {
	if (route.badSamples.length === 0) return "—";
	const counts = new Map();
	for (const s of route.badSamples) {
		const key = s.status ?? (s.error?.startsWith("timeout") ? "timeout" : "error");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].map(([k, n]) => `${k}×${n}`).join(", ");
}

const timed = routes.filter((r) => r.medianMs !== null);
const worst = timed.length ? Math.max(...timed.map((r) => r.medianMs)) : null;
const starved = routes.filter((r) => !r.complete);
const badTotal = routes.reduce((n, r) => n + r.badSamples.length, 0);

const timingVerdict =
	worst === null
		? "no timings - no route returned a single 200"
		: worst >= SLOW_THRESHOLD_MS
			? `SLOW - worst median ${seconds(worst)}s, over the ${seconds(SLOW_THRESHOLD_MS)}s threshold`
			: `FAST - worst median ${seconds(worst)}s, under the ${seconds(SLOW_THRESHOLD_MS)}s threshold`;

const verdict = !startup.ready
	? "DEAD - dev server never became ready"
	: starved.length
		? `FLAKY (${starved.map((r) => `${r.path} gave up at ${r.ok}/${r.wanted} 200s`).join("; ")}) + ${timingVerdict}`
		: timingVerdict;

const workerdVersion = (() => {
	const platformPkg = {
		linux: "@cloudflare/workerd-linux-64",
		darwin: "@cloudflare/workerd-darwin-64",
		win32: "@cloudflare/workerd-windows-64",
	}[process.platform];
	for (const name of [platformPkg, "workerd"].filter(Boolean)) {
		try {
			return require(`${name}/package.json`).version;
		} catch {}
	}
	// workerd is a transitive dependency, so it may only exist inside pnpm's store.
	try {
		const entry = readdirSync(join(projectRoot, "node_modules", ".pnpm")).find((d) =>
			d.startsWith("workerd@"),
		);
		return entry ? entry.slice("workerd@".length).split("_")[0] : null;
	} catch {
		return null;
	}
})();

const result = {
	label: LABEL,
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	workerd: workerdVersion,
	repeats: REPEATS,
	thresholdMs: SLOW_THRESHOLD_MS,
	startup: {
		ready: startup.ready,
		attemptsUsed: startup.attempts.length,
		coldStartCrashed: !startup.attempts[0].ready,
		attempts: startup.attempts,
	},
	routes,
	badTotal,
	verdict,
};

const fmt = (v) => (v === null ? "—" : `${seconds(v)}s`);

const md = [
	`### ${LABEL} - ${verdict}`,
	"",
	`Node ${process.version} · workerd ${workerdVersion ?? "unknown"} · cold start ${
		result.startup.coldStartCrashed ? "**crashed**, retried" : "OK"
	} · ${REPEATS} successful 200s wanted per route, at most ${MAX_BAD} non-200s tolerated`,
	"",
	"| route | 200s | first | median | max | non-200 |",
	"| --- | --- | --- | --- | --- | --- |",
	...routes.map(
		(r) =>
			`| \`${r.path}\` | ${r.ok}/${r.wanted}${r.complete ? "" : " ⚠"} | ${fmt(r.firstMs)} | **${fmt(
				r.medianMs,
			)}** | ${fmt(r.maxMs)} | ${badSummary(r)} |`,
	),
	"",
	badTotal === 0
		? "Every request came back 200."
		: `**${badTotal} non-200 response${badTotal === 1 ? "" : "s"}** across all routes, excluded from the timings above.`,
].join("\n");

console.log(`\n${md}\n`);

if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
}

// Only a dev server that never came up is a hard failure; the timings are the report.
process.exit(startup.ready ? 0 : 1);
