// Mock R2 bucket for testing
import type { Env } from '../src/worker';

export class MockR2ObjectBody {
  public bodyUsed = false;
  public size: number;
  public etag: string;
  public httpMetadata: Record<string, string> = {};
  public customMetadata: Record<string, string> = {};
  public range?: { offset: number; length: number };
  public checksums = { toJSON: () => ({}) };
  public version = '';
  public key = '';
  public uploaded = new Date();
  public storageClass = 'STANDARD';
  public writeHttpMetadata = () => {};

  constructor(
    public body: ReadableStream,
    public httpEtag: string,
    private content: ArrayBuffer
  ) {
    this.size = content.byteLength;
    this.etag = httpEtag;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true;
    return this.content;
  }

  async text(): Promise<string> {
    this.bodyUsed = true;
    const decoder = new TextDecoder();
    return decoder.decode(this.content);
  }

  async json<T>(): Promise<T> {
    this.bodyUsed = true;
    const textContent = new TextDecoder().decode(this.content);
    return JSON.parse(textContent) as T;
  }

  async blob(): Promise<Blob> {
    this.bodyUsed = true;
    return new Blob([this.content]);
  }

  async bytes(): Promise<Uint8Array> {
    this.bodyUsed = true;
    return new Uint8Array(this.content);
  }
}

export class MockR2Bucket {
  private objects: Map<string, { content: ArrayBuffer; etag: string; uploaded?: Date }> = new Map();

  set(key: string, content: string | ArrayBuffer, etag?: string): void {
    const buffer: ArrayBuffer = typeof content === 'string'
      ? new TextEncoder().encode(content).buffer as ArrayBuffer
      : content;
    this.objects.set(key, {
      content: buffer,
      etag: etag || `"${Math.random().toString(36).substring(7)}"`,
      uploaded: new Date(),
    });
  }

  async get(key: string): Promise<MockR2ObjectBody | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(obj.content));
        controller.close();
      },
    });

    return new MockR2ObjectBody(stream, obj.etag, obj.content);
  }

  async list(options?: { prefix?: string; delimiter?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    truncated: boolean;
    delimitedPrefixes: string[];
  }> {
    const prefix = options?.prefix || '';
    const delimiter = options?.delimiter;
    const limit = options?.limit || 1000;

    const matchingKeys = Array.from(this.objects.keys())
      .filter(key => key.startsWith(prefix));

    if (!delimiter) {
      return {
        objects: matchingKeys.slice(0, limit).map(key => ({
          key,
          size: this.objects.get(key)!.content.byteLength,
          uploaded: this.objects.get(key)!.uploaded || new Date(),
        })),
        truncated: matchingKeys.length > limit,
        delimitedPrefixes: [],
      };
    }

    // Handle delimiter (for directory listing)
    const prefixes = new Set<string>();
    const files: Array<{ key: string; size: number; uploaded: Date }> = [];

    for (const key of matchingKeys) {
      const relativePath = key.substring(prefix.length);
      const delimiterIndex = relativePath.indexOf(delimiter);

      if (delimiterIndex >= 0) {
        // This is a "subdirectory"
        const dirPrefix = prefix + relativePath.substring(0, delimiterIndex + 1);
        prefixes.add(dirPrefix);
      } else if (relativePath.length > 0) {
        // This is a file in the current directory
        files.push({
          key,
          size: this.objects.get(key)!.content.byteLength,
          uploaded: this.objects.get(key)!.uploaded || new Date(),
        });
      }
    }

    return {
      objects: files.slice(0, limit),
      truncated: files.length > limit,
      delimitedPrefixes: Array.from(prefixes).sort(),
    };
  }

  clear(): void {
    this.objects.clear();
  }

  // Unused R2Bucket methods (required by interface)
  async head(_key: string): Promise<never> {
    throw new Error('head() not implemented in mock');
  }

  async put(_key: string, _value: ReadableStream | ArrayBuffer | string): Promise<never> {
    throw new Error('put() not implemented in mock');
  }

  async delete(_keys: string | string[]): Promise<never> {
    throw new Error('delete() not implemented in mock');
  }

  async createMultipartUpload(_key: string): Promise<never> {
    throw new Error('createMultipartUpload() not implemented in mock');
  }

  async resumeMultipartUpload(_key: string, _uploadId: string): Promise<never> {
    throw new Error('resumeMultipartUpload() not implemented in mock');
  }
}

export class MockRateLimiter {
  private limits: Map<string, { count: number; resetAt: number }> = new Map();
  private maxRequests: number;
  private periodSeconds: number;

  constructor(maxRequests = 100, periodSeconds = 60) {
    this.maxRequests = maxRequests;
    this.periodSeconds = periodSeconds;
  }

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now();
    const limit = this.limits.get(options.key);

    if (!limit || now >= limit.resetAt) {
      // New period or expired
      this.limits.set(options.key, {
        count: 1,
        resetAt: now + this.periodSeconds * 1000,
      });
      return { success: true };
    }

    if (limit.count >= this.maxRequests) {
      return { success: false };
    }

    limit.count++;
    return { success: true };
  }

  // Test helper: manually exceed limit for a key
  setExceeded(key: string): void {
    const now = Date.now();
    this.limits.set(key, {
      count: this.maxRequests + 1,
      resetAt: now + this.periodSeconds * 1000,
    });
  }

  reset(): void {
    this.limits.clear();
  }
}

export interface MockEnv {
  REPO_BUCKET: MockR2Bucket;
  RATE_LIMITER: MockRateLimiter;
  APT_PREFIX: string;
  YUM_PREFIX: string;
  LATEST_MANIFEST: string;
}

export function createMockEnv(): Env {
  return {
    REPO_BUCKET: new MockR2Bucket() as unknown as Env['REPO_BUCKET'],
    RATE_LIMITER: new MockRateLimiter() as unknown as Env['RATE_LIMITER'],
    APT_PREFIX: 'aptrepo',
    YUM_PREFIX: 'yumrepo',
    LATEST_MANIFEST: 'latest.json',
  };
}

export class MockExecutionContext {
  public props = {};

  waitUntil(_promise: Promise<unknown>): void {
    // No-op for tests
  }

  passThroughOnException(): void {
    // No-op for tests
  }
}

export function createMockRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

// Helper to access mock methods in tests
export function getMockBucket(env: Env): MockR2Bucket {
  return env.REPO_BUCKET as unknown as MockR2Bucket;
}

export function getMockRateLimiter(env: Env): MockRateLimiter {
  return env.RATE_LIMITER as unknown as MockRateLimiter;
}
