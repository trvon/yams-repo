import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker';
import { createMockEnv, createMockRequest, MockExecutionContext, getMockBucket } from './mocks';
import type { Env } from '../src/worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = any;

describe('YAMS Repository Worker', () => {
  let env: Env;
  let ctx: MockExecutionContext;

  beforeEach(() => {
    env = createMockEnv();
    ctx = new MockExecutionContext();
  });

  describe('Root endpoint', () => {
    it('should return service info with endpoints', async () => {
      const req = createMockRequest('https://repo.yams.dev/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');

      const body = await res.json() as JsonObject;
      expect(body).toEqual({
        service: 'yams-repo',
        endpoints: {
          apt: '/aptrepo',
          yum: '/yumrepo',
          manifest: '/latest.json',
          gpg_key: '/gpg.key',
        },
      });
    });

    it('should handle empty path', async () => {
      const req = createMockRequest('https://repo.yams.dev');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.service).toBe('yams-repo');
    });
  });

  describe('Latest manifest endpoint', () => {
    it('should serve latest.json', async () => {
      const manifest = { version: '1.0.0', packages: [] };
      getMockBucket(env).set('latest.json', JSON.stringify(manifest));

      const req = createMockRequest('https://repo.yams.dev/latest.json');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      const body = await res.json() as JsonObject;
      expect(body).toEqual(manifest);
    });

    it('should return 404 if manifest not found', async () => {
      const req = createMockRequest('https://repo.yams.dev/latest.json');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
      const body = await res.json() as JsonObject;
      expect(body.error).toBe('object not found');
    });

    it('should include security headers', async () => {
      getMockBucket(env).set('latest.json', '{}');
      const req = createMockRequest('https://repo.yams.dev/latest.json');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    });
  });

  describe('GPG key endpoint', () => {
    it('should serve gpg.key', async () => {
      const gpgKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----';
      getMockBucket(env).set('gpg.key', gpgKey);

      const req = createMockRequest('https://repo.yams.dev/gpg.key');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pgp-keys');
      const body = await res.text();
      expect(body).toBe(gpgKey);
    });

    it('should return 404 if key not found', async () => {
      const req = createMockRequest('https://repo.yams.dev/gpg.key');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe('APT repository endpoint', () => {
    it('should serve Release file', async () => {
      const release = 'Origin: YAMS\nLabel: YAMS\nSuite: stable';
      getMockBucket(env).set('aptrepo/dists/stable/Release', release);

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/Release');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      const body = await res.text();
      expect(body).toBe(release);
    });

    it('should serve Packages file', async () => {
      const packages = 'Package: yams\nVersion: 1.0.0';
      getMockBucket(env).set('aptrepo/dists/stable/main/binary-amd64/Packages', packages);

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/main/binary-amd64/Packages');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    });

    it('should serve .deb packages with immutable cache', async () => {
      const debContent = new ArrayBuffer(1024);
      getMockBucket(env).set('aptrepo/pool/main/y/yams/yams_1.0.0_amd64.deb', debContent);

      const req = createMockRequest('https://repo.yams.dev/aptrepo/pool/main/y/yams/yams_1.0.0_amd64.deb');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/vnd.debian.binary-package');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    });

    it('should serve metadata with short cache', async () => {
      getMockBucket(env).set('aptrepo/dists/stable/Release', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/Release');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    });
  });

  describe('YUM repository endpoint', () => {
    it('should serve repomd.xml', async () => {
      const repomd = '<?xml version="1.0"?><repomd></repomd>';
      getMockBucket(env).set('yumrepo/repodata/repomd.xml', repomd);

      const req = createMockRequest('https://repo.yams.dev/yumrepo/repodata/repomd.xml');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    });

    it('should serve .rpm packages with immutable cache', async () => {
      const rpmContent = new ArrayBuffer(2048);
      getMockBucket(env).set('yumrepo/yams-1.0.0-1.x86_64.rpm', rpmContent);

      const req = createMockRequest('https://repo.yams.dev/yumrepo/yams-1.0.0-1.x86_64.rpm');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/x-rpm');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    });
  });

  describe('ETag support', () => {
    it('should return 304 for matching ETag', async () => {
      const etag = '"test-etag-123"';
      getMockBucket(env).set('latest.json', '{}', etag);

      const req = createMockRequest('https://repo.yams.dev/latest.json', {
        headers: { 'If-None-Match': etag },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(304);
      expect(res.headers.get('ETag')).toBe(etag);
    });

    it('should return full content for non-matching ETag', async () => {
      const etag = '"test-etag-123"';
      getMockBucket(env).set('latest.json', '{"version":"1.0.0"}', etag);

      const req = createMockRequest('https://repo.yams.dev/latest.json', {
        headers: { 'If-None-Match': '"different-etag"' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.version).toBe('1.0.0');
    });
  });

  describe('Error handling', () => {
    it('should return 404 for unknown routes', async () => {
      const req = createMockRequest('https://repo.yams.dev/unknown/path');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
      const body = await res.json() as JsonObject;
      expect(body.error).toBe('unknown route');
    });

    it('should include CF-Ray in error responses', async () => {
      const req = createMockRequest('https://repo.yams.dev/unknown', {
        headers: { 'CF-Ray': 'test-ray-id' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
      const body = await res.json() as JsonObject;
      expect(body.cfRay).toBe('test-ray-id');
    });
  });

  describe('Content-Type detection', () => {
    it('should detect .json files', async () => {
      getMockBucket(env).set('test.json', '{}');
      const req = createMockRequest('https://repo.yams.dev/aptrepo/test.json');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });

    it('should detect .gz files', async () => {
      getMockBucket(env).set('aptrepo/Packages.gz', new ArrayBuffer(512));
      const req = createMockRequest('https://repo.yams.dev/aptrepo/Packages.gz');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('Content-Type')).toBe('application/gzip');
    });

    it('should detect .xz files', async () => {
      getMockBucket(env).set('yumrepo/repodata/primary.xml.xz', new ArrayBuffer(512));
      const req = createMockRequest('https://repo.yams.dev/yumrepo/repodata/primary.xml.xz');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('Content-Type')).toBe('application/x-xz');
    });
  });
});
