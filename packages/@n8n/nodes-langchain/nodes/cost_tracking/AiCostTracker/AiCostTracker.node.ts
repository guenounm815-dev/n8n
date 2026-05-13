import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import {
	CostAccumulator,
	computeCost,
	evaluateBudget,
	getConnectionHintNoticeField,
	lookupModelCost,
	type BudgetCaps,
} from '@n8n/ai-utilities';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataTableProjectService,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

type ColumnSpec = { name: string; type: 'string' | 'number' | 'boolean' | 'date' };

const REQUIRED_COLUMNS: ColumnSpec[] = [
	{ name: 'ts', type: 'date' },
	{ name: 'model', type: 'string' },
	{ name: 'prompt_tokens', type: 'number' },
	{ name: 'completion_tokens', type: 'number' },
	{ name: 'cost', type: 'number' },
	{ name: 'workflow_id', type: 'string' },
	{ name: 'execution_id', type: 'string' },
];

async function ensureCostTableSchema(table: IDataTableProjectService): Promise<void> {
	const existing = await table.getColumns();
	const existingNames = new Set(existing.map((c) => c.name));
	for (const col of REQUIRED_COLUMNS) {
		if (!existingNames.has(col.name)) {
			await table.addColumn(col);
		}
	}
}

class CostTrackingCallbackHandler extends BaseCallbackHandler {
	name = 'CostTracker';

	awaitHandlers = true;

	constructor(
		private readonly ctx: ISupplyDataFunctions,
		private readonly provider: string,
		private readonly caps: BudgetCaps,
		private readonly accumulator: CostAccumulator,
		private readonly onBlock: 'throw' | 'warn',
		private readonly dataTable: IDataTableProjectService | null,
		private readonly schemaReady: Promise<void> | null,
	) {
		super();
	}

	async handleLLMEnd(output: LLMResult): Promise<void> {
		const rawUsage = (output.llmOutput?.tokenUsage ?? output.llmOutput?.usage ?? {}) as Record<
			string,
			number | undefined
		>;
		const promptTokens = rawUsage.promptTokens ?? rawUsage.prompt_tokens ?? 0;
		const completionTokens = rawUsage.completionTokens ?? rawUsage.completion_tokens ?? 0;

		if (promptTokens === 0 && completionTokens === 0) return;

		const modelName = (output.llmOutput?.modelName ??
			output.llmOutput?.model ??
			'unknown') as string;
		const pricing = await lookupModelCost(this.provider, modelName);
		const costUsd = pricing ? computeCost({ promptTokens, completionTokens }, pricing) : 0;

		this.accumulator.record({ promptTokens, completionTokens }, costUsd);

		if (this.dataTable && this.schemaReady) {
			try {
				await this.schemaReady;
				await this.dataTable.insertRows(
					[
						{
							ts: new Date(),
							model: modelName,
							prompt_tokens: promptTokens,
							completion_tokens: completionTokens,
							cost: costUsd,
							workflow_id: this.ctx.getWorkflow().id ?? '',
							execution_id: this.ctx.getExecutionId(),
						},
					],
					'count',
				);
			} catch (err) {
				this.ctx.logger.warn(
					`[AI Cost Tracker] Failed to persist row: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		const decision = evaluateBudget(this.accumulator.snapshot(), this.caps);
		if (decision.action === 'block') {
			const msg = `AI cost cap reached: ${decision.cap} cap of $${decision.cap_usd.toFixed(4)} exceeded (consumed $${decision.consumed.toFixed(4)})`;
			if (this.onBlock === 'throw') {
				throw new NodeOperationError(this.ctx.getNode(), msg);
			}
			this.ctx.logger.warn(msg);
		} else if (decision.action === 'warn') {
			this.ctx.logger.warn(
				`[AI Cost Tracker] Approaching ${decision.cap} cap: $${decision.consumed.toFixed(4)} of $${decision.cap_usd.toFixed(4)}`,
			);
		}
	}
}

export class AiCostTracker implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AI Cost Tracker',
		name: 'aiCostTracker',
		icon: 'fa:dollar-sign',
		iconColor: 'green',
		group: ['transform'],
		version: [1],
		description:
			'Tracks LLM token cost for an Agent, persists per-call rows to a Data Table, and enforces budget caps',
		defaults: {
			name: 'AI Cost Tracker',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Cost Tracking'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.aicosttracker/',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiCostTracker],
		outputNames: ['Cost Tracker'],
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent]),
			{
				displayName: 'Provider',
				name: 'provider',
				type: 'options',
				default: 'openai',
				options: [
					{ name: 'Anthropic', value: 'anthropic' },
					{ name: 'AWS Bedrock', value: 'amazon-bedrock' },
					{ name: 'Cohere', value: 'cohere' },
					{ name: 'Google', value: 'google' },
					{ name: 'Groq', value: 'groq' },
					{ name: 'Mistral', value: 'mistral' },
					{ name: 'OpenAI', value: 'openai' },
					{ name: 'OpenRouter', value: 'openrouter' },
				],
				description:
					'Provider of the connected language model — used to look up pricing from the models.dev catalog',
			},
			{
				displayName: 'Data Table ID',
				name: 'dataTableId',
				type: 'string',
				default: '',
				placeholder: 'leave empty to skip persistence',
				description:
					'ID of the Data Table where per-call cost rows are appended. Required columns are created automatically on first write.',
			},
			{
				displayName: 'Per-Execution Cap (USD)',
				name: 'perExecutionCap',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, numberPrecision: 4 },
				description:
					'Set to 0 to disable. Aborts the run (or warns, depending on the option below) when cumulative spend in a single execution exceeds this amount.',
			},
			{
				displayName: 'On Cap Exceeded',
				name: 'onCapExceeded',
				type: 'options',
				default: 'throw',
				options: [
					{ name: 'Block (Throw Error)', value: 'throw' },
					{ name: 'Warn (Log Only)', value: 'warn' },
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const provider = this.getNodeParameter('provider', itemIndex) as string;
		const perExecutionCap = this.getNodeParameter('perExecutionCap', itemIndex, 0) as number;
		const onCapExceeded = this.getNodeParameter('onCapExceeded', itemIndex, 'throw') as
			| 'throw'
			| 'warn';
		const dataTableId = this.getNodeParameter('dataTableId', itemIndex, '') as string;

		const caps: BudgetCaps = {};
		if (perExecutionCap > 0) caps.perExecution = perExecutionCap;

		const accumulator = new CostAccumulator();

		let dataTable: IDataTableProjectService | null = null;
		let schemaReady: Promise<void> | null = null;
		if (dataTableId && this.helpers.getDataTableProxy) {
			dataTable = await this.helpers.getDataTableProxy(dataTableId);
			schemaReady = ensureCostTableSchema(dataTable);
		}

		const handler = new CostTrackingCallbackHandler(
			this,
			provider,
			caps,
			accumulator,
			onCapExceeded,
			dataTable,
			schemaReady,
		);

		return {
			response: handler,
		};
	}
}
