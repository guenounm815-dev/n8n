const MODELS_DEV_URL = 'https://models.dev/api.json';

/** Cost per million tokens. */
export interface ModelCost {
	/** Cost per million input tokens (USD). */
	input: number;
	/** Cost per million output tokens (USD). */
	output: number;
	/** Cost per million cached input tokens (USD). */
	cacheRead?: number;
	/** Cost per million cache write tokens (USD). */
	cacheWrite?: number;
}

/** Model context/output limits. */
export interface ModelLimits {
	/** Maximum context window size in tokens. */
	context?: number;
	/** Maximum output tokens. */
	output?: number;
}

/** Information about a single model. */
export interface ModelInfo {
	/** Model ID (e.g. 'claude-sonnet-4-5'). */
	id: string;
	/** Human-readable name (e.g. 'Claude Sonnet 4.5'). */
	name: string;
	/** Whether the model supports reasoning / thinking. */
	reasoning: boolean;
	/** Whether the model supports tool calling. */
	toolCall: boolean;
	/** Cost per million tokens. */
	cost?: ModelCost;
	/** Token limits. */
	limits?: ModelLimits;
}

/** Information about a provider. */
export interface ProviderInfo {
	/** Provider ID (e.g. 'anthropic'). */
	id: string;
	/** Human-readable name (e.g. 'Anthropic'). */
	name: string;
	/** Available models keyed by model ID. */
	models: Record<string, ModelInfo>;
}

/** The full catalog of providers and their models. */
export type ProviderCatalog = Record<string, ProviderInfo>;

interface ModelsDevModel {
	id: string;
	name: string;
	reasoning?: boolean;
	tool_call?: boolean;
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
}

interface ModelsDevProvider {
	id: string;
	name: string;
	models?: Record<string, ModelsDevModel>;
}

/**
 * Fetch the provider/model catalog from models.dev.
 */
export async function fetchProviderCatalog(): Promise<ProviderCatalog> {
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch provider catalog: ${response.statusText}`);
	}

	const data = (await response.json()) as Record<string, ModelsDevProvider>;
	const catalog: ProviderCatalog = {};

	for (const [key, provider] of Object.entries(data)) {
		if (!provider.models || Object.keys(provider.models).length === 0) continue;

		const models: Record<string, ModelInfo> = {};
		for (const [modelId, model] of Object.entries(provider.models)) {
			const info: ModelInfo = {
				id: model.id,
				name: model.name,
				reasoning: model.reasoning ?? false,
				toolCall: model.tool_call ?? false,
			};
			if (model.cost?.input !== undefined && model.cost?.output !== undefined) {
				info.cost = {
					input: model.cost.input,
					output: model.cost.output,
					...(model.cost.cache_read !== undefined && { cacheRead: model.cost.cache_read }),
					...(model.cost.cache_write !== undefined && { cacheWrite: model.cost.cache_write }),
				};
			}
			if (model.limit) {
				info.limits = {
					...(model.limit.context !== undefined && { context: model.limit.context }),
					...(model.limit.output !== undefined && { output: model.limit.output }),
				};
			}
			models[modelId] = info;
		}

		catalog[key] = {
			id: provider.id,
			name: provider.name,
			models,
		};
	}

	return catalog;
}

let cachedCatalog: ProviderCatalog | undefined;
let catalogFetchPromise: Promise<ProviderCatalog | undefined> | undefined;

/**
 * Get the cached catalog, fetching once if needed. Returns undefined on failure
 * (offline, timeout) so callers can degrade silently.
 */
export async function getCachedCatalog(): Promise<ProviderCatalog | undefined> {
	if (cachedCatalog) return cachedCatalog;

	catalogFetchPromise ??= fetchProviderCatalog()
		.then((c) => {
			cachedCatalog = c;
			return c;
		})
		.catch((error: unknown) => {
			catalogFetchPromise = undefined;
			console.warn(
				'[ai-utilities/pricing] Failed to fetch model catalog from models.dev — cost data will be unavailable:',
				error instanceof Error ? error.message : error,
			);
			return undefined;
		});

	return await catalogFetchPromise;
}

/**
 * Look up cost for a fully qualified model id (`provider/model`, e.g. `anthropic/claude-sonnet-4-5`).
 */
export async function getModelCost(modelId: string): Promise<ModelCost | undefined> {
	const catalog = await getCachedCatalog();
	if (!catalog) return undefined;

	const [provider, ...rest] = modelId.split('/');
	const modelName = rest.join('/');

	return catalog[provider]?.models[modelName]?.cost;
}

/**
 * Look up cost for a model by provider and model name separately. Used by LangChain
 * LM sub-nodes that know the provider statically but only see a bare model name at runtime.
 *
 * Tries an exact match first, then strips trailing `-YYYYMMDD` / `-YYYY-MM-DD` date suffixes
 * commonly used in pinned provider model ids (e.g. `claude-sonnet-4-5-20251015`).
 */
export async function lookupModelCost(
	provider: string,
	modelName: string,
): Promise<ModelCost | undefined> {
	const catalog = await getCachedCatalog();
	if (!catalog) return undefined;

	const models = catalog[provider]?.models;
	if (!models) return undefined;

	if (models[modelName]?.cost) return models[modelName].cost;

	const stripped = modelName.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
	return models[stripped]?.cost;
}

/**
 * Compute USD cost from token usage and per-million pricing. Cached tokens are
 * priced at their respective rates when present, otherwise omitted.
 */
export function computeCost(
	usage: {
		promptTokens: number;
		completionTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	},
	cost: ModelCost,
): number {
	const inputCost = (usage.promptTokens / 1_000_000) * cost.input;
	const outputCost = (usage.completionTokens / 1_000_000) * cost.output;
	const cacheReadCost =
		usage.cacheReadTokens !== undefined && cost.cacheRead !== undefined
			? (usage.cacheReadTokens / 1_000_000) * cost.cacheRead
			: 0;
	const cacheWriteCost =
		usage.cacheWriteTokens !== undefined && cost.cacheWrite !== undefined
			? (usage.cacheWriteTokens / 1_000_000) * cost.cacheWrite
			: 0;
	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
