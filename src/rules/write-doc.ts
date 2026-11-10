// Writes docs/rules.md from the catalog:  npx tsx src/rules/write-doc.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./render.js";

const target = fileURLToPath(new URL("../../docs/rules.md", import.meta.url));
writeFileSync(target, renderMarkdown());
console.log(`wrote ${target}`);
