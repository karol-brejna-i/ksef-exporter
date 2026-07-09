import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// `globals: false` in vite.config.ts means testing-library's own automatic
// afterEach(cleanup) registration (which relies on a global `afterEach`)
// never fires, so each test would otherwise leak its rendered DOM into the
// next one. Register it explicitly instead.
afterEach(() => {
  cleanup();
});
