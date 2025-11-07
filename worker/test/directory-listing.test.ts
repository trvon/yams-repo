import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/worker';
import { createMockEnv, createMockRequest, MockExecutionContext, getMockBucket } from './mocks';
import type { Env } from '../src/worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = any;

describe('Directory Listing', () => {
  let env: Env;
  let ctx: MockExecutionContext;

  beforeEach(() => {
    env = createMockEnv();
    ctx = new MockExecutionContext();
  });

  describe('APT repository listing', () => {
    it('should list files when directory path has trailing slash', async () => {
      // Setup directory structure
      getMockBucket(env).set('aptrepo/dists/stable/Release', 'test');
      getMockBucket(env).set('aptrepo/dists/stable/InRelease', 'test');
      getMockBucket(env).set('aptrepo/dists/stable/main/binary-amd64/Packages', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');

      const html = await res.text();
      expect(html).toContain('Index of /aptrepo/dists/stable/');
      expect(html).toContain('Release');
      expect(html).toContain('InRelease');
      expect(html).toContain('main/');
    });

    it('should redirect to trailing slash for directory', async () => {
      getMockBucket(env).set('aptrepo/dists/stable/Release', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('/aptrepo/dists/stable/');
    });

    it('should include parent directory link', async () => {
      getMockBucket(env).set('aptrepo/dists/stable/Release', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/');
      const res = await worker.fetch(req, env, ctx);

      const html = await res.text();
      expect(html).toContain('../');
      expect(html).toContain('Parent Directory');
    });

    it('should show file sizes and timestamps', async () => {
      getMockBucket(env).set('aptrepo/pool/main/y/yams/yams_1.0.0_amd64.deb', new ArrayBuffer(2048000));

      const req = createMockRequest('https://repo.yams.dev/aptrepo/pool/main/y/yams/');
      const res = await worker.fetch(req, env, ctx);

      const html = await res.text();
      expect(html).toContain('yams_1.0.0_amd64.deb');
      expect(html).toMatch(/\d+(\.\d+)?\s*(KB|MB|GB)/); // Size format
    });

    it('should sort directories before files', async () => {
      getMockBucket(env).set('aptrepo/test/file1.txt', 'test');
      getMockBucket(env).set('aptrepo/test/subdir/file2.txt', 'test');
      getMockBucket(env).set('aptrepo/test/anotherfile.txt', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/test/');
      const res = await worker.fetch(req, env, ctx);

      const html = await res.text();
      const subdirIndex = html.indexOf('subdir/');
      const file1Index = html.indexOf('file1.txt');
      expect(subdirIndex).toBeLessThan(file1Index);
    });
  });

  describe('YUM repository listing', () => {
    it('should list YUM repo files', async () => {
      getMockBucket(env).set('yumrepo/repodata/repomd.xml', 'test');
      getMockBucket(env).set('yumrepo/yams-1.0.0-1.x86_64.rpm', new ArrayBuffer(1024));

      const req = createMockRequest('https://repo.yams.dev/yumrepo/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('repodata/');
      expect(html).toContain('yams-1.0.0-1.x86_64.rpm');
    });
  });

  describe('Plugin repository listing', () => {
    it('should list plugin manifests', async () => {
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/manifest.json', '{}');
      getMockBucket(env).set('plugins/yams_pdf/0.2.0/manifest.json', '{}');

      const req = createMockRequest('https://repo.yams.dev/plugins/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('yams_ghidra/');
      expect(html).toContain('yams_pdf/');
    });

    it('should list plugin versions', async () => {
      getMockBucket(env).set('plugins/yams_ghidra/0.1.0/plugin.tar.gz', new ArrayBuffer(1024));
      getMockBucket(env).set('plugins/yams_ghidra/0.2.0/plugin.tar.gz', new ArrayBuffer(1024));

      const req = createMockRequest('https://repo.yams.dev/plugins/yams_ghidra/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('0.1.0/');
      expect(html).toContain('0.2.0/');
    });
  });

  describe('HTML generation', () => {
    it('should include security headers', async () => {
      getMockBucket(env).set('aptrepo/test.txt', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should escape HTML in filenames', async () => {
      getMockBucket(env).set('aptrepo/<script>alert(1)</script>.txt', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/');
      const res = await worker.fetch(req, env, ctx);

      const html = await res.text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('should include breadcrumb navigation', async () => {
      getMockBucket(env).set('aptrepo/dists/stable/main/binary-amd64/Packages', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/dists/stable/main/');
      const res = await worker.fetch(req, env, ctx);

      const html = await res.text();
      expect(html).toContain('/aptrepo/');
      expect(html).toContain('/aptrepo/dists/');
      expect(html).toContain('/aptrepo/dists/stable/');
    });

    it('should return 404 for empty directories', async () => {
      const req = createMockRequest('https://repo.yams.dev/aptrepo/nonexistent/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe('Accept header negotiation', () => {
    it('should return JSON when Accept: application/json', async () => {
      getMockBucket(env).set('aptrepo/test.txt', 'test');
      getMockBucket(env).set('aptrepo/subdir/file.txt', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/', {
        headers: { Accept: 'application/json' },
      });
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');

      const json = await res.json() as JsonObject;
      expect(json).toHaveProperty('path');
      expect(json).toHaveProperty('files');
      expect(json.files).toContain('test.txt');
      expect(json.files).toContain('subdir/');
    });

    it('should return HTML by default', async () => {
      getMockBucket(env).set('aptrepo/test.txt', 'test');

      const req = createMockRequest('https://repo.yams.dev/aptrepo/');
      const res = await worker.fetch(req, env, ctx);

      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    });
  });
});
