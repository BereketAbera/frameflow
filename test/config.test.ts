import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;

describe("configuration", () => {
  it("binds the API to loopback unless HOST is set", () => {
    expect(loadConfig(env()).host).toBe("127.0.0.1");
    expect(loadConfig(env({ HOST: "" })).host).toBe("127.0.0.1");
    expect(loadConfig(env({ HOST: "0.0.0.0" })).host).toBe("0.0.0.0");
  });
});
