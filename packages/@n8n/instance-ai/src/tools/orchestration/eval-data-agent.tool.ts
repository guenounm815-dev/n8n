import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { OrchestrationContext } from '../../types';
import { analyzeEvalDataRequirements } from '../evals/eval-data-requirements.service';
import { extractRowsFromExecutionHistory } from '../evals/extract-rows-from-history.service';
import { generateSampleRows } from '../evals/generate-sample-rows.service';

const HISTORY_THRESHOLD = 10;
const GENERATE_ROW_COUNT = 10;
const FALLBACK_COLUMN = 'input';

const evalDataInputSchema = z.object({
	workflowId: z.string().describe('ID of the workflow whose eval DataTable should be populated'),
	projectId: z.string().optional(),
});

const outputSchema = z.object({
	status: z.enum(['imported', 'generated', 'skipped']),
	rowCount: z.number().optional(),
	source: z.enum(['history', 'synthetic']).optional(),
	reason: z.string().optional(),
});

export function createEvalDataAgentTool(context: OrchestrationContext) {
	return createTool({
		id: 'eval-data',
		description:
			'Populate an eval DataTable for a workflow that already has its eval setup wired. ' +
			'First scans the workflow execution history for real rows; if fewer than 10 valid rows ' +
			'are available, generates 10 synthetic rows instead. Inserts at most 25 rows total. ' +
			'Synchronous — no sub-agent, no HITL.',
		inputSchema: evalDataInputSchema,
		outputSchema,
		execute: async (input: z.infer<typeof evalDataInputSchema>) => {
			const domain = context.domainContext;
			if (!domain) {
				return { status: 'skipped' as const, reason: 'Domain context unavailable.' };
			}

			const workflow = await domain.workflowService.getAsWorkflowJSON(input.workflowId);
			const reqs = analyzeEvalDataRequirements(workflow);
			const target = reqs.targets[0];
			if (!target) {
				return { status: 'skipped' as const, reason: reqs.reason ?? 'No eval target.' };
			}
			if (!target.targetAgentNodeName) {
				return {
					status: 'skipped' as const,
					reason: 'No agent node reachable from EvaluationTrigger.',
				};
			}
			if (
				target.inputColumns.length === 0 ||
				(target.inputColumns.length === 1 && target.inputColumns[0] === FALLBACK_COLUMN)
			) {
				return {
					status: 'skipped' as const,
					reason: 'no-detectable-input-columns-in-agent-parameters',
				};
			}

			const { rows: historyRows } = await extractRowsFromExecutionHistory(domain, {
				workflow,
				workflowId: input.workflowId,
				agentNodeName: target.targetAgentNodeName,
				inputColumns: target.inputColumns,
				expectedToActualPairs: target.expectedToActualPairs,
			});

			let rowsToInsert: Array<Record<string, unknown>>;
			let source: 'history' | 'synthetic';

			if (historyRows.length >= HISTORY_THRESHOLD) {
				rowsToInsert = historyRows;
				source = 'history';
			} else {
				rowsToInsert = await generateSampleRows({
					workflow,
					columns: [...target.inputColumns, ...target.expectedOutputColumns],
					rowCount: GENERATE_ROW_COUNT,
				});
				source = 'synthetic';
			}

			await domain.dataTableService.insertRows(
				target.dataTableId,
				rowsToInsert,
				input.projectId ? { projectId: input.projectId } : undefined,
			);

			return {
				status: source === 'history' ? ('imported' as const) : ('generated' as const),
				rowCount: rowsToInsert.length,
				source,
			};
		},
	});
}
