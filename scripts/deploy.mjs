/**
 * `npm run deploy` — ship the FitRoom Worker to Cloudflare (part B).
 *
 * Not run in this part. It reads everything secret from its own
 * environment and never prints a secret:
 * - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for wrangler
 *   (passed through the environment, never on a command line);
 * - `META_API_KEY`, piped to `wrangler secret put` on standard input
 *   (never on a command line, never printed).
 *
 * Steps: build, find the `fitroom` D1 database by name (or create it),
 * write its id into the generated, git-ignored `wrangler.deploy.jsonc`
 * (no account data is committed), apply the migrations remotely, set the
 * `META_API_KEY` secret, deploy, and print the public URL.
 */

/* global console, process */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const DEPLOY_CONFIG = join(repoRoot, "wrangler.deploy.jsonc");
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") {
    fail(`needs ${name} in the environment.`);
  }
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: command === "npm.cmd",
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.once("error", () => resolvePromise({ exit: null, stdout, stderr }));
    child.once("exit", (code) => resolvePromise({ exit: code, stdout, stderr }));
    if (typeof options.input === "string") {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function wrangler(args, options = {}) {
  const res = await run("node", [join("node_modules", "wrangler", "bin", "wrangler.js"), ...args], {
    ...options,
    env: process.env,
  });
  return res;
}

function parseJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseUuid(text) {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
  return match === null ? null : match[0];
}

function parseUrl(text) {
  const match = /https:\/\/[a-zA-Z0-9._-]+\.workers\.dev[^\s]*/.exec(text);
  return match === null ? null : match[0];
}

async function main() {
  // Secrets travel in memory and on stdin only; nothing below prints them.
  const metaKey = requiredEnv("META_API_KEY");
  requiredEnv("CLOUDFLARE_API_TOKEN");
  requiredEnv("CLOUDFLARE_ACCOUNT_ID");

  console.log("deploy: building shared, server and client…");
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const built = await run(npmBin, ["run", "build"], { env: process.env });
  if (built.exit !== 0) {
    fail(`build failed: ${built.stderr.slice(-500).trim()}`);
  }
  if (!existsSync(join(repoRoot, "client", "dist", "index.html"))) {
    fail("client/dist is missing after the build.");
  }

  console.log("deploy: finding the fitroom D1 database…");
  let databaseId;
  const listed = await wrangler(["d1", "list", "--json"]);
  if (listed.exit !== 0) {
    fail(`d1 list failed: ${`${listed.stdout}\n${listed.stderr}`.slice(-500).trim()}`);
  }
  const databases = parseJsonArray(listed.stdout);
  const found = (databases ?? []).find(
    (entry) => typeof entry === "object" && entry !== null && entry.name === "fitroom",
  );
  const foundId =
    typeof found?.uuid === "string"
      ? found.uuid
      : typeof found?.database_id === "string"
        ? found.database_id
        : null;
  if (foundId !== null) {
    databaseId = foundId;
    console.log("deploy: found the fitroom D1 database.");
  } else {
    console.log("deploy: creating the fitroom D1 database…");
    const created = await wrangler(["d1", "create", "fitroom", "--json"]);
    if (created.exit !== 0) {
      fail(`d1 create failed: ${`${created.stdout}\n${created.stderr}`.slice(-500).trim()}`);
    }
    const createdList = parseJsonArray(created.stdout);
    const createdId =
      createdList !== null && typeof createdList[0]?.uuid === "string"
        ? createdList[0].uuid
        : parseUuid(created.stdout);
    if (createdId === null) {
      fail("d1 create answered without a database id.");
    }
    databaseId = createdId;
  }

  const template = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  if (!template.includes(PLACEHOLDER_ID)) {
    fail("wrangler.jsonc holds no placeholder database id.");
  }
  writeFileSync(DEPLOY_CONFIG, template.replaceAll(PLACEHOLDER_ID, databaseId), "utf8");
  console.log("deploy: wrote the generated deploy config.");

  console.log("deploy: applying D1 migrations remotely…");
  const migrated = await wrangler([
    "d1",
    "migrations",
    "apply",
    "fitroom",
    "--remote",
    "--config",
    DEPLOY_CONFIG,
  ]);
  if (migrated.exit !== 0) {
    fail(`migrations failed: ${`${migrated.stdout}\n${migrated.stderr}`.slice(-500).trim()}`);
  }

  console.log("deploy: setting the META_API_KEY secret…");
  const secreted = await wrangler(["secret", "put", "META_API_KEY", "--config", DEPLOY_CONFIG], {
    input: metaKey.endsWith("\n") ? metaKey : `${metaKey}\n`,
  });
  if (secreted.exit !== 0) {
    fail(`secret put failed: ${`${secreted.stdout}\n${secreted.stderr}`.slice(-500).trim()}`);
  }

  console.log("deploy: deploying the Worker…");
  const deployed = await wrangler(["deploy", "--config", DEPLOY_CONFIG]);
  if (deployed.exit !== 0) {
    fail(`deploy failed: ${`${deployed.stdout}\n${deployed.stderr}`.slice(-500).trim()}`);
  }
  const url = parseUrl(`${deployed.stdout}\n${deployed.stderr}`);
  console.log(`deploy: done${url === null ? "" : ` — ${url}`}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
