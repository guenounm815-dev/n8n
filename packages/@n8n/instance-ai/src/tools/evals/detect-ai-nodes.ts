import type { WorkflowJSON } from '@n8n/workflow-sdk';

const LANGCHAIN_TYPE_PREFIX = '@n8n/n8n-nodes-langchain.';
const EVALUATION_TYPES = new Set<string>([
	'n8n-nodes-base.evaluation',
	'n8n-nodes-base.evaluationTrigger',
]);

// Langchain nodes that are SUB-COMPONENTS (chat models, memory, embeddings,
// tools, triggers) — they hang off a root agent and are not themselves the
// thing we evaluate. Detection treats only root agents as "AI nodes".
const NON_ROOT_TYPE_PARTS = ['trigger', 'lm', 'model', 'embedding', 'memory', 'tool'];

export interface DetectAiNodesResult {
	isAiWorkflow: boolean;
	aiNodeNames: string[];
	alreadyConfigured: boolean;
}

function isRootAgentType(type: string): boolean {
	if (!type.startsWith(LANGCHAIN_TYPE_PREFIX)) return false;
	const lower = type.toLowerCase();
	return !NON_ROOT_TYPE_PARTS.some((part) => lower.includes(part));
}

export function detectAiNodes(workflow: WorkflowJSON): DetectAiNodesResult {
	const aiNodeNames: string[] = [];
	let alreadyConfigured = false;

	for (const node of workflow.nodes ?? []) {
		if (!node.name) continue;
		if (isRootAgentType(node.type)) {
			aiNodeNames.push(node.name);
		}
		if (EVALUATION_TYPES.has(node.type)) {
			alreadyConfigured = true;
		}
	}

	return {
		isAiWorkflow: aiNodeNames.length > 0,
		aiNodeNames,
		alreadyConfigured,
	};
}
