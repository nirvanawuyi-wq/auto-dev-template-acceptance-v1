import { readFileSync, writeFileSync } from "node:fs";

const [input, schema, output] = process.argv.slice(2);
if (!["business_test", "business_prod"].includes(schema)) throw new Error("Select a fixed business schema");
const source = readFileSync(input, "utf8").replaceAll("\r\n", "\n");
if (!source.includes("export type Database") || !new RegExp("\\b" + schema + ": \\{").test(source)) {
  throw new Error("Supabase CLI did not return TypeScript for the requested schema");
}
writeFileSync(output, source.replaceAll(new RegExp("\\b" + schema + "\\b", "g"), "business"));
