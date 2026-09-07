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

export default defineConfig({
	plugins: [cloudflare(), countsHotUpdates()],
});
