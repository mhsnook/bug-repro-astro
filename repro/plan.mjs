#!/usr/bin/env node
// The CI matrix lives here, not in the workflow. Adding a machine, a node
// version or a whole reproduction is a change to this file; the YAML holds only
// the steps that every leg shares and does not need editing for any of it.
//
//   node repro/plan.mjs --matrix        # legs as JSON, for the workflow matrix
//   node repro/plan.mjs --list          # the same thing, readable
//   node repro/plan.mjs --run=<leg id>  # run one leg, from the repo root
//   node repro/plan.mjs --report        # join the artifacts and comment
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNNERS = { linux: "ubuntu-latest", macos: "macos-latest", windows: "windows-latest" };
const NODE_VERSIONS = ["22", "26"];

// Results all land in <dir>/results so one upload rule covers every leg. The
// report tells a dev-load result from a watcher one by its shape, so a new kind
// of measurement only has to write JSON somewhere in there.
const RESULTS = "results";

const legs = [
	// What the slowdown costs, on every runner and both node versions.
	...Object.entries(RUNNERS).flatMap(([platform, os]) =>
		NODE_VERSIONS.map((node) => ({
			id: `${platform}-node${node}`,
			name: `${os} node ${node}`,
			os,
			node,
			dir: "repro/emdash-slowdown",
			script: "repro-scripts/dev-load.mjs",
			// Blank values are dropped below, so the defaults stay the script's.
			passEnv: { VARIANTS: "--variants", REPEATS: "--repeats" },
		})),
	),
	// What triggers it. No framework, so one node version is enough; the point
	// is the platform's file watcher, which is why it runs on all three.
	//
	// Twice per platform, because chokidar picks its backend by platform: the
	// fsevents native module on macOS, fs.watch everywhere else. The poll legs
	// take the macOS-only path away, so the two backends can be compared
	// against the same writes instead of against each other's platforms.
	...Object.entries(RUNNERS).flatMap(([platform, os]) =>
		[
			{ suffix: "", watcher: "default", how: "chokidar's own choice" },
			{ suffix: "-poll", watcher: "poll", how: "useFsEvents false" },
		].map(({ suffix, watcher, how }) => ({
			id: `watcher-${platform}${suffix}`,
			// The report lists these under a platform column, where "watcher-linux"
			// would read as a platform name.
			label: `${platform}/${watcher}`,
			name: `watcher on ${os} (${how})`,
			os,
			node: "22",
			dir: "repro/minimal",
			// One probe for every reproduction, run from the repository root so it
			// is not copied per exhibit and cannot drift between them.
			runFrom: ".",
			script: "repro/watcher-probe.mjs",
			args: ["--dir=repro/minimal", `--watcher=${watcher}`],
		})),
	),
	// The same probe against Cloudflare's own scaffold, which writes and fires
	// hooks exactly like the others and stays fast: TanStack Start's hotUpdate
	// hooks take the context and find nothing matched. The control that shows the
	// writes are not expensive on their own.
	{
		id: "watcher-tanstack",
		label: "tanstack/linux",
		name: "watcher on ubuntu-latest (stock TanStack Start)",
		os: "ubuntu-latest",
		node: "22",
		dir: "repro/tanstack-start",
		runFrom: ".",
		script: "repro/watcher-probe.mjs",
		args: ["--dir=repro/tanstack-start"],
	},
];

// A bad matrix fails the workflow with a parse error somewhere unhelpful, so it
// is checked here where the message can say what is wrong.
const ids = new Set();
for (const leg of legs) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(leg.id)) throw new Error(`Bad leg id: ${leg.id}`);
	if (ids.has(leg.id)) throw new Error(`Duplicate leg id: ${leg.id}`);
	ids.add(leg.id);
	for (const key of ["name", "os", "node", "dir", "script"]) {
		if (!leg[key]) throw new Error(`Leg ${leg.id} is missing ${key}`);
	}
}

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v = "true"] = a.replace(/^--/, "").split("=");
		return [k, v];
	}),
);

// Only the fields the workflow interpolates. Anything else stays in here.
const matrix = legs.map(({ id, name, os, node, dir }) => ({ id, name, os, node, dir }));

if (args.matrix) {
	// The whole strategy.matrix object, which is the shape fromJSON expects.
	console.log(`legs=${JSON.stringify({ include: matrix })}`);
	process.exit(0);
}

if (args.list) {
	for (const leg of legs) {
		const from = leg.runFrom ?? leg.dir;
		const where = from === "." ? leg.script : `${from}/${leg.script}`;
		console.log(`${leg.id.padEnd(20)} ${leg.os.padEnd(15)} node ${leg.node}  ${where}  [installs ${leg.dir}]`);
	}
	process.exit(0);
}

if (args.report) {
	const { status } = spawnSync(
		process.execPath,
		[join(repoRoot, "repro/emdash-slowdown/repro-scripts/dev-load.mjs"), `--compare=${args.report === "true" ? RESULTS : args.report}`, "--comment"],
		{ cwd: repoRoot, stdio: "inherit" },
	);
	process.exit(status ?? 1);
}

if (args.run) {
	const leg = legs.find((l) => l.id === args.run);
	if (!leg) {
		console.error(`Unknown leg "${args.run}". Known: ${legs.map((l) => l.id).join(", ")}`);
		process.exit(2);
	}
	const cwd = join(repoRoot, leg.runFrom ?? leg.dir);
	// Results live with the reproduction whatever directory the script ran from,
	// so one upload rule still covers every leg.
	const out = join(leg.dir, RESULTS, `${leg.id}.json`);
	mkdirSync(join(repoRoot, leg.dir, RESULTS), { recursive: true });
	const argv = [
		leg.script,
		`--out=${join(repoRoot, out)}`,
		`--label=${leg.label ?? leg.id}`,
		...(leg.args ?? []),
	];
	for (const [envName, flag] of Object.entries(leg.passEnv ?? {})) {
		const value = process.env[envName];
		if (value) argv.push(`${flag}=${value}`);
	}
	const { status } = spawnSync(process.execPath, argv, { cwd, stdio: "inherit" });
	process.exit(status ?? 1);
}

console.error("Nothing to do. Try --matrix, --list, --run=<id> or --report.");
process.exit(2);
