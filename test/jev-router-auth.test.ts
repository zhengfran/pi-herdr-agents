import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	JEV_FALLBACK_KEY_MAX_BYTES,
	jevFallbackKeyPath,
	readJevKeyFile,
} from "../pi-extension/subagents/jev-router-auth.ts";

const dir = mkdtempSync(join(tmpdir(), "jev-router-auth-"));
let counter = 0;
function file(content: string | Buffer, mode = 0o600): string {
	const path = join(dir, `key-${counter++}`);
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
}

describe("fallback key reader", () => {
	it("uses the fixed home-relative path", () => {
		assert.match(jevFallbackKeyPath(), /\/\.jev\/JEV_KEY$/);
	});

	it("reads one line, trimming a terminal newline", async () => {
		assert.equal(await readJevKeyFile(file("abc123\n")), "abc123");
		assert.equal(await readJevKeyFile(file("abc123\r\n")), "abc123");
		assert.equal(await readJevKeyFile(file("abc123")), "abc123");
	});

	it("does not require owner-only permissions", async () => {
		assert.equal(await readJevKeyFile(file("abc123\n", 0o644)), "abc123");
	});

	for (const [label, content] of [
		["empty", ""],
		["blank line", "\n"],
		["multiline", "abc\ndef\n"],
		["interior space", "abc def"],
		["control characters", "abc\u0007def"],
		["a tab", "abc\tdef"],
		["invalid UTF-8", Buffer.from([0xff, 0xfe, 0x41])],
		["oversized", "k".repeat(JEV_FALLBACK_KEY_MAX_BYTES + 1)],
	] as const)
		it(`rejects ${label}`, async () => {
			assert.equal(await readJevKeyFile(file(content)), undefined);
		});

	it("accepts a value at the size bound", async () => {
		const value = "k".repeat(JEV_FALLBACK_KEY_MAX_BYTES);
		assert.equal(await readJevKeyFile(file(value)), value);
	});

	it("refuses a final symlink, a directory, a FIFO, and a missing file", async () => {
		const target = file("abc123\n");
		const link = join(dir, "link");
		symlinkSync(target, link);
		assert.equal(await readJevKeyFile(link), undefined);
		assert.equal(await readJevKeyFile(dir), undefined);
		const fifo = join(dir, "fifo");
		execFileSync("mkfifo", [fifo]);
		assert.equal(await readJevKeyFile(fifo), undefined);
		assert.equal(await readJevKeyFile(join(dir, "absent")), undefined);
	});
});
