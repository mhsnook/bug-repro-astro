export default {
	async fetch(): Promise<Response> {
		return new Response("hello", { headers: { "content-type": "text/plain" } });
	},
};
