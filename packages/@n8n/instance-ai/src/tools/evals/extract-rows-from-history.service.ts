import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { InstanceAiContext, NodeOutputResult } from '../../types';
import { isRecord } from './column-ref-utils';

const SCAN_LIMIT = 100;
const MAX_ROWS = 25;

export interface ExtractRowsInput {
	workflow: WorkflowJSON;
	workflowId: string;
	agentNodeName: string;
	inputColumns: string[];
}

export interface ExtractRowsResult {
	rows: Array<Record<string, string>>;
	scannedExecutions: number;
}

function findParentNode(workflow: WorkflowJSON, targetNodeName: string): string | undefined {
	const connections = workflow.connections ?? {};
	for (const [sourceName, byType] of Object.entries(connections)) {
		if (!isRecord(byType)) continue;
		const main = byType.main;
		if (!Array.isArray(main)) continue;
		for (const slot of main) {
			if (!Array.isArray(slot)) continue;
			for (const conn of slot) {
				if (isRecord(conn) && conn.node === targetNodeName) {
					return sourceName;
				}
			}
		}
	}
	return undefined;
}

function projectRow(json: unknown, columns: string[]): Record<string, string> | undefined {
	if (!isRecord(json)) return undefined;
	const row: Record<string, string> = {};
	for (const col of columns) {
		const value = json[col];
		if (value === undefined || value === null) return undefined;
		row[col] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	return row;
}

export async function extractRowsFromExecutionHistory(
	ctx: InstanceAiContext,
	input: ExtractRowsInput,
): Promise<ExtractRowsResult> {
	const parentNodeName = findParentNode(input.workflow, input.agentNodeName);
	if (!parentNodeName) {
		return { rows: [], scannedExecutions: 0 };
	}

	const summaries = [
		...(await ctx.executionService.list({
			workflowId: input.workflowId,
			status: 'success',
			limit: SCAN_LIMIT,
		})),
		...(await ctx.executionService.list({
			workflowId: input.workflowId,
			status: 'error',
			limit: SCAN_LIMIT,
		})),
	];

	const rows: Array<Record<string, string>> = [];
	let scannedExecutions = 0;

	for (const summary of summaries) {
		if (rows.length >= MAX_ROWS) break;

		let output: NodeOutputResult | undefined;
		try {
			output = await ctx.executionService.getNodeOutput(summary.id, parentNodeName, {
				maxItems: 1,
			});
		} catch (err) {
			ctx.logger?.warn('extract-rows: getNodeOutput failed', {
				executionId: summary.id,
				parentNodeName,
				err,
			});
			continue;
		}
		scannedExecutions++;

		const item = output.items[0];
		let json: unknown = undefined;
		if (isRecord(item)) {
			json = item.json;
		}
		const row = projectRow(json, input.inputColumns);
		if (row) rows.push(row);
	}

	return { rows, scannedExecutions };
}
