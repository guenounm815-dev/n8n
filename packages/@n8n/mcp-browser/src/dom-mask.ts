// ---------------------------------------------------------------------------
// DOM-level structural masking for snapshot output.
//
// Two passes:
//   1. Field-level: replace literal values of password-shaped <input> fields.
//   2. Reveal-dialog: when an open [role=dialog] subtree contains a known
//      reveal phrase ("save your key", "won't see again", ...), redact
//      high-entropy substrings inside that dialog's text. Entropy is only
//      ever AND-gated with structural context (a reveal-phrase dialog) and
//      a length floor — never a standalone signal.
//
// The masking transform is pure; the structural signal is collected by a
// per-adapter probe (see STRUCTURAL_PROBE_SCRIPT below).
// ---------------------------------------------------------------------------

import { structuralProbe } from './dom-mask-probe';

export interface MaskTargets {
	/** Raw values that should be masked wherever they appear in the snapshot. */
	passwordValues: string[];
	/** Open dialog text contents with a flag for reveal-phrase presence. */
	dialogTexts: Array<{ text: string; revealPhraseHit: boolean }>;
}

export const PASSWORD_PLACEHOLDER = '[REDACTED:password]';
export const SECRET_PLACEHOLDER = '[REDACTED:secret]';

/** Maximum number of redacted substrings per snapshot to bound pathological cases. */
export const DEFAULT_REPLACEMENT_CAP = 50;

/** Minimum length of a candidate secret substring inside a reveal dialog. */
export const MIN_SECRET_LENGTH = 20;

/** Minimum Shannon entropy (bits/char) for a candidate substring to be redacted. */
export const MIN_SECRET_ENTROPY = 4.5;

/**
 * Regex source matching "click to copy" button labels across common UI
 * locales. Reveal flows almost always include a copy button by design — the
 * user needs to copy the secret somewhere — so a copy button inside a
 * [role=dialog] is a strong, locale-agnostic reveal signal.
 *
 * `\b…\b` only on English `copy` to avoid matching "occupy". For other
 * locales we use `\bprefix\w*` to catch inflected forms (e.g. German
 * "kopieren", "kopiert", French "copier", "copié", Spanish "copiar",
 * "copiado").
 */
export const COPY_BUTTON_PATTERN_SOURCE =
	'\\b(?:copy|copied)\\b|\\bkopier\\w*|\\bcopier\\w*|\\bcopi[eé]\\w*|\\bcopiar\\w*|\\bcopia\\w*|\\bcopiad\\w*|\\bcopiat\\w*|cl[ií]ck\\s+to\\s+copy|複製|复制|コピー|복사';

/**
 * Regex source matching test-id / data-attribute values that identify a
 * sensitive container (the field's automation hook). A high-entropy string
 * inside e.g. `data-testid="admin-key"` is almost certainly a secret.
 */
export const SENSITIVE_TESTID_PATTERN_SOURCE =
	'(?:^|[-_])(?:key|secret|token|password|passwd|credential|api[-_]?key|access[-_]?token|auth[-_]?token)(?:$|[-_])';

/**
 * Regex source matching "reveal" / "show" toggle buttons that gate visibility
 * of a hidden secret. Constrained to "reveal/show + sensitive noun" so it
 * does not match "Show details" or "Reveal answer" type generic UI copy.
 */
export const REVEAL_BUTTON_PATTERN_SOURCE =
	'\\b(?:reveal|show|unhide|view)\\s+(?:full\\s+)?(?:keys?|secrets?|tokens?|passwords?|credentials?|api[-_\\s]?keys?|access[-_\\s]?tokens?)\\b';

/**
 * Regex source matching aria-label / aria-labelledby content on text
 * containers (not just inputs) that name them as sensitive. Stripe-style
 * dashboards often render the secret as `<span aria-label="Live secret key">…</span>`.
 */
export const SENSITIVE_ARIA_LABEL_PATTERN_SOURCE =
	'\\b(?:api[\\s-]?key|secret\\s+key|access\\s+token|auth\\s+token|client\\s+secret|secret|token|password|credential)\\b';

/** Attribute names treated as automation hooks for the sensitive-test-id pass. */
export const TESTID_ATTRS: readonly string[] = [
	'data-testid',
	'data-test-id',
	'data-test',
	'data-cy',
	'data-qa',
];

/**
 * Regex source patterns for "this is your one chance to see this value" copy.
 * Source strings (not RegExp instances) so they can be inlined into the probe
 * script via JSON.stringify. All matched case-insensitively.
 */
export const REVEAL_PATTERN_SOURCES: readonly string[] = [
	// "won't see {it/them/these/this/...} (again|later)", straight or curly apostrophe
	"won['\\u2019]?t\\s+see[\\s\\S]{0,30}\\b(?:again|later)\\b",
	// "won't be {shown|able to (see|view)} (again|later)"
	"won['\\u2019]?t\\s+be\\s+(?:shown|able\\s+to\\s+(?:see|view))[\\s\\S]{0,30}\\b(?:again|later)\\b",
	// "won't be able to (retrieve|access|recover)"
	"won['\\u2019]?t\\s+be\\s+able\\s+to\\s+(?:retrieve|access|recover)",
	// Affirmative "cannot (see|view|retrieve|access|recover)"
	'\\bcannot\\s+(?:see|view|retrieve|access|recover)\\b',
	// First-person "we (won't|will not) show"
	"\\bwe\\s+(?:won['\\u2019]?t|will\\s+not)\\s+show\\b",
	// "will (only be|not be) shown", "shown only once"
	'(?:shown|displayed|visible)\\s+only\\s+once',
	'will\\s+(?:only\\s+be|not\\s+be)\\s+shown',
	// "(only|just) show (it|this) (once|this time)"
	'(?:only|just)\\s+show[\\s\\S]{0,15}(?:once|this\\s+time)',
	// "(save|copy|store)…(key|secret|token|password|code|credentials|backup codes)"
	'\\b(?:save|copy|store)\\b[\\s\\S]{0,30}\\b(?:keys?|secrets?|tokens?|passwords?|codes?|credentials?|backup\\s+codes?)\\b',
	// "make sure (to|you) (copy|save|note|store|write)"
	'make\\s+sure\\s+(?:to|you)\\s+(?:copy|save|note|store|write)',
	// "note(re)? (this|the|down|den|das) (key|token|secret|password|code|credential|schlüssel)"
	// (covers German "Notiere den Schlüssel" as well as English "note this key")
	'\\b(?:note|notier|notiere)\\s+(?:this|the|down|den|das|die)\\b[\\s\\S]{0,30}\\b(?:keys?|tokens?|secrets?|passwords?|codes?|credentials?|schl[üu]ssel)\\b',
	// "only time you (will|can) see/view/access"
	'only\\s+time\\s+you\\b',
	'this\\s+is\\s+the\\s+only\\s+time',
	// "store this in a safe place"
	'store\\s+(?:this|it)\\s+in\\s+a\\s+safe',
	// "treat (this|it) (as|like) a (password|secret)"
	'treat\\s+(?:this|it)\\s+(?:as|like)\\s+a\\s+(?:password|secret)',
	// "keep it (safe|secret|secure|private)"
	'keep\\s+(?:it|this)\\s+(?:safe|secret|secure|private)',
];

const ARIA_PASSWORD_LABEL = /password|passcode|pin\b/i;
const PASSWORD_AUTOCOMPLETE = /current-password|new-password|one-time-code/i;

// ---------------------------------------------------------------------------
// Probe script — runs in the page context. Same script for both adapters.
//
// The probe body lives in dom-mask-probe.ts as a real TS function so it gets
// type checking and ESLint coverage. Here we serialize it via
// `Function.prototype.toString()` and call it with the regex source strings
// so the page-context script is self-contained (closures don't survive
// .toString()).
// ---------------------------------------------------------------------------

export const STRUCTURAL_PROBE_SCRIPT = `(${structuralProbe.toString()})(${[
	JSON.stringify(REVEAL_PATTERN_SOURCES),
	JSON.stringify(COPY_BUTTON_PATTERN_SOURCE),
	JSON.stringify(REVEAL_BUTTON_PATTERN_SOURCE),
	JSON.stringify(SENSITIVE_TESTID_PATTERN_SOURCE),
	JSON.stringify(SENSITIVE_ARIA_LABEL_PATTERN_SOURCE),
	JSON.stringify(ARIA_PASSWORD_LABEL.source),
	JSON.stringify(PASSWORD_AUTOCOMPLETE.source),
	JSON.stringify(TESTID_ATTRS),
].join(',')})`;

/**
 * Coerce arbitrary probe output into a well-formed MaskTargets, dropping any
 * shape mismatches. Adapters call the probe via subprocess IPC or
 * page.evaluate, so we never trust the raw shape.
 */
export function parseMaskTargets(value: unknown): MaskTargets {
	const empty: MaskTargets = { passwordValues: [], dialogTexts: [] };
	if (!value || typeof value !== 'object') return empty;
	const v = value as Record<string, unknown>;
	const passwordValues = Array.isArray(v.passwordValues)
		? v.passwordValues.filter((x): x is string => typeof x === 'string')
		: [];
	const dialogTexts = Array.isArray(v.dialogTexts)
		? v.dialogTexts
				.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
				.map((d) => ({
					text: typeof d.text === 'string' ? d.text : '',
					revealPhraseHit: d.revealPhraseHit === true,
				}))
				.filter((d) => d.text.length > 0)
		: [];
	return { passwordValues, dialogTexts };
}

// ---------------------------------------------------------------------------
// Entropy helpers
// ---------------------------------------------------------------------------

export function shannonEntropy(s: string): number {
	if (!s) return 0;
	const freq = new Map<string, number>();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	const len = s.length;
	let h = 0;
	for (const count of freq.values()) {
		const p = count / len;
		h -= p * Math.log2(p);
	}
	return h;
}

// ---------------------------------------------------------------------------
// Pure transform
// ---------------------------------------------------------------------------

interface ApplyOpts {
	cap?: number;
	minLength?: number;
	minEntropy?: number;
}

/**
 * Apply DOM-level structural masking to a snapshot string.
 * - Replaces literal occurrences of every password value with a placeholder.
 * - For each dialog flagged with a reveal phrase, redacts high-entropy
 *   substrings (≥ minLength chars, ≥ minEntropy bits/char) appearing in the
 *   snapshot.
 *
 * Pure: no DOM access, no I/O. Safe to call with arbitrary input.
 */
export function applyDomMask(snapshot: string, targets: MaskTargets, opts: ApplyOpts = {}): string {
	if (!snapshot) return snapshot;
	const cap = opts.cap ?? DEFAULT_REPLACEMENT_CAP;
	const minLength = opts.minLength ?? MIN_SECRET_LENGTH;
	const minEntropy = opts.minEntropy ?? MIN_SECRET_ENTROPY;

	let out = snapshot;
	let replacements = 0;

	// Pass 1: literal password values
	const seenPwd = new Set<string>();
	for (const value of targets.passwordValues ?? []) {
		if (!value || seenPwd.has(value)) continue;
		seenPwd.add(value);
		if (replacements >= cap) break;
		const pattern = new RegExp(escapeRegExp(value), 'g');
		const before = out;
		out = out.replace(pattern, () => {
			replacements++;
			return PASSWORD_PLACEHOLDER;
		});
		if (out === before) continue;
	}

	// Pass 2: reveal-dialog high-entropy tokens
	const candidates = new Set<string>();
	for (const dialog of targets.dialogTexts ?? []) {
		if (!dialog.revealPhraseHit || !dialog.text) continue;
		for (const token of extractHighEntropyTokens(dialog.text, minLength, minEntropy)) {
			candidates.add(token);
		}
	}

	for (const token of candidates) {
		if (replacements >= cap) break;
		const pattern = new RegExp(escapeRegExp(token), 'g');
		out = out.replace(pattern, () => {
			replacements++;
			return SECRET_PLACEHOLDER;
		});
	}

	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tokenize text and yield substrings that look like high-entropy secrets.
 * Splits on whitespace and ASCII punctuation that is unlikely to appear
 * inside a secret value (commas, parentheses, brackets, quotes), but keeps
 * common secret-internal characters (hyphen, underscore, dot, slash, plus,
 * equals, colon).
 */
function extractHighEntropyTokens(text: string, minLength: number, minEntropy: number): string[] {
	const tokens: string[] = [];
	// Allow word chars, hyphen, dot, slash, plus, equals, colon — these all
	// appear in real opaque-token formats (issuer prefixes, JWTs, header
	// values, etc.) so we don't split a single token into multiple matches.
	const matches = text.match(/[A-Za-z0-9_\-./+=:]+/g) ?? [];
	for (const raw of matches) {
		const token = raw.replace(/^[._:=+-]+|[._:=+-]+$/g, '');
		if (token.length < minLength) continue;
		if (shannonEntropy(token) < minEntropy) continue;
		tokens.push(token);
	}
	return tokens;
}
