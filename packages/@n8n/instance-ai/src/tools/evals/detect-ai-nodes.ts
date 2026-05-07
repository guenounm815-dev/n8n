import type { WorkflowJSON } from '@n8n/workflow-sdk';

const LANGCHAIN_TYPE_PREFIX = '@n8n/n8n-nodes-langchain.';
const EVALUATION_TYPES = new Set<string>([
	'n8n-nodes-base.evaluation',
	'n8n-nodes-base.evaluationTrigger',
]);

// Explicit allow-list of root AI nodes — agents and chains that consume an LLM
// and produce the output we want to evaluate. Sub-components (chat models,
// memory, embeddings, tools, parsers, vector stores, retrievers, document
// loaders, text splitters, triggers) hang off a root and are NOT themselves
// evaluation targets. An allow-list avoids the substring traps that bite
// heuristics — e.g. `chainLlm` contains `lm`, which a substring deny-list
// would mistake for a chat-model sub-component.
const ROOT_AI_TYPES = new Set<string>([
	`${LANGCHAIN_TYPE_PREFIX}agent`,
	`${LANGCHAIN_TYPE_PREFIX}openAiAssistant`,
	`${LANGCHAIN_TYPE_PREFIX}chainLlm`,
	`${LANGCHAIN_TYPE_PREFIX}chainRetrievalQa`,
	`${LANGCHAIN_TYPE_PREFIX}chainSummarization`,
	`${LANGCHAIN_TYPE_PREFIX}informationExtractor`,
	`${LANGCHAIN_TYPE_PREFIX}sentimentAnalysis`,
	`${LANGCHAIN_TYPE_PREFIX}textClassifier`,
]);

export interface DetectAiNodesResult {
	isAiWorkflow: boolean;
	aiNodeNames: string[];
	alreadyConfigured: boolean;
}

function isRootAgentType(type: string): boolean {
	return ROOT_AI_TYPES.has(type);
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
