import { Client } from "pg";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { migrationName, validTimestamp } from "./guard.mjs";
import { schemaTypes } from "./schema-types.mjs";

const foundation = /^\d{14}_foundation_schema\.sql$/;
const shaPattern = /^[0-9a-f]{40}$/;
const prefix = "supabase/migrations/";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
}

export function safeMigration(source, name, scope) {
  const roles = source.replaceAll(':"web_role"', scope + "_web").replaceAll(':"worker_role"', scope + "_worker");
  // Strip standard literals and line comments before admitting additive statements.
  if (/\\|\/\*/.test(roles)) throw new Error("Use plain SQL with standard single-quoted literals in " + name);
  const syntax = roles.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  if (/[\\$"]|\/\*|(?:[\w"]\s*\.\s*[\w"])/.test(syntax) ||
      /\b(?:role|schema|search_path|function|procedure|trigger|extension|program|security\s+definer|truncate|drop|commit|rollback|concurrently|do|copy|foreign\s+data|set_config|dblink|lo_import|lo_export|pg_read_file|pg_write_file)\b/i.test(syntax)) {
    throw new Error("Use schema-relative additive SQL in " + name);
  }
  if (!foundation.test(name)) {
    for (const statement of syntax.split(";").map((part) => part.trim()).filter(Boolean)) {
      if (!/^(?:create\s+(?:table|(?:unique\s+)?index|policy)|alter\s+table\s+\w+\s+(?:add\s+(?:column|constraint)|enable\s+row\s+level\s+security)|grant\s+(?:select|insert|update|delete|references))\b/i.test(statement)) {
        throw new Error("Only additive DDL, RLS and grants are accepted in " + name);
      }
      if (/\b(?:public|anon|authenticated|_business_migrations|_business_releases)\b/i.test(statement)) {
        throw new Error("Restrict grants and object names to business roles and tables in " + name);
      }
      if (/\b(?:as\s+(?:select|with)|inherits|partition\s+of)\b/i.test(statement)) {
        throw new Error("Create an empty table in " + name);
      }
    }
  }
  return roles;
}


export function checkSeed(source) {
  if (source.includes("\\")) throw new Error("Use standard literals in the reviewed test seed");
  const syntax = source.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  const name = "[a-z_][a-z0-9_]*";
  const cols = `\\(\\s*${name}(?:\\s*,\\s*${name})*\\s*\\)`;
  const literal = "(?:''|true|false|null|[+-]?\\d+(?:\\.\\d+)?)";
  const row = `\\(\\s*${literal}(?:\\s*,\\s*${literal})*\\s*\\)`;
  const insert = new RegExp(`^insert\\s+into\\s+${name}\\s*${cols}\\s+values\\s*${row}(?:\\s*,\\s*${row})*\\s+on\\s+conflict(?:\\s*${cols})?\\s+do\\s+nothing$`, "i");
  const statements = syntax.split(";").map(part => part.trim()).filter(Boolean);
  if (statements.some(statement => !insert.test(statement))) {
    throw new Error("Use idempotent INSERT statements with literal values in the reviewed test seed");
  }
  return statements.length > 0;
}

export function collectBatches(releases) {
  const seen = new Map();
  let previous;
  return releases.map(({ sha, owner }, index) => {
    if (!shaPattern.test(sha) || (previous && git("rev-parse", sha + "^1").trim() !== previous)) {
      throw new Error("Use the verified first-parent release sequence");
    }
    const paths = index === 0
      ? git("ls-tree", "-rz", "--name-only", sha, "--", prefix).split("\0").filter(Boolean).map((file) => ["A", file])
      : git("diff", "--no-renames", "--name-status", "-z", previous, sha, "--", prefix)
        .split("\0").filter(Boolean).reduce((entries, token, offset) => {
          if (offset % 2 === 0) entries.push([token]);
          else entries.at(-1).push(token);
          return entries;
        }, []);
    const files = paths.map(([status, path]) => {
      const name = path.slice(prefix.length);
      const match = migrationName.exec(name);
      const mode = git("ls-tree", sha, "--", path);
      if (status !== "A" || !mode.startsWith("100644 blob ") || !match || !validTimestamp(match[1]) ||
          seen.has(match[1]) || match[2] !== owner || (index === 0 && !foundation.test(name))) {
        throw new Error("Unexpected migration file in " + sha + ": " + name);
      }
      seen.set(match[1], name);
      const source = git("show", sha + ":" + path);
      return { name, source, digest: createHash("sha256").update(source).digest("hex") };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (index === 0 && files.length !== 1) throw new Error("Expected the initial foundation migration");
    previous = sha;
    return { sha, files };
  });
}

async function assertIsolation(client, scope, schema, migrator) {
  const sibling = scope === "test" ? "prod" : "test";
  const forbiddenSchema = "business_" + sibling;
  const runtimeRoles = [scope + "_web", scope + "_worker"];
  const appRoles = [migrator, ...runtimeRoles];
  const restricted = await client.query(`
    select rolname from pg_roles where rolname = any($1) and
      (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolreplication
      or has_database_privilege(rolname, current_database(), 'CREATE')
      or has_schema_privilege(rolname, $2, 'USAGE, CREATE'))
  `, [appRoles, forbiddenSchema]);
  if (restricted.rowCount) throw new Error("Revoke database and cross-schema privileges");
  const memberships = await client.query(`
    select r.rolname from pg_roles r
    where r.rolname=any($1) and exists(
      select 1 from pg_roles other where other.oid<>r.oid and pg_has_role(r.oid, other.oid, 'MEMBER')
    )
  `, [appRoles]);
  if (memberships.rowCount) throw new Error("Remove business role memberships");
  const publicGrants = await client.query(`
    select 1 from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    where n.nspname=$1 and (a.grantee=0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated')))
    union all
    select 1 from pg_roles r where r.rolname = any($2) and has_schema_privilege(r.rolname, $1, 'CREATE')
  `, [schema, runtimeRoles]);
  if (publicGrants.rowCount) throw new Error("Revoke public or runtime CREATE schema privileges");
}

async function assertTables(client, schema, scope) {
  const { rows } = await client.query(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=$1 and c.relkind in ('r','p')
      and c.relname not in ('_business_migrations','_business_releases')
      and (not c.relrowsecurity
        or pg_get_userbyid(c.relowner) = any($2)
        or not exists (select 1 from pg_policy p where p.polrelid=c.oid)
        or exists(select 1 from pg_policy p where p.polrelid=c.oid and (
          0=any(p.polroles) or p.polroles && array(select oid from pg_roles where rolname in ('anon','authenticated'))
          or (p.polqual is null and p.polwithcheck is null)
          or btrim(lower(coalesce(pg_get_expr(p.polqual,c.oid), '')), '() ') = 'true'
          or btrim(lower(coalesce(pg_get_expr(p.polwithcheck,c.oid), '')), '() ') = 'true'
        ))
        or exists(select 1 from aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a
          where a.grantee=0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated'))))
  `, [schema, [scope + "_web", scope + "_worker"]]);
  if (rows.length) throw new Error("Fix RLS, explicit policies and role grants on " + rows.map((row) => row.relname).join(", "));
}

function connect(target, scope) {
  const expected = scope + "_migrator";
  if (target === "local") {
    const url = new URL(process.env.LOCAL_DATABASE_URL ?? "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Local rehearsal requires a loopback database");
    return new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  }
  const url = new URL(process.env.SCHEMA_DATABASE_URL ?? "");
  const project = process.env.SUPABASE_PROJECT_REF;
  const host = process.env.EXPECTED_DATABASE_HOST;
  if (!project || !/^[a-z0-9]+$/.test(project) || host !== url.hostname || !host.endsWith(".pooler.supabase.com") ||
      url.username !== expected + "." + project || url.port !== "5432" || url.pathname !== "/postgres" ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Check the configured project, host, role and session pool");
  url.search = "";
  return new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 5000 });
}

export async function migrate({ target, batches, expected, output, seed, expectedDir, snapshots }) {
  if (!["local", "test", "production"].includes(target) || !batches.length) throw new Error("Select a fixed migration target and verified SHA list");
  const scope = target === "production" ? "prod" : "test";
  const schema = "business_" + scope;
  const role = scope + "_migrator";
  const client = connect(target, scope);
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '20s'; set local statement_timeout = '120s'");
    if (target === "local") await client.query("set local role test_migrator");
    await client.query("set local search_path to " + schema + ", pg_catalog");
    const identity = (await client.query("select current_user as role, current_schema() as schema")).rows[0];
    if (identity.role !== role || identity.schema !== schema) throw new Error("Check effective schema and migration role");
    await assertIsolation(client, scope, schema, role);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["business-migrate:" + schema]);
    await client.query(`
      create table if not exists _business_migrations(name text primary key, digest text not null, release_sha text not null);
      create table if not exists _business_releases(position integer primary key, sha text not null unique, types text not null);
      alter table _business_migrations enable row level security;
      alter table _business_releases enable row level security;
      revoke all on _business_migrations, _business_releases from public;
    `);
    const ledger = new Map((await client.query("select name, digest from _business_migrations")).rows.map((row) => [row.name, row.digest]));
    const releases = (await client.query("select sha, types from _business_releases order by position")).rows;
    const evidence = new Map();
    // The manual bootstrap recorded the reviewed PR head before the baseline merge exists.
    const bootstrap = batches[0].sha;
    if (target === "test" && batches[0].reviewedSha && !releases.length) {
      throw new Error("The maintainer must bootstrap the test schema from the reviewed PR first");
    }
    if (releases.length && releases[0].sha !== bootstrap) {
      const original = releases[0];
      const unchangedBootstrap = target === "test" && batches[0].reviewedBootstrap === true &&
        batches.length === 1 && releases.length === 1 && shaPattern.test(original.sha) && original.types === expected &&
        ledger.size === batches[0].files.length && batches[0].files.every((file) => ledger.get(file.name) === file.digest);
      if (unchangedBootstrap) {
        // A reviewed descendant may replace the PR-head marker before the first integration merge.
        git("merge-base", "--is-ancestor", original.sha, bootstrap);
      } else if (!batches[0].reviewedSha || original.sha !== batches[0].reviewedSha) {
        throw new Error("Bootstrap SHA and baseline disagree");
      }
      await client.query("update _business_releases set sha = $1 where position = 0", [bootstrap]);
      original.sha = bootstrap;
    }
    if (releases.length > batches.length) throw new Error("Requested target precedes the migration ledger");
    for (const [index, batch] of batches.entries()) {
      if (releases[index] && releases[index].sha !== batch.sha) throw new Error("Release ledger differs from the verified first-parent history");
      for (const file of batch.files) {
        if (ledger.has(file.name) && ledger.get(file.name) !== file.digest) throw new Error("Restore the applied migration checksum: " + file.name);
        if (!ledger.has(file.name)) {
          try {
            await client.query(safeMigration(file.source, file.name, scope));
            await client.query("insert into _business_migrations(name,digest,release_sha) values($1,$2,$3)", [file.name, file.digest, batch.sha]);
          } catch (error) {
            throw new Error("Migration failed: " + batch.sha + " " + file.name + " SQLSTATE " + (error.code ?? "validation"));
          }
        }
        ledger.delete(file.name);
      }
      const types = releases[index]?.types ?? await schemaTypes(client, schema);
      if (expectedDir && readFileSync(expectedDir + "/" + batch.sha + ".ts", "utf8") !== types) {
        throw new Error("Database types differ from the trusted rehearsal for " + batch.sha);
      }
      if (batch.frozenTypes !== undefined && batch.frozenTypes !== types) {
        throw new Error("Type synchronization does not match the reviewed schema for " + batch.sha);
      }
      if (!releases[index]) {
        await assertTables(client, schema, scope);
        await client.query("insert into _business_releases(position,sha,types) values($1,$2,$3)", [index, batch.sha, types]);
      }
      evidence.set(batch.sha, types);
    }
    if (ledger.size) throw new Error("Verified migration list omitted applied files");
    if (seed && scope === "test") {
      if (checkSeed(seed)) await client.query(seed);
    }
    await assertTables(client, schema, scope);
    const types = await schemaTypes(client, schema);
    if (types !== evidence.get(batches.at(-1).sha)) throw new Error("Current schema differs from the release ledger");
    if (expected !== undefined && types !== expected) throw new Error("Database types differ from the reviewed expected types");
    await client.query("commit");
    if (snapshots) {
      mkdirSync(snapshots, { recursive: true });
      for (const [sha, file] of evidence) writeFileSync(snapshots + "/" + sha + ".ts", file);
    }
    if (output) {
      writeFileSync(output, types);
      writeFileSync(output + ".manifest.json", JSON.stringify(batches.map(({ sha, files }) => ({
        sha, files: files.map(({ name, digest }) => ({ name, sha256: digest })),
      })), null, 2) + "\n");
    }
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [target, releasePath, output, expectation, snapshots] = process.argv.slice(2);
    const releases = JSON.parse(readFileSync(releasePath, "utf8"));
    const batches = collectBatches(releases);
    batches[0].reviewedSha = releases[0].reviewedSha;
    batches[0].reviewedBootstrap = releases[0].reviewedBootstrap;
    const head = batches.at(-1).sha;
    const expected = expectation === "committed" || target === "production" ? git("show", head + ":src/lib/database.types.ts") :
      expectation && !expectation.startsWith("dir:") ? readFileSync(expectation, "utf8") : undefined;
    const expectedDir = expectation?.startsWith("dir:") ? expectation.slice(4) : undefined;
    for (const [index, release] of releases.entries()) {
      if (release.typeSync) batches[index].frozenTypes = git("show", release.sha + ":src/lib/database.types.ts");
    }
    const seed = target === "production" ? undefined : git("show", batches[0].sha + ":supabase/seed.sql");
    await migrate({ target, batches, expected, output, seed, expectedDir, snapshots });
  } catch (error) {
    console.error(error.code ? "Migration database rejected the request. SQLSTATE " + error.code : error.message);
    process.exitCode = 1;
  }
}
