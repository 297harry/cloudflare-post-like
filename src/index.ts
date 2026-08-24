function corsHeaders(env: Env): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}

function json(env: Env, body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...corsHeaders(env) },
	});
}

async function getLikes(env: Env, postId: string): Promise<number> {
	const stored = await env.LIKE_DB.get(postId);
	return stored ? Number(stored) || 0 : 0;
}

// Retries on a KV write conflict caused by concurrent increment/decrement requests.
async function adjustLikes(env: Env, postId: string, delta: 1 | -1): Promise<number> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await getLikes(env, postId);
		const next = Math.max(0, current + delta);
		await env.LIKE_DB.put(postId, String(next));
		if ((await getLikes(env, postId)) === next) return next;
	}
	return getLikes(env, postId);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders(env) });
		}

		const url = new URL(request.url);
		const match = url.pathname.match(/^\/posts\/([^/]+)\/(likes|like|unlike)$/);
		if (!match) return json(env, { error: "Not found" }, 404);

		const [, rawPostId, action] = match;
		const postId = decodeURIComponent(rawPostId);

		if (action === "likes") {
			if (request.method !== "GET") return json(env, { error: "Method not allowed" }, 405);
			return json(env, { id: postId, likes: await getLikes(env, postId) });
		}

		if (request.method !== "POST") return json(env, { error: "Method not allowed" }, 405);

		const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
		const { success } = await env.LIKE_RATE_LIMITER.limit({ key: ip });
		if (!success) return json(env, { error: "Too many requests" }, 429);

		const delta = action === "like" ? 1 : -1;
		return json(env, { id: postId, likes: await adjustLikes(env, postId, delta) });
	},
} satisfies ExportedHandler<Env>;
