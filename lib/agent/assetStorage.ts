import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Private Supabase Storage bucket for generated asset files (created by
// supabase/migrations/0005_content_assets.sql). Never public — the app
// previews assets via short-lived signed URLs generated server-side on
// each page render, so the browser never needs (and never gets) a
// storage credential.
export const ASSET_BUCKET = "solardesk-assets";

export class AssetStorageError extends Error {}

/**
 * Thin seam over Supabase Storage, mirroring the AiClient injection
 * pattern already used for OpenAI (lib/agent/aiClient.ts): production
 * code uses SupabaseAssetStorage; tests inject an in-memory fake so the
 * asset-generation/concurrency/error paths are testable without a real
 * Supabase project.
 */
export interface AssetStorage {
  /** Uploads exactly once per path — must fail (never overwrite) if the path already exists. */
  upload(path: string, data: Buffer, contentType: string): Promise<void>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string | null>;
  /**
   * Reads back a previously uploaded object. Used to reuse a
   * Visual-Director-generated source image (see assetGenerator.ts's
   * "regenerate reuses the same plan/generated image" semantics and
   * assetRevision.ts's Request Changes revisions) without a new paid
   * generative call. Throws AssetStorageError if the object doesn't exist.
   */
  download(path: string): Promise<Buffer>;
}

export class SupabaseAssetStorage implements AssetStorage {
  constructor(private db: SupabaseClient<Database>) {}

  async upload(path: string, data: Buffer, contentType: string): Promise<void> {
    const { error } = await this.db.storage.from(ASSET_BUCKET).upload(path, data, {
      contentType,
      upsert: false,
    });
    if (error) {
      throw new AssetStorageError(error.message);
    }
  }

  async createSignedUrl(path: string, expiresInSeconds: number): Promise<string | null> {
    const { data, error } = await this.db.storage.from(ASSET_BUCKET).createSignedUrl(path, expiresInSeconds);
    if (error || !data) return null;
    return data.signedUrl;
  }

  async download(path: string): Promise<Buffer> {
    const { data, error } = await this.db.storage.from(ASSET_BUCKET).download(path);
    if (error || !data) {
      throw new AssetStorageError(error?.message ?? `Object not found at path "${path}".`);
    }
    return Buffer.from(await data.arrayBuffer());
  }
}
