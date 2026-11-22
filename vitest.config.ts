import { configDefaults, defineConfig } from "vitest/config";

// edge/ is its own package, with its own dependencies and its own test run in the Workers runtime: npm test in edge/.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "edge/**"] } });
