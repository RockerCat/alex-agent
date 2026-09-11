import type { AssetStorage } from "@/lib/agent/assetStorage";
import { AssetStorageError } from "@/lib/agent/assetStorage";

/**
 * In-memory stand-in for Supabase Storage, mirroring the real
 * SupabaseAssetStorage's contract: uploading to a path that already
 * exists fails rather than silently overwriting (matching `upsert:
 * false`), so tests can exercise the same race-safety behavior without
 * a real Supabase project.
 */
export class FakeAssetStorage implements AssetStorage {
  files = new Map<string, Buffer>();
  failNextUpload = false;

  async upload(path: string, data: Buffer): Promise<void> {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new AssetStorageError("Simulated storage upload failure.");
    }
    if (this.files.has(path)) {
      throw new AssetStorageError(`Object already exists at path "${path}".`);
    }
    this.files.set(path, data);
  }

  async createSignedUrl(path: string): Promise<string | null> {
    if (!this.files.has(path)) return null;
    return `https://fake-storage.local/${path}?signed=1`;
  }

  async download(path: string): Promise<Buffer> {
    const data = this.files.get(path);
    if (!data) {
      throw new AssetStorageError(`Object not found at path "${path}".`);
    }
    return data;
  }
}
