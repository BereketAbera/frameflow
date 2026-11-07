import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimitStrategy, type Concurrency } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { mapConcurrencyPb, resolveExecutionTimeout, resolveScheduleTimeout } from "@hatchet-dev/typescript-sdk/v1/client/worker/worker-internal.js";

// A client built from an unsigned token carrying only the claims the SDK parses; declaring workflows never contacts an engine.
vi.mock("../src/hatchet-client.js", async () => {
  const { HatchetClient } = await import("@hatchet-dev/typescript-sdk/v1/index.js");
  const claims = Buffer.from(JSON.stringify({ sub: "test-tenant", server_url: "http://127.0.0.1:9", grpc_broadcast_address: "127.0.0.1:9" })).toString("base64url");
  return { hatchet: HatchetClient.init({ token: `e30.${claims}.unsigned`, host_port: "127.0.0.1:9", api_url: "http://127.0.0.1:9", tls_config: { tls_strategy: "none" } }) };
});

async function phase3(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { objectVideoWorkflow } = await import("../src/workflows/object-video-processing.js");
  const { definition } = objectVideoWorkflow;
  // The same resolvers the SDK uses when it registers the workflow with the engine.
  const timeouts = Object.fromEntries(definition._tasks.map((task) => [task.name, [resolveExecutionTimeout(task, definition.taskDefaults), resolveScheduleTimeout(task, definition.taskDefaults)]]));
  const onFailure = definition.onFailure as { executionTimeout?: string; scheduleTimeout?: string };
  return { definition, timeouts: { ...timeouts, fail: [onFailure.executionTimeout, onFailure.scheduleTimeout] } };
}

describe("phase-3 workflow options", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("declares workflows on the offline test client", async () => {
    expect((await import("../src/hatchet-client.js")).hatchet.tenantId).toBe("test-tenant");
  });

  it("gives every task an explicit execution timeout and a generous schedule timeout", async () => {
    const { timeouts } = await phase3();
    expect(timeouts).toEqual({
      "validate-object": ["2m", "12h"], "probe-object": ["15m", "12h"], "encode-360p": ["30m", "12h"], "encode-720p": ["30m", "12h"],
      publish: ["15m", "12h"], complete: ["2m", "12h"], fail: ["2m", "12h"],
    });
    expect(Object.values((await phase3({ FRAMEFLOW_SCHEDULE_TIMEOUT: "1h30m" })).timeouts).every(([, schedule]) => schedule === "1h30m")).toBe(true);
  });

  it("registers no concurrency limit unless FRAMEFLOW_MAX_CONCURRENT_VIDEOS is set", async () => {
    expect((await phase3()).definition.concurrency).toBeUndefined();
  });

  it("queues videos beyond FRAMEFLOW_MAX_CONCURRENT_VIDEOS instead of cancelling them", async () => {
    const { definition } = await phase3({ FRAMEFLOW_MAX_CONCURRENT_VIDEOS: "1" });
    expect(ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN).toBe(3);
    expect(definition.concurrency).toEqual([{ expression: "'frameflow'", maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN }]);
    // The SDK registers an array as the workflow's concurrencyArr (a single object would use the deprecated concurrency field).
    expect(mapConcurrencyPb(definition.concurrency as Concurrency[])).toEqual([{ expression: "'frameflow'", maxRuns: 1, limitStrategy: 3 }]);
  });
});
