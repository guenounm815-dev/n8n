import { formatEvalSetupTask } from '../format-eval-setup-task';

const BASE = {
	workflowId: 'w1',
	workflowName: 'Telegram AI Q&A Bot',
	detectedAiNodes: ['General Agent'],
	datasetChoice: 'create-empty' as const,
	suggestedInputColumns: ['user_message'],
	suggestedOutputColumns: ['agent_response'],
	enabledMetrics: [
		{
			id: 'correctness',
			name: 'Correctness',
			kind: 'llm-judge' as const,
			description: 'Factual correctness of the response.',
			prompt: 'Judge if the response is correct.',
			cannedMetricKey: 'correctness',
			defaultEnabled: true,
		},
	],
};

describe('formatEvalSetupTask', () => {
	it('includes workflow id and name, and detected AI nodes', () => {
		const task = formatEvalSetupTask(BASE);
		expect(task).toContain('w1');
		expect(task).toContain('Telegram AI Q&A Bot');
		expect(task).toContain('General Agent');
	});

	it('instructs sub-agent to create an empty DataTable only', () => {
		const task = formatEvalSetupTask(BASE);
		expect(task).toContain('Create an empty DataTable');
		expect(task).toContain('Do not insert rows');
		expect(task).toContain('- user_message');
		expect(task).toContain('- agent_response');
	});

	it('lists each enabled metric with kind and canned key when present', () => {
		const task = formatEvalSetupTask(BASE);
		expect(task).toContain('Correctness');
		expect(task).toContain('llm-judge');
		expect(task).toContain('canned=correctness');
		expect(task).toContain('Judge prompt: Judge if the response is correct.');
	});

	it('omits canned marker when the metric has no cannedMetricKey', () => {
		const task = formatEvalSetupTask({
			...BASE,
			enabledMetrics: [
				{
					id: 'exact',
					name: 'Exact Match',
					kind: 'exact-match' as const,
					description: 'Literal string match.',
					defaultEnabled: true,
				},
			],
		});
		expect(task).toContain('Exact Match');
		expect(task).toContain('exact-match');
		expect(task).not.toContain('canned=');
	});

	it('mentions the checkIfEvaluating topology as expected behavior', () => {
		const task = formatEvalSetupTask(BASE);
		expect(task).toContain('checkIfEvaluating');
		expect(task).toContain('setInputs');
		expect(task).toMatch(/Normal/);
	});

	it('instructs direct wiring from EvaluationTrigger to the target AI node', () => {
		const task = formatEvalSetupTask(BASE);

		expect(task).toContain('EvaluationTrigger → target AI agent node');
		expect(task).not.toContain('first processing node');
	});

	it('instructs agent parameter rewrite to use dataset columns', () => {
		const task = formatEvalSetupTask(BASE);

		expect(task).toContain('$json.<column>');
		expect(task).toContain('rewrite those parameter expressions');
	});

	it('instructs to rewrite agent input parameters to use dataset columns', () => {
		const task = formatEvalSetupTask(BASE);

		expect(task).toContain('rewrite those parameter expressions to use');
		expect(task).toContain('INPUT COLUMNS');
	});

	it('lists the suggested output columns as bullet items', () => {
		const task = formatEvalSetupTask({
			...BASE,
			suggestedOutputColumns: ['agent_response', 'tool_used'],
		});
		expect(task).toContain('- agent_response');
		expect(task).toContain('- tool_used');
	});

	it('renders the chosen metric ids and omits the empty output-columns block', () => {
		const task = formatEvalSetupTask({
			workflowId: 'w1',
			workflowName: 'Wf',
			detectedAiNodes: ['Agent'],
			datasetChoice: 'link-existing',
			existingDataTableId: 'dt-1',
			projectId: 'p1',
			suggestedInputColumns: ['user_query'],
			suggestedOutputColumns: [],
			enabledMetrics: [
				{
					id: 'correctness',
					name: 'Correctness',
					kind: 'llm-judge' as const,
					cannedMetricKey: 'correctness',
					description: '',
					prompt: '',
					defaultEnabled: true,
				},
				{
					id: 'tool_use',
					name: 'Tool use',
					kind: 'llm-judge' as const,
					cannedMetricKey: 'tool_use',
					description: '',
					prompt: '',
					defaultEnabled: false,
				},
			],
		});

		expect(task).toMatch(/correctness/);
		expect(task).toMatch(/tool_use/);
		// No empty "Suggested output columns:" line ending with a dangling colon or empty list.
		expect(task).not.toMatch(/Suggested output columns:\s*$/m);
		expect(task).not.toMatch(/Suggested output columns:\s*\n/);
	});
});

describe('formatEvalSetupTask — no shape bridge', () => {
	const sampleTask = formatEvalSetupTask({
		workflowId: 'w1',
		workflowName: 'Wf',
		detectedAiNodes: ['Agent'],
		datasetChoice: 'link-existing',
		existingDataTableId: 'dt-1',
		projectId: 'p1',
		suggestedInputColumns: ['user_query'],
		suggestedOutputColumns: [],
		enabledMetrics: [
			{
				id: 'correctness',
				name: 'Correctness',
				kind: 'llm-judge' as const,
				cannedMetricKey: 'correctness',
				description: '',
				prompt: '',
				defaultEnabled: true,
			},
		],
	});

	it('does not mention shape bridge', () => {
		expect(sampleTask).not.toMatch(/shape bridge/i);
		expect(sampleTask).not.toMatch(/Set bridge/i);
	});

	it('does not forbid modifying agent parameters as a hard rule', () => {
		expect(sampleTask).not.toMatch(/DO NOT MODIFY TARGET AI AGENT PARAMETERS/);
	});

	it('instructs direct wiring from EvaluationTrigger to the agent', () => {
		expect(sampleTask).toMatch(/EvaluationTrigger.*direct.*agent/i);
	});
});
