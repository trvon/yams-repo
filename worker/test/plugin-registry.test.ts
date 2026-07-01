import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker';
import { createMockEnv, createMockRequest, MockExecutionContext, getMockBucket } from './mocks';
import type { Env } from '../src/worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = any;

describe('Plugin Registry API', () => {
  let env: Env;
  let ctx: MockExecutionContext;

  beforeEach(() => {
    env = createMockEnv();
    ctx = new MockExecutionContext();
  });

  describe('GET /api/v1/plugins', () => {
    it('should list all available plugins', async () => {
      // Setup plugin manifests
      getMockBucket(env).set('plugins/yams_ghidra/manifest.json', JSON.stringify({
        name: 'yams_ghidra',
        version: '0.1.0',
        description: 'Binary analysis via Ghidra',
      }));
      getMockBucket(env).set('plugins/yams_pdf/manifest.json', JSON.stringify({
        name: 'yams_pdf',
        version: '0.2.0',
        description: 'PDF text extraction',
      }));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');

      const body = await res.json() as JsonObject;
      expect(body.plugins).toHaveLength(2);
      expect(body.plugins[0].name).toBe('yams_ghidra');
      expect(body.plugins[1].name).toBe('yams_pdf');
    });

    it('should return empty list when no plugins available', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.plugins).toEqual([]);
    });
  });

  describe('GET /api/v1/plugins/:name', () => {
    it('should return plugin metadata', async () => {
      const manifest = {
        name: 'yams_ghidra',
        version: '0.1.0',
        description: 'Binary analysis via Ghidra',
        author: 'YAMS Team',
        license: 'Apache-2.0',
        interfaces: ['content_extractor_v1'],
        homepage: 'https://github.com/yams/plugins/ghidra',
      };
      getMockBucket(env).set('plugins/yams_ghidra/manifest.json', JSON.stringify(manifest));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.name).toBe('yams_ghidra');
      expect(body.version).toBe('0.1.0');
      expect(body.description).toBe('Binary analysis via Ghidra');
    });

    it('should return 404 for non-existent plugin', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/nonexistent');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
      const body = await res.json() as JsonObject;
      expect(body.error).toContain('not found');
    });
  });

  describe('GET /api/v1/plugins/:name/versions', () => {
    it('should list all versions of a plugin', async () => {
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/manifest.json', JSON.stringify({ version: '0.1.0' }));
      getMockBucket(env).set('plugins/yams_ghidra/0.2.0/manifest.json', JSON.stringify({ version: '0.2.0' }));
      getMockBucket(env).set('plugins/yams_ghidra/0.3.0/manifest.json', JSON.stringify({ version: '0.3.0' }));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/versions');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.versions).toEqual(['0.3.0', '0.2.0', '0.1.0']); // Sorted descending
    });

    it('should return 404 if plugin has no versions', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/versions');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/plugins/:name/:version', () => {
    it('should return specific version metadata', async () => {
      const manifest = {
        name: 'yams_ghidra',
        version: '0.1.0',
        description: 'Binary analysis via Ghidra',
        platform: {
          'linux-x64': {
            url: 'https://repo.yams.dev/plugins/yams_ghidra/0.1.0/yams_ghidra-0.1.0-linux-x64.tar.gz',
            checksum: 'sha256:abc123',
            size: 2500000,
          },
        },
      };
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/manifest.json', JSON.stringify(manifest));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/0.1.0');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.version).toBe('0.1.0');
      expect(body.platform).toHaveProperty('linux-x64');
    });

    it('should return 404 for non-existent version', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/99.0.0');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/plugins/:name/latest', () => {
    it('should redirect to latest version download', async () => {
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/manifest.json', JSON.stringify({ name: 'yams_ghidra', version: '0.1.0' }));
      getMockBucket(env).set('plugins/yams_ghidra/0.2.0/manifest.json', JSON.stringify({ name: 'yams_ghidra', version: '0.2.0' }));
      getMockBucket(env).set('plugins/yams_ghidra/0.3.0/manifest.json', JSON.stringify({ name: 'yams_ghidra', version: '0.3.0' }));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/latest');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.version).toBe('0.3.0'); // Latest version
      expect(body.name).toBe('yams_ghidra');
    });
  });

  describe('POST /api/v1/plugins/:name/install', () => {
    it('should track installation metrics', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '0.1.0',
          platform: 'linux-x64',
          yams_version: '1.0.0',
        }),
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonObject;
      expect(body.success).toBe(true);
    });

    it('should validate request body', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'data' }),
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(400);
      const body = await res.json() as JsonObject;
      expect(body.error).toContain('Invalid');
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers for API endpoints', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });

    it('should handle OPTIONS preflight requests', async () => {
      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra', {
        method: 'OPTIONS',
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('Cache headers', () => {
    it('should cache plugin list for short duration', async () => {
      getMockBucket(env).set('plugins/yams_ghidra/manifest.json', JSON.stringify({ name: 'yams_ghidra' }));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('Cache-Control')).toContain('max-age');
    });

    it('should cache specific version metadata longer', async () => {
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/manifest.json', JSON.stringify({
        name: 'yams_ghidra',
        version: '0.1.0',
      }));

      const req = createMockRequest('https://repo.yams.dev/api/v1/plugins/yams_ghidra/0.1.0');
      const res = await worker.fetch(req, env, ctx);

      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toContain('max-age');
      // Version-specific should cache longer than list
      expect(parseInt(cacheControl!.match(/max-age=(\d+)/)![1])).toBeGreaterThan(300);
    });
  });
});
