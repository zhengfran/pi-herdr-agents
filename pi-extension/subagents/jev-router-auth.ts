/**
 * Request-local credential fallback for the advisory router.
 *
 * Pi's own configured authentication always wins and is never touched. Only
 * when the host reports none does the router read the fixed `~/.jev/JEV_KEY`
 * file once per invocation and hand the value to the classifier as a
 * request-local `apiKey`. The value is never cached, logged, written to the
 * environment or Pi's credential store, or included in any result, and a read
 * problem reports only "no credential" with no filesystem detail.
 *
 * The reader opens the final path component without following a symlink and
 * without blocking on a FIFO, then requires a regular file of bounded size
 * holding one line without whitespace or control characters. Owner-only
 * permissions are recommended in the documentation but neither required nor
 * changed here. Descriptors are closed on every path; JavaScript memory is not
 * claimed to be zeroized.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const JEV_FALLBACK_KEY_MAX_BYTES = 4 * 1024;

/** The one fixed location; there is no configuration or tool input for it. */
export const jevFallbackKeyPath = () => join(homedir(), ".jev", "JEV_KEY");

/** Resolves the request-local key, or undefined when none is usable. */
export type JevKeySource = () => Promise<string | undefined>;

/** Read and validate one key file; every failure is `undefined`. */
export async function readJevKeyFile(
	path: string,
): Promise<string | undefined> {
	const noFollow = constants.O_NOFOLLOW;
	const nonBlock = constants.O_NONBLOCK;
	// Without these a symlink or FIFO could not be refused safely.
	if (noFollow === undefined || nonBlock === undefined) return undefined;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size > JEV_FALLBACK_KEY_MAX_BYTES)
			return undefined;
		const buffer = Buffer.alloc(JEV_FALLBACK_KEY_MAX_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead === 0 || bytesRead > JEV_FALLBACK_KEY_MAX_BYTES)
			return undefined;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			buffer.subarray(0, bytesRead),
		);
		buffer.fill(0);
		const value = text.replace(/\r?\n$/u, "");
		if (value === "" || /[\p{Cc}\s]/u.test(value)) return undefined;
		return value;
	} catch {
		return undefined;
	} finally {
		try {
			await handle?.close();
		} catch {
			// A descriptor that cannot be closed is released with the process.
		}
	}
}

export const readFallbackJevKey: JevKeySource = () =>
	readJevKeyFile(jevFallbackKeyPath());
