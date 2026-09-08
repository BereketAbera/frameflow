import { loadConfig } from "../config.js";
import { S3ObjectStorage } from "./s3-storage.js";
export function createObjectStorage(){return new S3ObjectStorage(loadConfig().s3);}
