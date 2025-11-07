import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker';
import { createMockEnv, createMockRequest, MockExecutionContext, getMockBucket, getMockRateLimiter } from './mocks';
import type { Env } from '../src/worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = any;

describe('Rate Limiting', () => {
  let env: Env;
  let ctx: MockExecutionContext;

  beforeEach(() => {
    env = createMockEnv();
    ctx = new MockExecutionContext();
  });

  describe('Package downloads', () => {
    it('should allow .deb downloads within rate limit', async () => {
      const debContent = new ArrayBuffer(1024);
      getMockBucket(env).set('aptrepo/pool/main/y/yams/yams_1.0.0_amd64.deb', debContent);

      const req = createMockRequest('https://repo.yams.dev/aptrepo/pool/main/y/yams/yams_1.0.0_amd64.deb', {
        headers: { 'CF-Connecting-IP': '192.168.1.1' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/vnd.debian.binary-package');
    });

    it('should rate limit .deb downloads when limit exceeded', async () => {
      const debContent = new ArrayBuffer(1024);
      getMockBucket(env).set('aptrepo/yams_1.0.0_amd64.deb', debContent);

      // Set rate limit to exceeded for this IP
      getMockRateLimiter(env).setExceeded('192.168.1.100');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/yams_1.0.0_amd64.deb', {
        headers: { 'CF-Connecting-IP': '192.168.1.100' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('60');

      const body = await res.json() as JsonObject;
      expect(body.error).toBe('Rate limit exceeded');
      expect(body.retry_after).toBe(60);
    });

    it('should rate limit .rpm downloads', async () => {
      const rpmContent = new ArrayBuffer(2048);
      getMockBucket(env).set('yumrepo/yams-1.0.0-1.x86_64.rpm', rpmContent);

      getMockRateLimiter(env).setExceeded('192.168.1.200');

      const req = createMockRequest('https://repo.yams.dev/yumrepo/yams-1.0.0-1.x86_64.rpm', {
        headers: { 'CF-Connecting-IP': '192.168.1.200' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(429);
    });

    it('should rate limit .tar.gz plugin downloads', async () => {
      const pluginContent = new ArrayBuffer(512);
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/plugin.tar.gz', pluginContent);

      getMockRateLimiter(env).setExceeded('192.168.1.300');

      const req = createMockRequest('https://repo.yams.dev/plugins/yams_ghidra/0.1.0/plugin.tar.gz', {
        headers: { 'CF-Connecting-IP': '192.168.1.300' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(429);
    });
  });

  describe('API endpoints', () => {
    it('should rate limit /latest.json', async () => {
      getMockBucket(env).set('latest.json', '{"version":"1.0.0"}');
      getMockRateLimiter(env).setExceeded('192.168.2.1');

      const req = createMockRequest('https://repo.yams.dev/latest.json', {
        headers: { 'CF-Connecting-IP': '192.168.2.1' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(429);
    });

    it('should rate limit /api/* endpoints', async () => {
      getMockRateLimiter(env).setExceeded('192.168.2.2');

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins', {
        headers: { 'CF-Connecting-IP': '192.168.2.2' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(429);
    });
  });

  describe('Paths excluded from rate limiting', () => {
    it('should NOT rate limit directory listings', async () => {
      getMockBucket(env).set('aptrepo/dists/stable/Release', 'test');
      getMockRateLimiter(env).setExceeded('192.168.3.1');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/', {
        headers: { 'CF-Connecting-IP': '192.168.3.1' },
      });
      const res = await worker.fetch(req, env, ctx);

      // Should return 200 (directory listing), not 429
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    });

    it('should NOT rate limit metadata files (Release, Packages)', async () => {
      getMockBucket(env).set('aptrepo/dists/stable/Release', 'test metadata');
      getMockRateLimiter(env).setExceeded('192.168.3.2');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/Release', {
        headers: { 'CF-Connecting-IP': '192.168.3.2' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
    });

    it('should NOT rate limit GPG key', async () => {
      getMockBucket(env).set('gpg.key', '-----BEGIN PGP PUBLIC KEY BLOCK-----');
      getMockRateLimiter(env).setExceeded('192.168.3.3');

      const req = createMockRequest('https://repo.yams.dev/gpg.key', {
        headers: { 'CF-Connecting-IP': '192.168.3.3' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
    });

    it('should NOT rate limit root endpoint', async () => {
      getMockRateLimiter(env).setExceeded('192.168.3.4');

      const req = createMockRequest('https://repo.yams.dev/', {
        headers: { 'CF-Connecting-IP': '192.168.3.4' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.service).toBe('yams-repo');
    });
  });

  describe('Per-IP isolation', () => {
    it('should track rate limits separately per IP', async () => {
      const debContent = new ArrayBuffer(1024);
      getMockBucket(env).set('aptrepo/yams_1.0.0_amd64.deb', debContent);

      // IP1 exceeds limit
      getMockRateLimiter(env).setExceeded('192.168.4.1');

      // IP1 should be blocked
      const req1 = createMockRequest('https://repo.yams.dev/aptrepo/yams_1.0.0_amd64.deb', {
        headers: { 'CF-Connecting-IP': '192.168.4.1' },
      });
      const res1 = await worker.fetch(req1, env, ctx);
      expect(res1.status).toBe(429);

      // IP2 should still work
      const req2 = createMockRequest('https://repo.yams.dev/aptrepo/yams_1.0.0_amd64.deb', {
        headers: { 'CF-Connecting-IP': '192.168.4.2' },
      });
      const res2 = await worker.fetch(req2, env, ctx);
      expect(res2.status).toBe(200);
    });
  });
});
