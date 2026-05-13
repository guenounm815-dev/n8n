/** Configured spend caps, all in USD. Undefined caps are ignored. */
export interface BudgetCaps {
	/** Cap for the current run / execution. */
	perExecution?: number;
	/** Cap for the rolling 7-day window. Caller must seed the accumulator with the window total at run start. */
	weekly?: number;
	/** Cap for the rolling 30-day window. */
	monthly?: number;
	/** Fraction of any cap (0..1) at which the evaluator returns 'warn' instead of 'allow'. */
	warnAtFraction?: number;
}

/** Outcome of evaluating the accumulator state against the configured caps. */
export type BudgetAction =
	| { action: 'allow' }
	| {
			action: 'warn';
			cap: 'perExecution' | 'weekly' | 'monthly';
			consumed: number;
			cap_usd: number;
	  }
	| {
			action: 'block';
			cap: 'perExecution' | 'weekly' | 'monthly';
			consumed: number;
			cap_usd: number;
	  };

/** Snapshot of accumulator state. */
export interface CostSnapshot {
	calls: number;
	promptTokens: number;
	completionTokens: number;
	executionCost: number;
	/** Includes any seeded historical total — used for weekly/monthly cap checks. */
	weeklyCost: number;
	monthlyCost: number;
}

/**
 * Accumulates token + cost over a single run. Weekly/monthly buckets are seeded by the
 * caller (one window query at run start) and incremented in lockstep with execution cost.
 */
export class CostAccumulator {
	private calls = 0;
	private promptTokens = 0;
	private completionTokens = 0;
	private executionCost = 0;
	private weeklySeed = 0;
	private monthlySeed = 0;

	seedWindowTotals(weeklySoFar: number, monthlySoFar: number): void {
		this.weeklySeed = weeklySoFar;
		this.monthlySeed = monthlySoFar;
	}

	record(usage: { promptTokens: number; completionTokens: number }, costUsd: number): void {
		this.calls += 1;
		this.promptTokens += usage.promptTokens;
		this.completionTokens += usage.completionTokens;
		this.executionCost += costUsd;
	}

	snapshot(): CostSnapshot {
		return {
			calls: this.calls,
			promptTokens: this.promptTokens,
			completionTokens: this.completionTokens,
			executionCost: this.executionCost,
			weeklyCost: this.weeklySeed + this.executionCost,
			monthlyCost: this.monthlySeed + this.executionCost,
		};
	}
}

const DEFAULT_WARN_FRACTION = 0.9;

/**
 * Evaluate a cost snapshot against configured caps. Returns the most restrictive outcome.
 * Order of precedence: per-execution > weekly > monthly. Block beats warn at the same level.
 */
export function evaluateBudget(snapshot: CostSnapshot, caps: BudgetCaps): BudgetAction {
	const warnAt = caps.warnAtFraction ?? DEFAULT_WARN_FRACTION;

	const checks: Array<{
		cap: 'perExecution' | 'weekly' | 'monthly';
		consumed: number;
		limit: number | undefined;
	}> = [
		{ cap: 'perExecution', consumed: snapshot.executionCost, limit: caps.perExecution },
		{ cap: 'weekly', consumed: snapshot.weeklyCost, limit: caps.weekly },
		{ cap: 'monthly', consumed: snapshot.monthlyCost, limit: caps.monthly },
	];

	for (const c of checks) {
		if (c.limit === undefined) continue;
		if (c.consumed >= c.limit) {
			return { action: 'block', cap: c.cap, consumed: c.consumed, cap_usd: c.limit };
		}
	}

	for (const c of checks) {
		if (c.limit === undefined) continue;
		if (c.consumed >= c.limit * warnAt) {
			return { action: 'warn', cap: c.cap, consumed: c.consumed, cap_usd: c.limit };
		}
	}

	return { action: 'allow' };
}
