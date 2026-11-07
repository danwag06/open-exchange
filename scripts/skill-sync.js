#!/usr/bin/env node
// skills/open-exchange, as committed: the generated blocks of the agent skill rewritten from this
// repo's sources, and (--check) the skill and the API docs as scripts/www.sh copies them into the pages.
//   skills/open-exchange/references/api.md  <!-- generated: routes -->   ← api/openapi.json (every operation, by tag)
//   skills/open-exchange/SKILL.md           <!-- generated: versions --> ← package.json (open-exchange, its engine,
//                                                                          the matching client)
// Only the text between a block's markers is rewritten; the prose around it is hand-written. The canonical
// editable skill is b-open-io/1sat-sdk skills/open-exchange; it refreshes from a host's /api/skill.md.
//   node scripts/skill-sync.js            rewrite the blocks (scripts/www.sh runs it before copying)
//   node scripts/skill-sync.js --check    exit 1, naming each file, when a committed file differs from what this
//                                         would write, or when apps/swap/www/api/ differs from its sources
//                                         (run by `npm run prepack`, so `npm pack` / `npm publish` fail on a stale skill)
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OX = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(OX, "skills/open-exchange");
const PAGES = join(OX, "apps/swap/www/api");
const check = process.argv.includes("--check");

const read = (p) => readFileSync(p, "utf8");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function routes(spec) {
  const order = (spec.tags ?? []).map((t) => t.name);
  const rows = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object" || !op.responses) continue;
      const tags = op.tags ?? [];
      const rank = order.indexOf(tags[0]);
      const query = (op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name + (p.required ? "*" : ""));
      rows.push({ rank: rank < 0 ? order.length : rank, n: rows.length, line:
        `| ${tags.join(", ")} | ${method.toUpperCase()} | \`${path}\` | ${query.join(", ")} | ${cell(op["x-cache"])} | ${cell(op.summary)} |` });
    }
  rows.sort((a, b) => a.rank - b.rank || a.n - b.n); // grouped by first tag in the document's tag order, else as written
  return [
    `### ${rows.length} routes, ${order.length} tags (OpenAPI document version ${spec.info.version})`,
    "",
    "| tag | method | path | query (`*` required) | cache | summary |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => r.line),
  ].join("\n");
}

function versions(pkg) {
  const engine = pkg.dependencies?.["@dcasegr/amm-engine"];
  if (!engine) throw new Error("package.json: no @dcasegr/amm-engine dependency");
  // The client is not a dependency of this package. By the repo's convention @dcasegr/amm-client and
  // @dcasegr/amm-engine are released together from skein-amm and pinned to the same version, so the
  // client that matches this host is the engine's version.
  return [
    "| package | version |",
    "|---|---|",
    `| \`open-exchange\` | ${pkg.version} (this host) |`,
    `| \`@dcasegr/amm-engine\` | ${engine} (the host's dependency) |`,
    `| \`@dcasegr/amm-client\` | ${engine} (pin to the same version as the engine) |`,
  ].join("\n");
}

function fill(file, name, body) {
  const text = read(file);
  const open = `<!-- generated: ${name} -->`, close = "<!-- /generated -->";
  const a = text.indexOf(open);
  const b = a < 0 ? -1 : text.indexOf(close, a);
  if (a < 0 || b < 0) throw new Error(`${relative(OX, file)}: no ${open} … ${close} block`);
  return text.slice(0, a + open.length) + "\n" + body + "\n" + text.slice(b);
}

const files = (dir) => readdirSync(dir).flatMap((n) => statSync(join(dir, n)).isDirectory() ? files(join(dir, n)).map((m) => join(n, m)) : [n]).sort();

// What scripts/www.sh's api step copies, page path → source (keep the two in step).
function served() {
  const m = new Map();
  for (const n of ["openapi.json", "index.html", "llms.txt"]) m.set(n, join(OX, "api", n));
  m.set("skill.md", join(SKILL, "SKILL.md"));
  for (const d of ["references", "examples"]) for (const n of files(join(SKILL, d))) m.set(join("skill", d, n), join(SKILL, d, n));
  return m;
}

const spec = JSON.parse(read(join(OX, "api/openapi.json")));
const pkg = JSON.parse(read(join(OX, "package.json")));
const want = new Map([
  [join(SKILL, "references/api.md"), fill(join(SKILL, "references/api.md"), "routes", routes(spec))],
  [join(SKILL, "SKILL.md"), fill(join(SKILL, "SKILL.md"), "versions", versions(pkg))],
]);

if (!check) {
  for (const [p, text] of want) if (read(p) !== text) { writeFileSync(p, text); console.log(`skill-sync: wrote ${relative(OX, p)}`); }
  process.exit(0);
}

const stale = [];
for (const [p, text] of want) if (read(p) !== text) stale.push(`${relative(OX, p)}: its generated block differs from api/openapi.json / package.json`);
if (stale.length === 0) { // the pages are compared with the sources once those are current
  const m = served();
  for (const [page, src] of m) {
    const p = join(PAGES, page);
    if (!existsSync(p)) stale.push(`apps/swap/www/api/${page}: missing (source ${relative(OX, src)})`);
    else if (!readFileSync(p).equals(readFileSync(src))) stale.push(`apps/swap/www/api/${page}: differs from ${relative(OX, src)}`);
  }
  for (const page of existsSync(PAGES) ? files(PAGES) : []) if (!m.has(page)) stale.push(`apps/swap/www/api/${page}: no source (removed?)`);
}
if (stale.length) {
  console.error(`skill-sync --check: the agent skill or the API pages are stale:\n  ${stale.join("\n  ")}\n` +
    "Run `node scripts/skill-sync.js` (the generated blocks) and `scripts/www.sh api` (the copy into apps/swap/www/api/), then commit.");
  process.exit(1);
}
console.log(`skill-sync --check: skills/open-exchange and apps/swap/www/api/ are current (open-exchange ${pkg.version}, engine ${pkg.dependencies["@dcasegr/amm-engine"]}, ${Object.keys(spec.paths).length} paths)`);
