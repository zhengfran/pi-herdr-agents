/** Shared internal duplicate-member guard; no config/model imports or writes. */
export const AUTO_ROUTING_CONFIG_KEY = "autoRouting";

function memberPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$-]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

/**
 * `JSON.parse` silently keeps the last duplicate member. Report the first
 * duplicate inside the top-level `autoRouting` subtree, including a repeated
 * `autoRouting` itself, so a reviewer never approves a shadowed value.
 * The text must already have been accepted by `JSON.parse`. Unrelated top-level
 * values are skipped without tracking members, and `autoRouting` is scanned
 * with an explicit stack, so nesting depth never exhausts the call stack.
 * Unexpected structure throws; callers must fail closed before any rewrite.
 */
export function findDuplicateAutoRoutingMember(
	text: string,
): string | undefined {
	const whitespace = " \t\n\r";
	let index = 0;
	const unexpected = (): never => {
		throw new Error(`unexpected JSON structure at offset ${index}`);
	};
	const skip = () => {
		while (index < text.length && whitespace.includes(text[index])) index++;
	};
	const expect = (char: string) => {
		skip();
		if (text[index] !== char) unexpected();
		index++;
	};
	/** Advance past one string and return its start offset. */
	const skipString = (): number => {
		skip();
		const start = index;
		if (text[index++] !== '"') unexpected();
		for (;;) {
			if (index >= text.length) unexpected();
			const char = text[index++];
			if (char === '"') return start;
			if (char === "\\") index++;
		}
	};
	const readString = (): string => {
		const start = skipString();
		return JSON.parse(text.slice(start, index));
	};
	const skipScalar = () => {
		skip();
		if (text[index] === '"') {
			skipString();
			return;
		}
		const start = index;
		while (index < text.length && !`,:[]{}"${whitespace}`.includes(text[index]))
			index++;
		if (index === start) unexpected();
	};
	/** Skip one value, counting only bracket depth. */
	const skipValue = () => {
		skip();
		if (text[index] !== "{" && text[index] !== "[") return skipScalar();
		let depth = 0;
		do {
			if (index >= text.length) unexpected();
			const char = text[index];
			if (char === '"') {
				skipString();
				continue;
			}
			if (char === "{" || char === "[") depth++;
			else if (char === "}" || char === "]") depth--;
			index++;
		} while (depth > 0);
	};
	/** First duplicate member path inside one value, or undefined. */
	const findDuplicateIn = (root: string): string | undefined => {
		// Member keys seen so far for an object, or the current array index.
		const containers: Array<Set<string> | number> = [];
		// Path segment of the member being scanned in each open container.
		const segments: string[] = [];
		const enterMember = (): string | undefined => {
			const container = containers[containers.length - 1];
			if (!(container instanceof Set)) {
				segments.push(`[${container}]`);
				return undefined;
			}
			const key = readString();
			const segment = memberPath("", key);
			if (container.has(key)) return `${root}${segments.join("")}${segment}`;
			container.add(key);
			expect(":");
			segments.push(segment);
			return undefined;
		};
		for (;;) {
			skip();
			const open = text[index];
			if (open === "{" || open === "[") {
				index++;
				skip();
				if (text[index] === (open === "{" ? "}" : "]")) index++;
				else {
					containers.push(open === "{" ? new Set<string>() : 0);
					const duplicate = enterMember();
					if (duplicate !== undefined) return duplicate;
					continue;
				}
			} else skipScalar();
			// The value is complete: open the next member or close containers.
			for (;;) {
				if (containers.length === 0) return undefined;
				segments.pop();
				skip();
				const container = containers[containers.length - 1];
				const next = text[index++];
				if (next === ",") {
					if (!(container instanceof Set))
						containers[containers.length - 1] = container + 1;
					const duplicate = enterMember();
					if (duplicate !== undefined) return duplicate;
					break;
				}
				if (next !== (container instanceof Set ? "}" : "]")) unexpected();
				containers.pop();
			}
		}
	};
	skip();
	// Non-object roots are reported by the schema parser.
	if (text[index] !== "{") return undefined;
	index++;
	skip();
	if (text[index] === "}") return undefined;
	let seen = false;
	for (;;) {
		const key = readString();
		expect(":");
		if (key !== AUTO_ROUTING_CONFIG_KEY) skipValue();
		else if (seen) return AUTO_ROUTING_CONFIG_KEY;
		else {
			seen = true;
			const duplicate = findDuplicateIn(AUTO_ROUTING_CONFIG_KEY);
			if (duplicate !== undefined) return duplicate;
		}
		skip();
		const next = text[index++];
		if (next === "}") return undefined;
		if (next !== ",") unexpected();
	}
}
