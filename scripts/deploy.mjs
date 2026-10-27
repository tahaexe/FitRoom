/**
 * `npm run deploy`: ship the Worker to Cloudflare (needs Cloudflare credentials).
 *
 * It reads everything secret from its own environment and never prints a secret:
 * - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for wrangler
 *   (passed through the environment, never on a command line);
 * - `META_API_KEY`, piped to `wrangler secret put` on standard input
 *   (never on a command line, never printed).
 *
 * Steps: build, find the `fitroom` D1 database by name (or create it),
 * write its id into the generated, git-ignored `wrangler.deploy.jsonc`
 * (no account data is committed), apply the migrations remotely, deploy
 * the Worker, set the `META_API_KEY` secret, and print the public URL.
 * The secret is set after the deploy so the first deploy on a new account
 * never prompts to create the Worker; live AI routes may briefly answer
 * "unavailable" until the secret lands, while demo mode works throughout.
 */

/* global console, process */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const DEPLOY_CONFIG = join(repoRoot, "wrangler.deploy.jsonc");
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Every wrangler call below, as command words plus the flags it passes.
 * Flag values (database name, secret name, config path) are supplied at
 * the call site; only the flag names live here. `scripts/check-worker.ts`
 * runs `<command> --help` for each entry and fails when a listed flag is
 * missing from the installed wrangler's help.
 */
export const WRANGLER_COMMANDS = [
  { key: "d1-list", command: ["d1", "list"], flags: ["--json"] },
  { key: "d1-create", command: ["d1", "create"], flags: [] },
  {
    key: "d1-migrations-apply",
    command: ["d1", "migrations", "apply"],
    flags: ["--remote", "--config"],
  },
  { key: "deploy", command: ["deploy"], flags: ["--config"] },
  { key: "secret-put", command: ["secret", "put"], flags: ["--config"] },
];

function commandEntry(key) {
  const entry = WRANGLER_COMMANDS.find((item) => item.key === key);
  if (entry === undefined) {
    fail(`unknown wrangler command: ${key}`);
    throw new Error(`unknown wrangler command: ${key}`);
  }
  return entry;
}

/**
 * Build the full wrangler argument list from one table entry.
 * Positionals go right after the command words, then each flag in table
 * order; a flag named in `flagValues` with a non-empty value passes that
 * value after the flag, otherwise the flag passes bare.
 */
function wranglerArgsFor(key, options = {}) {
  const { positionals = [], flagValues = {} } = options;
  const entry = commandEntry(key);
  const args = [...entry.command, ...positionals];
  for (const flag of entry.flags) {
    args.push(flag);
    if (Object.hasOwn(flagValues, flag)) {
      const value = flagValues[flag];
      if (value !== "" && value !== undefined && value !== null) {
        args.push(value);
      }
    }
  }
  return args;
}

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

function findFitroomId(listOutput) {
  const databases = parseJsonArray(listOutput);
  const found = (databases ?? []).find(
    (entry) => typeof entry === "object" && entry !== null && entry.name === "fitroom",
  );
  if (typeof found?.uuid === "string") return found.uuid;
  if (typeof found?.database_id === "string") return found.database_id;
  return null;
}

function parseUrl(text) {
  const match = /https:\/\/[a-zA-Z0-9._-]+\.workers\.dev[^\s]*/.exec(text);
  return match === null ? null : match[0];
}

async function listFitroomId() {
  const listed = await wrangler(wranglerArgsFor("d1-list"));
  if (listed.exit !== 0) {
    fail(`d1 list failed: ${`${listed.stdout}\n${listed.stderr}`.slice(-500).trim()}`);
  }
  return findFitroomId(listed.stdout);
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
  let databaseId = await listFitroomId();
  if (databaseId === null) {
    console.log("deploy: creating the fitroom D1 database…");
    // The installed wrangler has no `--json` option on `d1 create`
    // (it exits 1 on unknown arguments), so create bare and re-list.
    const created = await wrangler(wranglerArgsFor("d1-create", { positionals: ["fitroom"] }));
    if (created.exit !== 0) {
      fail(`d1 create failed: ${`${created.stdout}\n${created.stderr}`.slice(-500).trim()}`);
    }
    databaseId = await listFitroomId();
    if (databaseId === null) {
      fail("the fitroom D1 database is still missing after create and re-list.");
    }
    console.log("deploy: found the fitroom D1 database after creating it.");
  } else {
    console.log("deploy: found the fitroom D1 database.");
  }

  const template = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  if (!template.includes(PLACEHOLDER_ID)) {
    fail("wrangler.jsonc holds no placeholder database id.");
  }
  writeFileSync(DEPLOY_CONFIG, template.replaceAll(PLACEHOLDER_ID, databaseId), "utf8");
  console.log("deploy: wrote the generated deploy config.");

  console.log("deploy: applying D1 migrations remotely…");
  const migrated = await wrangler(
    wranglerArgsFor("d1-migrations-apply", {
      positionals: ["fitroom"],
      flagValues: { "--config": DEPLOY_CONFIG },
    }),
  );
  if (migrated.exit !== 0) {
    fail(`migrations failed: ${`${migrated.stdout}\n${migrated.stderr}`.slice(-500).trim()}`);
  }

  console.log("deploy: deploying the Worker…");
  const deployed = await wrangler(
    wranglerArgsFor("deploy", { flagValues: { "--config": DEPLOY_CONFIG } }),
  );
  if (deployed.exit !== 0) {
    fail(`deploy failed: ${`${deployed.stdout}\n${deployed.stderr}`.slice(-500).trim()}`);
  }
  const url = parseUrl(`${deployed.stdout}\n${deployed.stderr}`);

  console.log("deploy: setting the META_API_KEY secret…");
  const secreted = await wrangler(
    wranglerArgsFor("secret-put", {
      positionals: ["META_API_KEY"],
      flagValues: { "--config": DEPLOY_CONFIG },
    }),
    {
      input: metaKey.endsWith("\n") ? metaKey : `${metaKey}\n`,
    },
  );
  if (secreted.exit !== 0) {
    fail(`secret put failed: ${`${secreted.stdout}\n${secreted.stderr}`.slice(-500).trim()}`);
  }
  console.log(
    "deploy: live AI routes may briefly answer unavailable until the secret lands; demo mode works throughout.",
  );
  console.log(`deploy: done${url === null ? "" : ` — ${url}`}`);
}

// Run the deploy only when invoked as a script (`npm run deploy`), not
// when imported for the exported wrangler table (as `check:worker` does).
if ((process.argv[1] ?? "").endsWith("deploy.mjs")) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
