import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;

describe("configuration", () => {
  it("binds the API to loopback unless HOST is set", () => {
    expect(loadConfig(env()).host).toBe("127.0.0.1");
    expect(loadConfig(env({ HOST: "" })).host).toBe("127.0.0.1");
    expect(loadConfig(env({ HOST: "0.0.0.0" })).host).toBe("0.0.0.0");
  });

  it("defaults S3_ENDPOINT only when it is absent", () => {
    expect(loadConfig(env()).s3.endpoint).toBe("http://127.0.0.1:9000");
    expect(loadConfig(env({ S3_ENDPOINT: "http://frameflow-minio:9000" })).s3.endpoint).toBe("http://frameflow-minio:9000");
    expect(loadConfig(env({ S3_ENDPOINT: "" })).s3.endpoint).toBeUndefined();
  });

  it("accepts S3_PUBLIC_ENDPOINT only as a bare origin", () => {
    expect(loadConfig(env()).s3.publicEndpoint).toBeUndefined();
    expect(loadConfig(env({ S3_PUBLIC_ENDPOINT: "https://frameflow.bereket.dev/" })).s3.publicEndpoint).toBe("https://frameflow.bereket.dev");
    expect(() => loadConfig(env({ S3_PUBLIC_ENDPOINT: "https://frameflow.bereket.dev/storage" }))).toThrow(/without a path/);
    expect(() => loadConfig(env({ S3_PUBLIC_ENDPOINT: "frameflow.bereket.dev" }))).toThrow(/S3_PUBLIC_ENDPOINT/);
  });
});
