import { CostAccumulator, evaluateBudget } from '../../utils/cost-tracking';
import { computeCost } from '../../utils/pricing';

describe('computeCost', () => {
	it('computes prompt + completion cost from per-million pricing', () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 500_000 },
			{ input: 1, output: 2 },
		);
		expect(cost).toBeCloseTo(1 + 1, 10);
	});

	it('ignores cache fields when usage or pricing lacks them', () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			{ input: 2, output: 5 },
		);
		expect(cost).toBeCloseTo(7, 10);
	});

	it('adds cache read cost when present on both sides', () => {
		const cost = computeCost(
			{ promptTokens: 0, completionTokens: 0, cacheReadTokens: 1_000_000 },
			{ input: 10, output: 10, cacheRead: 1 },
		);
		expect(cost).toBeCloseTo(1, 10);
	});

	it('returns 0 for zero usage', () => {
		expect(computeCost({ promptTokens: 0, completionTokens: 0 }, { input: 100, output: 100 })).toBe(
			0,
		);
	});
});

describe('CostAccumulator', () => {
	it('accumulates calls, tokens, and cost in a single execution', () => {
		const acc = new CostAccumulator();
		acc.record({ promptTokens: 100, completionTokens: 50 }, 0.001);
		acc.record({ promptTokens: 200, completionTokens: 80 }, 0.003);

		const snap = acc.snapshot();
		expect(snap.calls).toBe(2);
		expect(snap.promptTokens).toBe(300);
		expect(snap.completionTokens).toBe(130);
		expect(snap.executionCost).toBeCloseTo(0.004, 10);
	});

	it('rolls window totals against a seed', () => {
		const acc = new CostAccumulator();
		acc.seedWindowTotals(5.5, 12.0);
		acc.record({ promptTokens: 100, completionTokens: 50 }, 0.5);

		const snap = acc.snapshot();
		expect(snap.weeklyCost).toBeCloseTo(6.0, 10);
		expect(snap.monthlyCost).toBeCloseTo(12.5, 10);
	});

	it('starts at zero with no seed', () => {
		const snap = new CostAccumulator().snapshot();
		expect(snap.calls).toBe(0);
		expect(snap.executionCost).toBe(0);
		expect(snap.weeklyCost).toBe(0);
		expect(snap.monthlyCost).toBe(0);
	});
});

describe('evaluateBudget', () => {
	const snap = (overrides: Partial<{ exec: number; week: number; month: number }>) => ({
		calls: 1,
		promptTokens: 0,
		completionTokens: 0,
		executionCost: overrides.exec ?? 0,
		weeklyCost: overrides.week ?? 0,
		monthlyCost: overrides.month ?? 0,
	});

	it('allows when no caps are set', () => {
		expect(evaluateBudget(snap({ exec: 100 }), {})).toEqual({ action: 'allow' });
	});

	it('allows below the warn threshold', () => {
		expect(evaluateBudget(snap({ exec: 0.5 }), { perExecution: 1 })).toEqual({ action: 'allow' });
	});

	it('warns at or above the warn threshold', () => {
		const out = evaluateBudget(snap({ exec: 0.95 }), { perExecution: 1 });
		expect(out.action).toBe('warn');
		if (out.action === 'warn') {
			expect(out.cap).toBe('perExecution');
			expect(out.cap_usd).toBe(1);
		}
	});

	it('blocks at or above the cap', () => {
		const out = evaluateBudget(snap({ exec: 1.0001 }), { perExecution: 1 });
		expect(out.action).toBe('block');
	});

	it('honours warnAtFraction override', () => {
		expect(evaluateBudget(snap({ exec: 0.5 }), { perExecution: 1, warnAtFraction: 0.5 })).toEqual(
			expect.objectContaining({ action: 'warn' }),
		);
	});

	it('prefers per-execution over weekly/monthly when both trigger', () => {
		const out = evaluateBudget(snap({ exec: 2, week: 100, month: 200 }), {
			perExecution: 1,
			weekly: 50,
			monthly: 150,
		});
		expect(out.action).toBe('block');
		if (out.action === 'block') {
			expect(out.cap).toBe('perExecution');
		}
	});

	it('falls back to weekly when per-execution is not configured', () => {
		const out = evaluateBudget(snap({ exec: 0, week: 200 }), { weekly: 100 });
		expect(out.action).toBe('block');
		if (out.action === 'block') {
			expect(out.cap).toBe('weekly');
		}
	});
});
