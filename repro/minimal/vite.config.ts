import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

// Astro's middleware plugin does exactly this shape: a hotUpdate handler that
// takes no arguments and therefore cannot know which file changed.
function countsHotUpdates(): Plugin {
	let n = 0;
	return {
		name: "counts-hot-updates",
		hotUpdate: {
			handler() {
				n++;
				console.log(`[counts-hot-updates] hotUpdate #${n} in env "${this.environment.name}"`);
			},
		},
	};
}

// Left to itself chokidar picks its backend by platform: the fsevents native
// module on macOS, fs.watch everywhere else. REPRO_WATCHER=poll takes the
// macOS-only path away so both backends can be run against the same writes.
// Vite's own docs for useFsEvents: "When set to false on OS X, usePolling: true
// becomes the default."
const watch = process.env.REPRO_WATCHER === "poll" ? { useFsEvents: false } : undefined;

export default defineConfig({
	plugins: [cloudflare(), countsHotUpdates()],
	server: { watch },
});
