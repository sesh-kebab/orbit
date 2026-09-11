/**
 * Runs every verification suite.
 *
 *   npm run verify
 *
 * The suites are discovered from `scripts/verify-*.ts` rather than listed, so a
 * new one is picked up without anyone remembering to add it here. The reverse
 * mistake is caught too: a suite with no matching `verify:<name>` entry in
 * package.json fails this run rather than being quietly skipped, which is the
 * only failure mode discovery introduces.
 *
 * This exists because for weeks the suites were only ever run by hand. CI
 * typechecked and built, which is exactly the part a compiler already tells you
 * about, and the several hundred behavioural checks ran only when a nightly
 * agent happened to remember them.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const suites = readdirSync(join(root, "scripts"))
    .filter((file) => file.startsWith("verify-") && file.endsWith(".ts"))
    .map((file) => file.slice("verify-".length, -".ts".length))
    .sort();

if (suites.length === 0) {
    console.error("No scripts/verify-*.ts found. That is almost certainly wrong.");
    process.exit(1);
}

const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
const unregistered = suites.filter((name) => !scripts[`verify:${name}`]);
if (unregistered.length > 0) {
    console.error(`No package.json script for: ${unregistered.map((n) => `verify:${n}`).join(", ")}`);
    process.exit(1);
}

const failed = [];
for (const name of suites) {
    process.stdout.write(`\n── verify:${name} ${"─".repeat(Math.max(0, 50 - name.length))}\n`);
    const run = spawnSync("npm", ["run", "--silent", `verify:${name}`], { stdio: "inherit", shell: false });
    if (run.status !== 0) failed.push(name);
}

if (failed.length > 0) {
    console.error(`\n${failed.length} suite(s) failed: ${failed.join(", ")}\n`);
    process.exit(1);
}

console.log(`\nAll ${suites.length} suites passed: ${suites.join(", ")}.\n`);
