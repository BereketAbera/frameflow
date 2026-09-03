export type ObjectMetadata = { key: string; contentType?: string; contentLength?: number; etag?: string };
export type ObjectBody = { stream: NodeJS.ReadableStream; contentType: string; contentLength?: number; etag?: string };

export interface ObjectStorage {
  createPresignedUploadUrl(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<{ url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string }>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  /** Aborting the signal stops the transfer and rejects with an AbortError. */
  downloadToFile(key: string, destinationPath: string, signal?: AbortSignal): Promise<void>;
  uploadFile(input: { key: string; sourcePath: string; contentType: string; signal?: AbortSignal }): Promise<ObjectMetadata>;
  getObjectStream(key: string): Promise<ObjectBody>;
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  listPrefix(prefix: string): Promise<ObjectMetadata[]>;
}

export function assertObjectKey(key: string): string {
  if (!key.startsWith("videos/") || key.startsWith("/") || key.includes("\\") || key.includes("..") || key.includes("//") || /[\0\r\n]/.test(key)) {
    throw new Error("Invalid video object key");
  }
  return key;
}

export function videoObjectKeys(videoId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(videoId)) throw new Error("Invalid video ID");
  const root = `videos/${videoId}`;
  return { root, source: `${root}/source/source.mp4`, outputPrefix: `${root}/published`, stagingRoot: `${root}/staging` };
}
