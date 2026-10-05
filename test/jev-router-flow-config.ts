/**
 * Durable configuration for the advisory-to-launch flow tests. Import after
 * `./isolated-agent-dir.ts` and before the extension: routes and the
 * `jevRouter` section are read while the extension module evaluates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENABLED_RAW } from "./jev-router-fixtures.ts";

export const FLOW_ROUTES = {
	alpha: {
		description: "Implement a bounded code change",
		candidates: [
			{
				agent: "jf-missing",
				harness: "pi",
				model: "fake/pi-a",
				thinking: "high",
			},
			{ agent: "jf-pi", harness: "pi", model: "fake/pi-b", thinking: "high" },
			{ agent: "jf-pi", harness: "pi", model: "fake/pi-a", thinking: "high" },
		],
	},
	guarded: {
		description: "Independent review of a finished change",
		candidates: [
			{
				agent: "jf-guarded",
				harness: "pi",
				model: "fake/pi-a",
				thinking: "high",
			},
		],
	},
	native: {
		description: "Implement a change in an alternate runtime",
		candidates: [
			{
				agent: "jf-claude",
				harness: "claude",
				model: "sonnet",
				thinking: "high",
			},
		],
	},
	dead: {
		description: "A route none of whose candidates can launch",
		candidates: [
			{
				agent: "jf-missing",
				harness: "pi",
				model: "fake/pi-a",
				thinking: "high",
			},
		],
	},
} as const;

const agentDir = process.env.PI_CODING_AGENT_DIR!;
mkdirSync(join(agentDir, "herdr-agents"), { recursive: true });
writeFileSync(
	join(agentDir, "herdr-agents", "config.json"),
	JSON.stringify({
		routes: FLOW_ROUTES,
		routePolicy: { requiredForAgents: { "jf-guarded": ["guarded"] } },
		jevRouter: ENABLED_RAW,
	}),
);
