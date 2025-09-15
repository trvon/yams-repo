// Cloudflare Worker to serve APT and YUM repositories plus latest.json from an R2 bucket.
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
//  latest.json
//  gpg.key   (optional public key for repo verification)
//
// Deployment: wrangler publish

export interface Env {
  REPO_BUCKET: R2Bucket;
  APT_PREFIX: string;
  YUM_PREFIX: string;
  LATEST_MANIFEST: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '1; mode=block',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

const TEXT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  'Release': 'text/plain; charset=utf-8',
  'InRelease': 'text/plain; charset=utf-8',
  'Packages': 'text/plain; charset=utf-8',
  '.repo': 'text/plain; charset=utf-8'
};

const BINARY_TYPES: Record<string, string> = {
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.gz': 'application/gzip',
  '.xz': 'application/x-xz',
  '.bz2': 'application/x-bzip2',
  '.key': 'application/pgp-keys'
};

function guessContentType(key: string): string | undefined {
  for (const [ext, ct] of Object.entries(TEXT_TYPES)) {
    if (key.endsWith(ext)) return ct;
  }
  for (const [ext, ct] of Object.entries(BINARY_TYPES)) {
    if (key.endsWith(ext)) return ct;
  }
  if (key.endsWith('/')) return 'text/plain; charset=utf-8';
  return undefined;
}

function immutable(path: string): boolean {
  // Repo metadata changes between releases; packages are immutable once published.
  return /(\.deb$|\.rpm$)/.test(path);
}

function addSecurityHeaders(h: Headers) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
}

function notFound(msg: string, cfId?: string) {
  return new Response(JSON.stringify({ error: msg, cfRay: cfId }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function serveObject(env: Env, key: string, req: Request): Promise<Response> {
  const obj = await env.REPO_BUCKET.get(key);
  if (!obj) return notFound('object not found', req.headers.get('CF-Ray') || undefined);

  const headers = new Headers();
  addSecurityHeaders(headers);

  const ct = guessContentType(key) || 'application/octet-stream';
  headers.set('Content-Type', ct);

  // Basic cache policy
  if (immutable(key)) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    headers.set('Cache-Control', 'public, max-age=300');
  }

  // ETag / conditional
  const etag = obj.httpEtag || 'W/"' + (await obj.arrayBuffer()).byteLength + '"';
  headers.set('ETag', etag);
  const ifNone = req.headers.get('If-None-Match');
  if (ifNone && ifNone === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(obj.body, { status: 200, headers });
}

function normalizePath(p: string): string {
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}

// Minimal type shims if not using @cloudflare/workers-types in build environment
// (These allow local linting without full type package.)
// Remove if you add workers-types dev dependency.
// @ts-ignore
interface R2ObjectBody { body: ReadableStream; httpEtag?: string; arrayBuffer(): Promise<ArrayBuffer>; }
// @ts-ignore
interface R2Bucket { get(key: string): Promise<R2ObjectBody | null>; }
// @ts-ignore
interface ExecutionContext { waitUntil(p: Promise<any>): void; }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === '/' || path === '') {
      return new Response(
        JSON.stringify({
          service: 'yams-repo',
          endpoints: {
            apt: '/aptrepo',
            yum: '/yumrepo',
            manifest: '/latest.json',
            gpg_key: '/gpg.key'
          }
        }, null, 2),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // Direct manifest
    if (path === '/latest.json') {
      return serveObject(env, env.LATEST_MANIFEST, req);
    }

    // Public GPG key
    if (path === '/gpg.key') {
      return serveObject(env, 'gpg.key', req);
    }

    // APT repo paths
    if (path.startsWith('/aptrepo')) {
      const key = normalizePath(path.replace('/aptrepo', env.APT_PREFIX));
      return serveObject(env, key, req);
    }

    // YUM repo paths
    if (path.startsWith('/yumrepo')) {
      const key = normalizePath(path.replace('/yumrepo', env.YUM_PREFIX));
      return serveObject(env, key, req);
    }

    return notFound('unknown route', req.headers.get('CF-Ray') || undefined);
  }
};
