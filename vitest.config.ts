import { configDefaults, defineConfig } from "vitest/config";

// experimental/ (console, viewer + voice, their tests) is parked, not wired into dd2dash0; the root suite skips it.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "experimental/**"], setupFiles: ["tests/setup-home.ts"] },
});
