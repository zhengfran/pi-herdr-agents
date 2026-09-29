import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	closeHerdrSurface,
	createHerdrSurface,
	createHerdrGroupedSurface,
	createHerdrSurfaceSplit,
	createHerdrWorktree,
	focusHerdrWorkspace,
	getHerdrPaneProcessInfo,
	waitForHerdrPiReady,
	waitForHerdrShellReady,
	isHerdrAvailable,
	isProcessAlive,
	readHerdrScreen,
	readHerdrScreenAsync,
	inspectHerdrPane,
	listHerdrPanes,
	renameHerdrTab,
	renameHerdrWorkspace,
	sendHerdrCommand,
	sendHerdrEscape,
	waitForHerdrPaneAbsence,
	waitForProcessesExit,
	type HerdrPaneProcessInfo,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";
export type { HerdrWorktreeSurface } from "./herdr.ts";

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

export function isTerminalAvailable(): boolean {
	return isHerdrAvailable();
}

export function terminalSetupHint(): string {
	return SETUP_HINT;
}

function assertTerminalAvailable(): void {
	if (!isTerminalAvailable())
		throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string, cwd?: string): PaneId {
	assertTerminalAvailable();
	return createHerdrSurface(name, cwd);
}

/** Place a child in an owned Agents tab in the target checkout's workspace. */
export function createGroupedSubagentPane(
	name: string,
	cwd: string,
	maxPerTab: number,
	direction: SplitDirection,
): PaneId {
	assertTerminalAvailable();
	return createHerdrGroupedSurface(name, cwd, maxPerTab, direction);
}

/** Create a Git worktree in its own herdr workspace and return its root surface. */
export function createSubagentWorktree(
	name: string,
	cwd: string,
	branch: string,
	base: string,
): import("./herdr.ts").HerdrWorktreeSurface {
	assertTerminalAvailable();
	return createHerdrWorktree(name, cwd, branch, base);
}

/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(
	name: string,
	direction: SplitDirection,
	cwd?: string,
): PaneId {
	assertTerminalAvailable();
	return createHerdrSurfaceSplit(name, direction, cwd);
}

export function renameCurrentTab(title: string): void {
	assertTerminalAvailable();
	renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
	assertTerminalAvailable();
	renameHerdrWorkspace(title);
}

export function focusWorkspace(workspaceId: string): void {
	assertTerminalAvailable();
	focusHerdrWorkspace(workspaceId);
}

export function runInPane(paneId: PaneId, command: string): void {
	assertTerminalAvailable();
	sendHerdrCommand(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
	assertTerminalAvailable();
	sendHerdrEscape(paneId);
}

/**
 * Stage a launch script privately. Scripts can embed task and role text, so
 * they are written 0600 (they run as `bash <path>` and need no execute bit),
 * and directories created here are 0700. Existing directories are unchanged.
 */
export function stageScript(
	command: string,
	options?: { scriptPath?: string; scriptPreamble?: string },
): string {
	const scriptPath =
		options?.scriptPath ??
		join(
			tmpdir(),
			"pi-herdr-subagent-scripts",
			`cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
		);
	mkdirSync(dirname(scriptPath), { recursive: true, mode: 0o700 });

	const scriptLines = ["#!/bin/bash"];
	if (options?.scriptPreamble)
		scriptLines.push(options.scriptPreamble.trimEnd());
	scriptLines.push(command);
	writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o600 });
	// The creation mode does not apply when an existing file is overwritten.
	chmodSync(scriptPath, 0o600);
	return scriptPath;
}

export function runScriptInPane(
	paneId: PaneId,
	command: string,
	options?: { scriptPath?: string; scriptPreamble?: string },
): string {
	const scriptPath = stageScript(command, options);
	runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
	return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
	assertTerminalAvailable();
	return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(
	paneId: PaneId,
	lines = 50,
): Promise<string> {
	assertTerminalAvailable();
	return readHerdrScreenAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function listPanes(): Promise<
	import("./herdr.ts").HerdrPaneListEntry[] | null
> {
	assertTerminalAvailable();
	return listHerdrPanes();
}

export async function inspectPane(
	paneId: PaneId,
): Promise<import("./lifecycle.ts").PaneInspection> {
	assertTerminalAvailable();
	const result = await inspectHerdrPane(paneId);
	if (result.kind === "present") {
		return { ...result, observedAt: Date.now() };
	}
	return result;
}

export function closePane(paneId: PaneId): void {
	assertTerminalAvailable();
	closeHerdrSurface(paneId);
}

export type { HerdrPaneProcessInfo };

export function getPaneProcessInfo(paneId: PaneId): HerdrPaneProcessInfo {
	assertTerminalAvailable();
	return getHerdrPaneProcessInfo(paneId);
}

export async function waitForShellReady(
	paneId: PaneId,
	options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<void> {
	assertTerminalAvailable();
	return waitForHerdrShellReady(paneId, options);
}

export async function waitForPiReady(
	paneId: PaneId,
	sessionFile: string,
	cwd: string,
): Promise<void> {
	assertTerminalAvailable();
	return waitForHerdrPiReady(paneId, sessionFile, cwd);
}

export async function waitForPaneAbsence(
	paneId: PaneId,
	options?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
	assertTerminalAvailable();
	return waitForHerdrPaneAbsence(paneId, options);
}

export { isProcessAlive, waitForProcessesExit };
