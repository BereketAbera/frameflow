import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type VideoStatus = "uploading" | "uploaded" | "queued" | "processing" | "completed" | "failed";

export type VideoRecord = {
  id: string;
  originalFilename: string;
  sourcePath: string;
  status: VideoStatus;
  hatchetRunId: string | null;
  masterPlaylistPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  processingStartedAt: string | null;
  processingCompletedAt: string | null;
  sourceObjectKey: string | null; outputPrefix: string | null; masterPlaylistObjectKey: string | null;
  uploadStatus: "pending" | "uploaded" | "expired"; uploadExpiresAt: string | null;
  sourceEtag: string | null; sourceSizeBytes: number | null; declaredSizeBytes: number | null;
  userId: string | null;
};

type VideoRow = {
  id: string; original_filename: string; source_path: string; status: VideoStatus;
  hatchet_run_id: string | null; master_playlist_path: string | null;
  error_code: string | null; error_message: string | null; created_at: string; updated_at: string;
  processing_started_at: string | null; processing_completed_at: string | null;
  source_object_key:string|null;output_prefix:string|null;master_playlist_object_key:string|null;upload_status:"pending"|"uploaded"|"expired";upload_expires_at:string|null;source_etag:string|null;source_size_bytes:number|null;declared_size_bytes:number|null;user_id:string|null;
};

const columns = `id, original_filename, source_path, status, hatchet_run_id, master_playlist_path,
  error_code, error_message, created_at, updated_at, processing_started_at, processing_completed_at,
  source_object_key, output_prefix, master_playlist_object_key, upload_status, upload_expires_at, source_etag, source_size_bytes, declared_size_bytes, user_id`;

function mapRow(row: VideoRow): VideoRecord {
  return {
    id: row.id, originalFilename: row.original_filename, sourcePath: row.source_path, status: row.status,
    hatchetRunId: row.hatchet_run_id, masterPlaylistPath: row.master_playlist_path,
    errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at,
    updatedAt: row.updated_at, processingStartedAt: row.processing_started_at,
    processingCompletedAt: row.processing_completed_at,
    sourceObjectKey:row.source_object_key,outputPrefix:row.output_prefix,masterPlaylistObjectKey:row.master_playlist_object_key,
    uploadStatus:row.upload_status,uploadExpiresAt:row.upload_expires_at,sourceEtag:row.source_etag,sourceSizeBytes:row.source_size_bytes,declaredSizeBytes:row.declared_size_bytes,
    userId: row.user_id,
  };
}

export class VideoRepository {
  readonly database: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }

  close(): void { this.database.close(); }
  healthcheck(): boolean { return this.database.prepare("SELECT 1 AS ok").get() !== undefined; }

  createUploading(input: { id: string; originalFilename: string; sourcePath: string }): VideoRecord {
    const timestamp = this.now();
    this.database.prepare(`INSERT INTO videos
      (id, original_filename, source_path, status, created_at, updated_at)
      VALUES (?, ?, ?, 'uploading', ?, ?)`).run(input.id, input.originalFilename, input.sourcePath, timestamp, timestamp);
    return this.require(input.id);
  }

  createPendingUpload(input:{id:string;userId?:string;originalFilename:string;sourceObjectKey:string;outputPrefix:string;sizeBytes:number;expiresAt:string}):VideoRecord{
    const timestamp=this.now();this.database.prepare(`INSERT INTO videos
      (id,user_id,original_filename,source_path,status,created_at,updated_at,source_object_key,output_prefix,upload_status,upload_expires_at,declared_size_bytes)
      VALUES(?,?,?,?,'uploading',?,?,?,?, 'pending',?,?)`).run(input.id,input.userId??null,input.originalFilename,"",timestamp,timestamp,input.sourceObjectKey,input.outputPrefix,input.expiresAt,input.sizeBytes);
    return this.require(input.id);
  }

  markObjectUploaded(id:string,metadata:{etag?:string;sizeBytes:number}):VideoRecord{
    const existing=this.require(id);if(existing.uploadStatus==="uploaded")return existing;
    if(existing.uploadStatus!=="pending"||existing.status!=="uploading")throw new Error("Upload cannot be completed");
    this.database.prepare(`UPDATE videos SET status='uploaded',upload_status='uploaded',source_etag=?,source_size_bytes=?,updated_at=? WHERE id=? AND upload_status='pending'`)
      .run(metadata.etag??null,metadata.sizeBytes,this.now(),id);return this.require(id);
  }

  markUploadExpired(id:string):VideoRecord{const r=this.require(id);if(r.uploadStatus!=="pending")return r;this.database.prepare(`UPDATE videos SET upload_status='expired',status='failed',error_code='UPLOAD_EXPIRED',error_message='The upload authorization expired.',updated_at=?,processing_completed_at=? WHERE id=? AND upload_status='pending'`).run(this.now(),this.now(),id);return this.require(id);}

  get(id: string): VideoRecord | null {
    const row = this.database.prepare(`SELECT ${columns} FROM videos WHERE id = ?`).get(id) as VideoRow | undefined;
    return row ? mapRow(row) : null;
  }

  getOwned(id: string, userId: string): VideoRecord | null {
    const row = this.database.prepare(`SELECT ${columns} FROM videos WHERE id = ? AND user_id = ?`).get(id, userId) as VideoRow | undefined;
    return row ? mapRow(row) : null;
  }

  require(id: string): VideoRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Video record not found: ${id}`);
    return record;
  }

  list(limit: number): VideoRecord[] {
    return (this.database.prepare(`SELECT ${columns} FROM videos ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as VideoRow[]).map(mapRow);
  }

  listOwned(userId: string, limit: number): VideoRecord[] {
    return (this.database.prepare(`SELECT ${columns} FROM videos WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(userId, limit) as VideoRow[]).map(mapRow);
  }

  deleteOwned(id: string, userId: string): boolean {
    return this.database.prepare("DELETE FROM videos WHERE id = ? AND user_id = ?").run(id, userId).changes === 1;
  }

  listStaleActive(before: string): VideoRecord[] {
    return (this.database.prepare(`SELECT ${columns} FROM videos
      WHERE status IN ('queued', 'processing') AND updated_at < ? ORDER BY updated_at ASC`).all(before) as VideoRow[]).map(mapRow);
  }
  listExpiredPending(before:string):VideoRecord[]{return(this.database.prepare(`SELECT ${columns} FROM videos WHERE upload_status='pending' AND upload_expires_at < ?`).all(before)as VideoRow[]).map(mapRow);}
  listTerminal():VideoRecord[]{return(this.database.prepare(`SELECT ${columns} FROM videos WHERE status IN ('completed','failed')`).all()as VideoRow[]).map(mapRow);}

  markUploaded(id: string): VideoRecord { return this.transition(id, ["uploading"], "uploaded"); }

  markQueued(id: string, hatchetRunId: string): VideoRecord {
    const existing = this.require(id);
    if (existing.status === "uploaded" || existing.status === "queued") {
      return this.transition(id, ["uploaded", "queued"], "queued", { hatchet_run_id: hatchetRunId });
    }
    this.database.prepare("UPDATE videos SET hatchet_run_id = COALESCE(hatchet_run_id, ?) WHERE id = ?")
      .run(hatchetRunId, id);
    return this.require(id);
  }

  markProcessing(id: string): VideoRecord {
    const existing = this.require(id);
    if (existing.status === "processing" || existing.status === "completed" || existing.status === "failed") return existing;
    return this.transition(id, ["uploaded", "queued"], "processing", {
      processing_started_at: existing.processingStartedAt ?? this.now(), error_code: null, error_message: null,
    });
  }

  markCompleted(id: string, masterPlaylistPath: string): VideoRecord {
    const existing = this.require(id);
    if (existing.status === "completed") return existing;
    if (existing.status === "failed") return existing;
    return this.transition(id, ["uploaded", "queued", "processing"], "completed", {
      master_playlist_path: masterPlaylistPath,
      processing_started_at: existing.processingStartedAt ?? this.now(),
      processing_completed_at: this.now(), error_code: null, error_message: null,
    });
  }

  markObjectCompleted(id:string,masterKey:string):VideoRecord{const r=this.markCompleted(id,"");if(r.status!=="completed")return r;this.database.prepare("UPDATE videos SET master_playlist_object_key=?,master_playlist_path=NULL WHERE id=?").run(masterKey,id);return this.require(id);}

  markFailed(id: string, errorCode: string, errorMessage: string): VideoRecord {
    const existing = this.require(id);
    if (existing.status === "completed" || existing.status === "failed") return existing;
    return this.transition(id, ["uploading", "uploaded", "queued", "processing"], "failed", {
      error_code: errorCode, error_message: errorMessage, processing_completed_at: this.now(),
    });
  }

  private transition(id: string, from: VideoStatus[], to: VideoStatus, values: Record<string, SQLInputValue> = {}): VideoRecord {
    const timestamp = this.now();
    const assignments = ["status = ?", "updated_at = ?", ...Object.keys(values).map((key) => `${key} = ?`)];
    const placeholders = from.map(() => "?").join(", ");
    const result = this.database.prepare(`UPDATE videos SET ${assignments.join(", ")}
      WHERE id = ? AND status IN (${placeholders})`).run(to, timestamp, ...Object.values(values), id, ...from);
    if (result.changes === 0) {
      const existing = this.require(id);
      throw new Error(`Invalid video status transition ${existing.status} -> ${to}`);
    }
    return this.require(id);
  }
}
