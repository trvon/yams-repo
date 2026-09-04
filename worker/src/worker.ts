// Cloudflare Worker to serve APT, YUM, and Arch repositories plus latest.json from an R2 bucket.
// Features:
//  - Caches immutable objects aggressively
//  - Adds appropriate Content-Type headers
//  - Supports conditional GET (ETag / If-None-Match)
//  - Normalizes directory listings for repo metadata (optional index)
//  - Simple logging with request id
//  - Basic security headers
//  - Optional GPG public key route (/gpg.key)
//
// Environment bindings (wrangler.toml):
//  REPO_BUCKET: R2 bucket binding containing objects
//  APT_PREFIX: path prefix for debian repo root (e.g., "aptrepo")
//  YUM_PREFIX: path prefix for rpm repo root (e.g., "yumrepo")
//  ARCH_PREFIX: path prefix for arch repo root (e.g., "archrepo")
//  LATEST_MANIFEST: name of manifest file (e.g., "latest.json")
//
// Expected bucket layout (uploaded from release workflow artifacts):
//  aptrepo/
//    dists/stable/Release
//    dists/stable/InRelease (optional if signed)
//    dists/stable/main/binary-amd64/Packages
//    pool/main/y/yams/*.deb
//  yumrepo/
//    repodata/repomd.xml
//    *.rpm
//  archrepo/
//    yams.db
//    yams.db.sig  (optional GPG signature)
//    yams.files
//    yams.files.sig
//    *.pkg.tar.zst
//  latest.json
//  gpg.key   (optional public key for repo verification)
//
// Deployment: wrangler publish

export interface Env {
	REPO_BUCKET: R2Bucket;
	RATE_LIMITER?: RateLimit; // Optional - may not be available in all deployments
	REPOSITORY_CACHE?: Cache; // Test seam; production uses caches.default when available.
	APT_PREFIX: string;
	YUM_PREFIX: string;
	ARCH_PREFIX: string;
	LATEST_MANIFEST: string;
}

type RepositoryChannel = "stable" | "experimental";

interface RepositoryRoute {
	channel: RepositoryChannel;
	key: string;
}

const MUTABLE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const DEFAULT_CACHE_CONTROL = "public, max-age=300";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"X-XSS-Protection": "1; mode=block",
	"Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

const TEXT_TYPES: Record<string, string> = {
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	Release: "text/plain; charset=utf-8",
	InRelease: "text/plain; charset=utf-8",
	Packages: "text/plain; charset=utf-8",
	".repo": "text/plain; charset=utf-8",
};

const BINARY_TYPES: Record<string, string> = {
	".deb": "application/vnd.debian.binary-package",
	".rpm": "application/x-rpm",
	".gz": "application/gzip",
	".xz": "application/x-xz",
	".bz2": "application/x-bzip2",
	".zst": "application/zstd",
	".db": "application/gzip",
	".files": "application/gzip",
	".key": "application/pgp-keys",
};

function guessContentType(key: string): string | undefined {
	for (const [ext, ct] of Object.entries(TEXT_TYPES)) {
		if (key.endsWith(ext)) return ct;
	}
	for (const [ext, ct] of Object.entries(BINARY_TYPES)) {
		if (key.endsWith(ext)) return ct;
	}
	if (key.endsWith("/")) return "text/plain; charset=utf-8";
	return undefined;
}

function immutable(path: string): boolean {
	// Repo metadata changes between releases; packages are immutable once published.
	return /(\.deb$|\.rpm$|\.pkg\.tar\.zst$)/.test(path);
}

function addSecurityHeaders(h: Headers) {
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
}

function notFound(msg: string, cfId?: string) {
	return new Response(JSON.stringify({ error: msg, cfRay: cfId }), {
		status: 404,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

async function serveObjectOrDirectory(
	env: Env,
	key: string,
	displayPath: string,
	req: Request,
	ctx: ExecutionContext,
	channel?: RepositoryChannel,
): Promise<Response> {
	// Check if path ends with / (directory request)
	if (displayPath.endsWith("/")) {
		const acceptJson =
			req.headers.get("Accept")?.includes("application/json") || false;
		return listDirectory(env, key, displayPath, acceptJson);
	}

	const isImmutable = immutable(key);
	const cache =
		isImmutable && channel && req.method === "GET"
			? repositoryCache(env)
			: undefined;
	const cacheRequest =
		cache && channel ? immutableCacheRequest(req, channel, key) : undefined;
	if (cache && cacheRequest) {
		const cached = await cache.match(cacheRequest);
		if (cached) {
			const cachedEtag = cached.headers.get("ETag");
			if (cachedEtag && req.headers.get("If-None-Match") === cachedEtag) {
				cached.body?.cancel();
				return new Response(null, { status: 304, headers: cached.headers });
			}
			return cached;
		}
	}

	// Try to serve as file
	const obj = await env.REPO_BUCKET.get(key);

	// If object not found, check if this should be a directory redirect
	if (!obj) {
		// Try listing with this prefix to see if it's a directory
		const listing = await env.REPO_BUCKET.list({
			prefix: key.endsWith("/") ? key : key + "/",
			delimiter: "/",
			limit: 1,
		});

		if (listing.objects.length > 0 || listing.delimitedPrefixes.length > 0) {
			// This is a directory, redirect to add trailing slash
			return new Response(null, {
				status: 301,
				headers: { Location: displayPath + "/" },
			});
		}

		return notFound("object not found", req.headers.get("CF-Ray") || undefined);
	}

	const headers = new Headers();
	addSecurityHeaders(headers);

	const ct = guessContentType(key) || "application/octet-stream";
	headers.set("Content-Type", ct);

	// Only versioned package payloads enter the Cache API. Mutable repository
	// metadata must revalidate against its channel-specific R2 key.
	headers.set(
		"Cache-Control",
		isImmutable
			? IMMUTABLE_CACHE_CONTROL
			: channel
				? MUTABLE_CACHE_CONTROL
				: DEFAULT_CACHE_CONTROL,
	);

	// ETag / conditional — use httpEtag from R2 (always set); never read body for ETag
	const etag = obj.httpEtag || `W/"${obj.size}"`;
	headers.set("ETag", etag);
	if (obj.size !== undefined) {
		headers.set("Content-Length", String(obj.size));
	}
	const ifNone = req.headers.get("If-None-Match");
	if (ifNone && ifNone === etag) {
		// Must cancel the body to avoid resource leak
		obj.body?.cancel?.();
		return new Response(null, { status: 304, headers });
	}

	const response = new Response(obj.body, { status: 200, headers });
	if (cache && cacheRequest) {
		ctx.waitUntil(
			cache.put(cacheRequest, response.clone()).catch((error: unknown) => {
				console.warn("Immutable repository cache put failed:", error);
			}),
		);
	}
	return response;
}

function normalizePath(p: string): string {
	if (p.startsWith("/")) p = p.slice(1);
	return p;
}

function rawPathname(requestUrl: string): string {
	const authority = requestUrl.indexOf("://");
	if (authority < 0) return new URL(requestUrl, "https://repository.invalid").pathname;
	const pathStart = requestUrl.indexOf("/", authority + 3);
	if (pathStart < 0) return "/";
	const queryStart = requestUrl.indexOf("?", pathStart);
	const fragmentStart = requestUrl.indexOf("#", pathStart);
	const pathEnd = Math.min(
		queryStart < 0 ? requestUrl.length : queryStart,
		fragmentStart < 0 ? requestUrl.length : fragmentStart,
	);
	return requestUrl.slice(pathStart, pathEnd);
}

function hasPathBoundary(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

function isRepositoryCandidate(path: string): boolean {
	return [
		"/aptrepo",
		"/yumrepo",
		"/archrepo",
		"/latest.json",
		"/gpg.key",
		"/experimental",
	].some((prefix) => path.startsWith(prefix));
}

function isUnsafeRepositoryPath(path: string): boolean {
	return (
		path.includes("%") ||
		path.includes("\\") ||
		path.split("/").some((part) => part === "." || part === "..")
	);
}

function repositoryKey(prefix: string, routePrefix: string, path: string): string {
	return normalizePath(`${prefix}${path.slice(routePrefix.length)}`);
}

function resolveRepositoryRoute(path: string, env: Env): RepositoryRoute | null {
	if (isRepositoryCandidate(path) && isUnsafeRepositoryPath(path)) return null;

	if (path === "/experimental/latest.json") {
		return { channel: "experimental", key: "experimental/latest.json" };
	}

	const experimentalRoutes = [
		["/experimental/aptrepo", env.APT_PREFIX],
		["/experimental/yumrepo", env.YUM_PREFIX],
		["/experimental/archrepo", env.ARCH_PREFIX],
	] as const;
	for (const [routePrefix, objectPrefix] of experimentalRoutes) {
		if (hasPathBoundary(path, routePrefix)) {
			return {
				channel: "experimental",
				key: `experimental/${repositoryKey(objectPrefix, routePrefix, path)}`,
			};
		}
	}

	if (path === "/latest.json") {
		return { channel: "stable", key: env.LATEST_MANIFEST };
	}
	if (path === "/gpg.key") {
		return { channel: "stable", key: "gpg.key" };
	}

	const stableRoutes = [
		["/aptrepo", env.APT_PREFIX],
		["/yumrepo", env.YUM_PREFIX],
		["/archrepo", env.ARCH_PREFIX],
	] as const;
	for (const [routePrefix, objectPrefix] of stableRoutes) {
		if (hasPathBoundary(path, routePrefix)) {
			return {
				channel: "stable",
				key: repositoryKey(objectPrefix, routePrefix, path),
			};
		}
	}
	return null;
}

function repositoryCache(env: Env): Cache | undefined {
	if (env.REPOSITORY_CACHE) return env.REPOSITORY_CACHE;
	return typeof caches === "undefined" ? undefined : caches.default;
}

function immutableCacheRequest(
	req: Request,
	channel: RepositoryChannel,
	key: string,
): Request {
	const url = new URL(req.url);
	const encodedKey = key.split("/").map(encodeURIComponent).join("/");
	url.pathname = `/__yams_repository_cache/${channel}/${encodedKey}`;
	url.search = "";
	return new Request(url.toString(), { method: "GET" });
}

function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

async function listDirectory(
	env: Env,
	prefix: string,
	displayPath: string,
	acceptJson: boolean,
): Promise<Response> {
	// Ensure prefix doesn't start with /
	const normalizedPrefix = normalizePath(prefix);

	// List objects with delimiter to get "directory-like" structure
	const listing = await env.REPO_BUCKET.list({
		prefix: normalizedPrefix,
		delimiter: "/",
	});

	if (listing.objects.length === 0 && listing.delimitedPrefixes.length === 0) {
		return notFound("directory not found");
	}

	// Extract just the filenames/dirnames from the full keys
	const files = listing.objects.map((obj) => ({
		name: obj.key.substring(normalizedPrefix.length),
		size: obj.size,
		modified: obj.uploaded,
		isDir: false,
	}));

	const dirs = listing.delimitedPrefixes.map((prefix) => ({
		name: prefix.substring(normalizedPrefix.length),
		size: 0,
		modified: new Date(),
		isDir: true,
	}));

	// Sort: directories first, then files (alphabetically)
	const allEntries = [
		...dirs.sort((a, b) => a.name.localeCompare(b.name)),
		...files.sort((a, b) => a.name.localeCompare(b.name)),
	];

	const headers = new Headers();
	addSecurityHeaders(headers);

	// Content negotiation
	if (acceptJson) {
		headers.set("Content-Type", "application/json; charset=utf-8");
		return new Response(
			JSON.stringify(
				{
					path: displayPath,
					files: allEntries.map((e) => e.name),
				},
				null,
				2,
			),
			{ headers },
		);
	}

	// Generate HTML listing
	const breadcrumbs = generateBreadcrumbs(displayPath);
	const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Index of ${escapeHtml(displayPath)}</title>
  <style>
    body { font-family: monospace; margin: 2em; background: #f5f5f5; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 0.5em; }
    .breadcrumb { margin: 1em 0; font-size: 0.9em; }
    .breadcrumb a { color: #0066cc; text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; background: white; }
    th { text-align: left; padding: 0.5em; background: #e0e0e0; border-bottom: 2px solid #333; }
    td { padding: 0.5em; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f9f9f9; }
    .name a { color: #0066cc; text-decoration: none; }
    .name a:hover { text-decoration: underline; }
    .dir { font-weight: bold; }
    .size { text-align: right; }
    .modified { color: #666; }
  </style>
</head>
<body>
  <h1>Index of ${escapeHtml(displayPath)}</h1>
  ${breadcrumbs}
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th class="size">Size</th>
        <th class="modified">Last Modified</th>
      </tr>
    </thead>
    <tbody>
      ${
				displayPath !== "/"
					? `
      <tr>
        <td class="name dir"><a href="../">../</a></td>
        <td class="size">-</td>
        <td class="modified">Parent Directory</td>
      </tr>`
					: ""
			}
      ${allEntries
				.map(
					(entry) => `
      <tr>
        <td class="name ${entry.isDir ? "dir" : ""}">
          <a href="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</a>
        </td>
        <td class="size">${entry.isDir ? "-" : formatBytes(entry.size)}</td>
        <td class="modified">${entry.isDir ? "-" : entry.modified.toISOString().replace("T", " ").substring(0, 19)}</td>
      </tr>`,
				)
				.join("")}
    </tbody>
  </table>
</body>
</html>`;

	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Cache-Control", MUTABLE_CACHE_CONTROL);
	return new Response(html, { headers });
}

function generateBreadcrumbs(path: string): string {
	if (path === "/") return "";

	const parts = path.split("/").filter((p) => p.length > 0);
	const breadcrumbs = ['<div class="breadcrumb"><a href="/">Home</a>'];

	let currentPath = "";
	for (const part of parts) {
		currentPath += "/" + part;
		breadcrumbs.push(` / <a href="${currentPath}/">${escapeHtml(part)}</a>`);
	}

	breadcrumbs.push("</div>");
	return breadcrumbs.join("");
}

function shouldRateLimit(path: string): boolean {
	// Apply rate limiting to package downloads and API endpoints
	// Skip rate limiting for directory listings and metadata files
	return (
		path.endsWith(".deb") ||
		path.endsWith(".rpm") ||
		path.endsWith(".pkg.tar.zst") ||
		path.endsWith(".tar.gz") ||
		path.startsWith("/api/") ||
		path === "/latest.json" ||
		path === "/experimental/latest.json"
	);
}

function rateLimitExceeded(): Response {
	return new Response(
		JSON.stringify({
			error: "Rate limit exceeded",
			message: "Too many requests. Please try again later.",
			retry_after: 60,
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Retry-After": "60",
			},
		},
	);
}

const CORS_ALLOW_ORIGIN = "https://repo.yamsmemory.ai";

function addCorsHeaders(headers: Headers): void {
	headers.set("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
	headers.set("Vary", "Origin");
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "Content-Type");
}

function parsePluginManifest(
	manifestText: string,
	manifestKey: string,
):
	| { ok: true; manifest: Record<string, unknown> }
	| { ok: false; response: Response } {
	try {
		const parsed = JSON.parse(manifestText) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { ok: true, manifest: parsed as Record<string, unknown> };
		}
		return {
			ok: false,
			response: jsonResponse(
				{ error: `Plugin manifest '${manifestKey}' is not a JSON object` },
				502,
				60,
			),
		};
	} catch (error) {
		return {
			ok: false,
			response: jsonResponse(
				{
					error: `Plugin manifest '${manifestKey}' is invalid JSON`,
					detail: String(error),
				},
				502,
				60,
			),
		};
	}
}

function jsonResponse(
	data: unknown,
	status = 200,
	cacheMaxAge = 300,
): Response {
	const headers = new Headers();
	addSecurityHeaders(headers);
	addCorsHeaders(headers);
	headers.set("Content-Type", "application/json; charset=utf-8");
	headers.set("Cache-Control", `public, max-age=${cacheMaxAge}`);
	return new Response(JSON.stringify(data, null, 2), { status, headers });
}

async function handlePluginApiList(env: Env): Promise<Response> {
	// List all plugins by finding manifest.json files in plugins/*
	const listing = await env.REPO_BUCKET.list({
		prefix: "plugins/",
		delimiter: "/",
	});

	const plugins: unknown[] = [];

	for (const prefix of listing.delimitedPrefixes) {
		const pluginName = prefix.replace("plugins/", "").replace("/", "");
		const manifestKey = `plugins/${pluginName}/manifest.json`;
		const manifestObj = await env.REPO_BUCKET.get(manifestKey);

		if (manifestObj) {
			const manifestText = await manifestObj.text();
			const parsed = parsePluginManifest(manifestText, manifestKey);
			if (!parsed.ok) return parsed.response;
			const { manifest } = parsed;
			plugins.push({
				name: manifest.name,
				version: manifest.version,
				description: manifest.description,
				downloads:
					typeof manifest.downloads === "number" ? manifest.downloads : 0,
			});
		}
	}

	return jsonResponse({ plugins }, 200, 60);
}

async function handlePluginApiGet(
	env: Env,
	pluginName: string,
): Promise<Response> {
	const manifestKey = `plugins/${pluginName}/manifest.json`;
	const manifestObj = await env.REPO_BUCKET.get(manifestKey);

	if (!manifestObj) {
		return jsonResponse({ error: `Plugin '${pluginName}' not found` }, 404);
	}

	const manifestText = await manifestObj.text();
	const parsed = parsePluginManifest(manifestText, manifestKey);
	if (!parsed.ok) return parsed.response;
	return jsonResponse(parsed.manifest, 200, 3600); // Cache 1 hour
}

async function handlePluginApiVersions(
	env: Env,
	pluginName: string,
): Promise<Response> {
	// List all version directories for this plugin
	const listing = await env.REPO_BUCKET.list({
		prefix: `plugins/${pluginName}/`,
		delimiter: "/",
	});

	const versions: string[] = [];

	for (const prefix of listing.delimitedPrefixes) {
		const versionMatch = prefix.match(/plugins\/[^/]+\/([^/]+)\//);
		if (versionMatch && versionMatch[1] !== "manifest.json") {
			versions.push(versionMatch[1]);
		}
	}

	if (versions.length === 0) {
		return jsonResponse(
			{ error: `No versions found for plugin '${pluginName}'` },
			404,
		);
	}

	// Sort versions descending (semver-like)
	versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

	return jsonResponse({ versions }, 200, 300);
}

async function handlePluginApiVersion(
	env: Env,
	pluginName: string,
	version: string,
): Promise<Response> {
	const manifestKey = `plugins/${pluginName}/${version}/manifest.json`;
	const manifestObj = await env.REPO_BUCKET.get(manifestKey);

	if (!manifestObj) {
		return jsonResponse(
			{ error: `Version '${version}' not found for plugin '${pluginName}'` },
			404,
		);
	}

	const manifestText = await manifestObj.text();
	const parsed = parsePluginManifest(manifestText, manifestKey);
	if (!parsed.ok) return parsed.response;
	return jsonResponse(parsed.manifest, 200, 86400); // Cache 24 hours (immutable version)
}

async function handlePluginApiLatest(
	env: Env,
	pluginName: string,
): Promise<Response> {
	// Get versions and return latest
	const listing = await env.REPO_BUCKET.list({
		prefix: `plugins/${pluginName}/`,
		delimiter: "/",
	});

	const versions: string[] = [];
	for (const prefix of listing.delimitedPrefixes) {
		const versionMatch = prefix.match(/plugins\/[^/]+\/([^/]+)\//);
		if (versionMatch && versionMatch[1] !== "manifest.json") {
			versions.push(versionMatch[1]);
		}
	}

	if (versions.length === 0) {
		return jsonResponse({ error: `Plugin '${pluginName}' not found` }, 404);
	}

	versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	const latestVersion = versions[0];

	return handlePluginApiVersion(env, pluginName, latestVersion);
}

async function handlePluginApiInstall(req: Request): Promise<Response> {
	try {
		const body = (await req.json()) as {
			version?: string;
			platform?: string;
			yams_version?: string;
		};

		if (!body.version || !body.platform || !body.yams_version) {
			return jsonResponse(
				{
					error:
						"Invalid request body. Required: version, platform, yams_version",
				},
				400,
			);
		}

		// Track installation metrics (in production, this would update a counter in R2 or KV)
		return jsonResponse({ success: true }, 200, 0);
	} catch {
		return jsonResponse({ error: "Invalid JSON body" }, 400);
	}
}

async function handlePluginApi(
	env: Env,
	req: Request,
	pathParts: string[],
): Promise<Response> {
	// Handle OPTIONS preflight
	if (req.method === "OPTIONS") {
		const headers = new Headers();
		addCorsHeaders(headers);
		headers.set("Access-Control-Max-Age", "86400");
		return new Response(null, { status: 204, headers });
	}

	// /api/v1/plugins
	if (pathParts.length === 0) {
		return handlePluginApiList(env);
	}

	const pluginName = pathParts[0];

	// /api/v1/plugins/:name
	if (pathParts.length === 1) {
		return handlePluginApiGet(env, pluginName);
	}

	const action = pathParts[1];

	// /api/v1/plugins/:name/versions
	if (action === "versions") {
		return handlePluginApiVersions(env, pluginName);
	}

	// /api/v1/plugins/:name/latest
	if (action === "latest") {
		return handlePluginApiLatest(env, pluginName);
	}

	// /api/v1/plugins/:name/install
	if (action === "install" && req.method === "POST") {
		return handlePluginApiInstall(req);
	}

	// /api/v1/plugins/:name/:version
	if (pathParts.length === 2) {
		return handlePluginApiVersion(env, pluginName, action);
	}

	return jsonResponse({ error: "Unknown API endpoint" }, 404);
}

export default {
	async fetch(
		req: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			const repositoryPath = rawPathname(req.url);

			// Apply rate limiting for downloads and API endpoints
			if (shouldRateLimit(path) && env.RATE_LIMITER) {
				try {
					const clientIp = req.headers.get("CF-Connecting-IP") || "unknown";
					const { success } = await env.RATE_LIMITER.limit({ key: clientIp });
					if (!success) {
						return rateLimitExceeded();
					}
				} catch (e) {
					// Rate limiter binding may not be configured; allow request through
					console.warn("Rate limiter error (allowing request):", e);
				}
			}

			if (path === "/" || path === "") {
				return new Response(
					JSON.stringify(
						{
							service: "yams-repo",
							endpoints: {
								apt: "/aptrepo",
								yum: "/yumrepo",
								arch: "/archrepo",
								manifest: "/latest.json",
								gpg_key: "/gpg.key",
							},
						},
						null,
						2,
					),
					{ headers: { "Content-Type": "application/json; charset=utf-8" } },
				);
			}

			const repositoryRoute = resolveRepositoryRoute(repositoryPath, env);
			if (repositoryRoute) {
				return serveObjectOrDirectory(
					env,
					repositoryRoute.key,
					repositoryPath,
					req,
					_ctx,
					repositoryRoute.channel,
				);
			}
			if (isRepositoryCandidate(repositoryPath)) {
				return notFound(
					"unknown route",
					req.headers.get("CF-Ray") || undefined,
				);
			}

			// Plugin Registry API
			if (path.startsWith("/api/v1/plugins")) {
				const apiPath = path.replace("/api/v1/plugins", "").replace(/^\//, "");
				const pathParts = apiPath.length > 0 ? apiPath.split("/") : [];
				return handlePluginApi(env, req, pathParts);
			}

			// Plugin repo paths (file downloads)
			if (path.startsWith("/plugins")) {
				const key = normalizePath(path);
				return serveObjectOrDirectory(env, key, path, req, _ctx);
			}

			return notFound("unknown route", req.headers.get("CF-Ray") || undefined);
		} catch (err) {
			console.error("Worker unhandled error:", err);
			return new Response(
				JSON.stringify({
					error: "Internal server error",
					message: String(err),
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json; charset=utf-8" },
				},
			);
		}
	},
};
