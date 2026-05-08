import type * as JSDomTypes from 'jsdom';

import {
	applyDomMask,
	COPY_BUTTON_PATTERN_SOURCE,
	parseMaskTargets,
	PASSWORD_PLACEHOLDER,
	REVEAL_BUTTON_PATTERN_SOURCE,
	REVEAL_PATTERN_SOURCES,
	SECRET_PLACEHOLDER,
	SENSITIVE_ARIA_LABEL_PATTERN_SOURCE,
	SENSITIVE_TESTID_PATTERN_SOURCE,
	shannonEntropy,
	STRUCTURAL_PROBE_SCRIPT,
	type MaskTargets,
} from './dom-mask';

describe('shannonEntropy', () => {
	it('returns 0 for an empty string', () => {
		expect(shannonEntropy('')).toBe(0);
	});

	it('returns 0 for a single repeated character', () => {
		expect(shannonEntropy('aaaaaa')).toBe(0);
	});

	it('returns log2(n) for n unique equally-distributed characters', () => {
		expect(shannonEntropy('ab')).toBeCloseTo(1, 5);
		expect(shannonEntropy('abcd')).toBeCloseTo(2, 5);
	});

	it('rates issuer-shaped tokens above the 4.5 threshold', () => {
		const sample = 'notreal-IMzLaCKsU6ZxAbt2qFc9XYdRpQ7vNtBmKL';
		expect(shannonEntropy(sample)).toBeGreaterThanOrEqual(4.5);
	});

	it('rates a long URL tracking blob below the 4.5 threshold', () => {
		// All-lowercase URL fragments tend to score low even when long.
		const sample = 'aaaaaaaaaaaaaaaaaaaaaa';
		expect(shannonEntropy(sample)).toBeLessThan(4.5);
	});
});

describe('parseMaskTargets', () => {
	it('returns empty targets for non-object input', () => {
		expect(parseMaskTargets(null)).toEqual({ passwordValues: [], dialogTexts: [] });
		expect(parseMaskTargets(undefined)).toEqual({ passwordValues: [], dialogTexts: [] });
		expect(parseMaskTargets('hello')).toEqual({ passwordValues: [], dialogTexts: [] });
	});

	it('drops non-string password values', () => {
		const out = parseMaskTargets({ passwordValues: ['a', 1, null, 'b'] });
		expect(out.passwordValues).toEqual(['a', 'b']);
	});

	it('drops dialog entries with empty text', () => {
		const out = parseMaskTargets({
			dialogTexts: [
				{ text: 'hello', revealPhraseHit: true },
				{ text: '', revealPhraseHit: true },
				{ text: 'world', revealPhraseHit: false },
			],
		});
		expect(out.dialogTexts).toEqual([
			{ text: 'hello', revealPhraseHit: true },
			{ text: 'world', revealPhraseHit: false },
		]);
	});

	it('coerces non-boolean revealPhraseHit to false', () => {
		const out = parseMaskTargets({
			dialogTexts: [{ text: 'hi', revealPhraseHit: 'yes' }],
		});
		expect(out.dialogTexts[0].revealPhraseHit).toBe(false);
	});
});

describe('STRUCTURAL_PROBE_SCRIPT', () => {
	it('is wrapped as an IIFE so page.evaluate(script) treats it as an expression', () => {
		const trimmed = STRUCTURAL_PROBE_SCRIPT.trim();
		expect(trimmed.startsWith('(function')).toBe(true);
		expect(trimmed.endsWith(')')).toBe(true);
	});

	it('parses as a valid JS expression', () => {
		// Throws SyntaxError if .toString() drift produced something unparseable.
		// eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: validating the serialized probe
		expect(() => new Function(`return ${STRUCTURAL_PROBE_SCRIPT}`)).not.toThrow();
	});

	// Drift detector — runs the serialized probe script against a real DOM
	// (jsdom) and asserts the returned shape. Catches regressions where
	// `tsc` down-leveling or .toString() representation changes break the
	// inlined probe in a way the unit tests for the typed source wouldn't
	// notice.
	describe('runs against a jsdom document', () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { JSDOM } = require('jsdom') as typeof JSDomTypes;

		function runProbe(html: string): {
			passwordValues: string[];
			dialogTexts: Array<{ text: string; revealPhraseHit: boolean }>;
		} {
			// Run in jsdom's window scope so `document` resolves to the right
			// global, exactly as it does in a real page context.
			const dom = new JSDOM(html, { runScripts: 'outside-only' });
			return dom.window.eval(STRUCTURAL_PROBE_SCRIPT) as ReturnType<typeof runProbe>;
		}

		it('detects password input values', () => {
			const result = runProbe(
				'<input type="password" value="hunter2"><input aria-label="api password key" value="long-api-token-1234567890">',
			);
			expect(result.passwordValues).toContain('hunter2');
			expect(result.passwordValues).toContain('long-api-token-1234567890');
		});

		it('detects sensitive test-id <input> as a password', () => {
			const result = runProbe('<input data-testid="admin-key" value="abcdef1234567890abcdef">');
			expect(result.passwordValues).toContain('abcdef1234567890abcdef');
		});

		it('flags reveal-phrase dialog with revealPhraseHit=true', () => {
			const result = runProbe(
				'<div role="dialog"><p>Save your key — you won\'t see it again.</p><code>secret-value-1234</code></div>',
			);
			expect(result.dialogTexts).toHaveLength(1);
			expect(result.dialogTexts[0].revealPhraseHit).toBe(true);
		});

		it('flags dialog containing a copy button via the locale-agnostic fallback', () => {
			const result = runProbe(
				'<div role="dialog"><p>Notiere den Schlüssel.</p><code>some-secret</code><button>Schlüssel kopieren</button></div>',
			);
			expect(result.dialogTexts[0].revealPhraseHit).toBe(true);
		});

		it('treats sensitive test-id container text as a reveal context', () => {
			const result = runProbe('<div data-testid="secret-display">opaque-secret-value-xyz</div>');
			expect(result.dialogTexts.some((d) => d.text.includes('opaque-secret-value-xyz'))).toBe(true);
		});

		it('returns empty arrays for a benign page', () => {
			const result = runProbe('<h1>Welcome</h1><p>Nothing to see here.</p>');
			expect(result.passwordValues).toEqual([]);
			expect(result.dialogTexts).toEqual([]);
		});

		// -------------------------------------------------------------------
		// Bucket 2 — reveal-button + copy-button on non-dialog container
		// -------------------------------------------------------------------
		it('treats Stripe-style reveal+copy container as a reveal context', () => {
			const result = runProbe(`
				<section>
					<h2>API keys</h2>
					<code>notreal_abcdefghijklmnop1234567890</code>
					<button>Reveal key</button>
					<button>Copy</button>
				</section>
			`);
			expect(
				result.dialogTexts.some((d) => d.text.includes('notreal_abcdefghijklmnop1234567890')),
			).toBe(true);
		});

		it('does not treat a generic Copy URL share section as reveal context', () => {
			const result = runProbe(`
				<section>
					<h2>Share this article</h2>
					<input value="https://example.com/article/123">
					<button>Copy</button>
				</section>
			`);
			expect(result.dialogTexts).toEqual([]);
		});

		// -------------------------------------------------------------------
		// Bucket 3a — sensitive aria-label container
		// -------------------------------------------------------------------
		it('treats span with sensitive aria-label as reveal context', () => {
			const result = runProbe(
				'<span aria-label="Live secret key">notreal_abcd1234567890efghijkl</span>',
			);
			expect(
				result.dialogTexts.some((d) => d.text.includes('notreal_abcd1234567890efghijkl')),
			).toBe(true);
		});

		it('resolves aria-labelledby to detect sensitive labels', () => {
			const result = runProbe(`
				<span id="lbl">Client Secret</span>
				<div aria-labelledby="lbl">opaque-secret-value-1234567890</div>
			`);
			expect(
				result.dialogTexts.some((d) => d.text.includes('opaque-secret-value-1234567890')),
			).toBe(true);
		});

		// -------------------------------------------------------------------
		// Bucket 3b — readonly + spellcheck=false input
		// -------------------------------------------------------------------
		it('treats readonly+spellcheck=false input with long value as a password', () => {
			const result = runProbe(
				'<input readonly spellcheck="false" value="aGenericLongOpaqueSystemValue1234">',
			);
			expect(result.passwordValues).toContain('aGenericLongOpaqueSystemValue1234');
		});

		it('does not treat readonly username field with short value as password', () => {
			const result = runProbe('<input readonly spellcheck="false" value="alice">');
			expect(result.passwordValues).toEqual([]);
		});

		// -------------------------------------------------------------------
		// Bucket 3c — <code>/<pre> ancestor confidence
		// -------------------------------------------------------------------
		it('masks <code> inside ancestor with sensitive testid', () => {
			const result = runProbe(`
				<div data-testid="api-key-display">
					<code>notreal_abcdefghijklmnopqrstuvwx</code>
				</div>
			`);
			expect(
				result.dialogTexts.some((d) => d.text.includes('notreal_abcdefghijklmnopqrstuvwx')),
			).toBe(true);
		});

		it('masks <code> inside ancestor with copy button', () => {
			const result = runProbe(`
				<section>
					<code>opaque-token-abcdefghijklmnopqrstuv</code>
					<button>Copy</button>
				</section>
			`);
			expect(
				result.dialogTexts.some((d) => d.text.includes('opaque-token-abcdefghijklmnopqrstuv')),
			).toBe(true);
		});

		it('does not mask <code> in a docs-style page (no sensitive ancestor)', () => {
			const result = runProbe(`
				<article>
					<h1>Installation</h1>
					<pre><code>npm install @example/some-pkg</code></pre>
					<p>Then run:</p>
					<pre><code>npx some-cli init</code></pre>
				</article>
			`);
			expect(result.dialogTexts).toEqual([]);
		});
	});
});

describe('COPY_BUTTON_PATTERN_SOURCE', () => {
	const regex = new RegExp(COPY_BUTTON_PATTERN_SOURCE, 'i');

	it.each([
		'Copy',
		'Copy key',
		'Copy to clipboard',
		'Click to copy',
		'Schlüssel kopieren', // German
		'Kopieren',
		'Copier la clé', // French
		'Copiar', // Spanish / Portuguese
		'Copia', // Italian
		'Copiato',
		'コピー', // Japanese
		'コピーする',
		'复制', // Simplified Chinese
		'複製', // Traditional Chinese
		'복사', // Korean
	])('matches copy-button label %p', (label) => {
		expect(regex.test(label)).toBe(true);
	});

	it.each(['Cancel', 'Save', 'Close', 'Schließen', 'Annuler', 'Cancelar', 'Sign in', 'Submit'])(
		'does not match unrelated label %p',
		(label) => {
			expect(regex.test(label)).toBe(false);
		},
	);
});

describe('REVEAL_BUTTON_PATTERN_SOURCE', () => {
	const regex = new RegExp(REVEAL_BUTTON_PATTERN_SOURCE, 'i');

	it.each([
		'Reveal key',
		'Reveal API key',
		'Reveal secret',
		'Reveal full key',
		'Show secret',
		'Show API key',
		'Unhide token',
		'View password',
		'Show access token',
	])('matches reveal-button label %p', (label) => {
		expect(regex.test(label)).toBe(true);
	});

	it.each([
		'Show details',
		'Reveal answer',
		'Show more',
		'Reveal',
		'Show',
		'View',
		'Unhide',
		'Hide',
	])('does not match generic show/reveal label %p', (label) => {
		expect(regex.test(label)).toBe(false);
	});
});

describe('SENSITIVE_ARIA_LABEL_PATTERN_SOURCE', () => {
	const regex = new RegExp(SENSITIVE_ARIA_LABEL_PATTERN_SOURCE, 'i');

	it.each([
		'API key',
		'Secret key',
		'Live secret key',
		'Access token',
		'Auth token',
		'Client secret',
		'User password',
		'Account credential',
	])('matches sensitive aria-label %p', (label) => {
		expect(regex.test(label)).toBe(true);
	});

	it.each(['Email address', 'Username', 'First name', 'Search', 'Date picker', 'Account number'])(
		'does not match neutral aria-label %p',
		(label) => {
			expect(regex.test(label)).toBe(false);
		},
	);
});

describe('SENSITIVE_TESTID_PATTERN_SOURCE', () => {
	const regex = new RegExp(SENSITIVE_TESTID_PATTERN_SOURCE, 'i');

	it.each([
		'admin-key',
		'api-key',
		'apikey-display',
		'access-token',
		'auth_token',
		'secret-value',
		'user-password',
		'credential-input',
		'session-token',
		'KEY',
	])('matches sensitive test-id %p', (id) => {
		expect(regex.test(id)).toBe(true);
	});

	it.each([
		'submit-button',
		'cancel-action',
		'user-name',
		'profile-avatar',
		'workspace-list',
		'monkey-button', // contains "key" substring but not as a token
	])('does not match neutral test-id %p', (id) => {
		expect(regex.test(id)).toBe(false);
	});
});

describe('REVEAL_PATTERN_SOURCES', () => {
	const regexes = REVEAL_PATTERN_SOURCES.map((s) => new RegExp(s, 'i'));
	const matchesAny = (s: string) => regexes.some((r) => r.test(s));

	it.each([
		// Original (must still pass)
		"You won't see it again.",
		"You won't see them again.",
		"You won't see these again.",
		"You won't see this key again.",
		"You won't be shown again.",
		"You won't be able to see them again.",
		'Save your key',
		'Save these backup codes',
		'Save this token',
		'Copy this secret',
		'Store this in a safe place',
		'Make sure to copy the value',
		'This is the only time you will see this',
		'Will only be shown once',
		'Shown only once',
		// Bucket 1 additions — real phrases from surveyed tools
		"You won't be able to retrieve this key again.", // Datadog
		"You won't be able to access it again.", // GitHub
		'You cannot see this password again.', // MongoDB Atlas
		"We won't show it to you again.", // SendGrid
		"You won't be able to see it later.", // Postman
		'Make sure you save it.', // GitLab
		'Make sure you copy this token.', // Cloudflare / Twilio
		'Note this service principal secret below.', // HashiCorp
		'Notiere den Schlüssel unten.', // Anthropic-de (note + Schlüssel)
		'We only show it once.',
		'Treat this as a password.',
		'Keep it secret.',
		'Keep this safe.',
	])('matches reveal phrase %p', (phrase) => {
		expect(matchesAny(phrase)).toBe(true);
	});

	it.each([
		'Save your work',
		'See you again later',
		'Backup your data',
		'Welcome to the dashboard',
		'You will receive a confirmation email',
		'Note that the following options are required', // generic "note" usage
		'Show details',
		'Will only be available next week', // "will only be" + non-show context
	])('does not match neutral phrase %p', (phrase) => {
		expect(matchesAny(phrase)).toBe(false);
	});
});

describe('applyDomMask', () => {
	const empty: MaskTargets = { passwordValues: [], dialogTexts: [] };

	it('returns the snapshot unchanged when targets are empty', () => {
		const snap = '- textbox "Email" [ref=e1]\n- button "Sign in" [ref=e2]';
		expect(applyDomMask(snap, empty)).toBe(snap);
	});

	it('returns empty string unchanged', () => {
		expect(applyDomMask('', empty)).toBe('');
	});

	// -------------------------------------------------------------------------
	// Pass 1: password value substitution
	// -------------------------------------------------------------------------

	it('replaces a password input value even when the value itself is low-entropy', () => {
		const snap = '- textbox "Password" [ref=e3]: hunter2';
		const targets: MaskTargets = {
			passwordValues: ['hunter2'],
			dialogTexts: [],
		};
		const out = applyDomMask(snap, targets);
		expect(out).not.toContain('hunter2');
		expect(out).toContain(PASSWORD_PLACEHOLDER);
	});

	it('replaces every occurrence of a password value', () => {
		const snap = 'value=hunter2 ... echoed=hunter2';
		const out = applyDomMask(snap, { passwordValues: ['hunter2'], dialogTexts: [] });
		expect(out.match(/hunter2/g)).toBeNull();
		expect(out.split(PASSWORD_PLACEHOLDER).length - 1).toBe(2);
	});

	it('escapes regex metacharacters in password values', () => {
		const snap = 'pwd=foo.bar+baz?[1]';
		const out = applyDomMask(snap, {
			passwordValues: ['foo.bar+baz?[1]'],
			dialogTexts: [],
		});
		expect(out).toBe(`pwd=${PASSWORD_PLACEHOLDER}`);
	});

	it('skips empty password values without touching the snapshot', () => {
		const snap = '- textbox "Password" [ref=e3]';
		const out = applyDomMask(snap, { passwordValues: ['', ''], dialogTexts: [] });
		expect(out).toBe(snap);
	});

	// -------------------------------------------------------------------------
	// Pass 2: reveal-dialog high-entropy redaction
	// -------------------------------------------------------------------------

	it('redacts high-entropy strings inside a reveal-phrase dialog', () => {
		const secret = 'notreal-IMzLaCKsU6ZxAbt2qFc9XYdRpQ7vNtBmKL';
		const dialogText = `Your API key has been created.\n${secret}\nSave your key — you won't see it again.`;
		const snap = `- dialog\n  - text: ${dialogText}\n  - button "Copy" [ref=e1]`;
		const out = applyDomMask(snap, {
			passwordValues: [],
			dialogTexts: [{ text: dialogText, revealPhraseHit: true }],
		});
		expect(out).not.toContain(secret);
		expect(out).toContain(SECRET_PLACEHOLDER);
	});

	it('does not redact high-entropy strings when no reveal phrase is present', () => {
		const candidate = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAA';
		const snap = `- generic [ref=e1]: ${candidate}`;
		const out = applyDomMask(snap, {
			passwordValues: [],
			dialogTexts: [{ text: candidate, revealPhraseHit: false }],
		});
		expect(out).toContain(candidate);
		expect(out).not.toContain(SECRET_PLACEHOLDER);
	});

	it('leaves a snapshot containing only commit SHAs untouched (no dialog context)', () => {
		const sha = 'e7d96b414c3d2e1f4a6b8c9d0e1f2a3b4c5d6e7f';
		const snap = ['- main', `  - link "${sha}" [ref=e1]`, '  - text "Update README"'].join('\n');
		const out = applyDomMask(snap, empty);
		expect(out).toBe(snap);
	});

	it('leaves long base64 PNG-blob attributes untouched (no dialog context)', () => {
		const blob = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAFklEQVQI12Pgs3WS';
		const snap = `- img [ref=e1]: src=data:image/png;base64,${blob}`;
		const out = applyDomMask(snap, empty);
		expect(out).toBe(snap);
	});

	it('leaves URL tracking parameters untouched (no dialog context)', () => {
		const snap = '- link "Article" [ref=e1]: ?utm_source=newsletter&fbclid=IwAR0xQ8mNopqrstuvwxyz';
		const out = applyDomMask(snap, empty);
		expect(out).toBe(snap);
	});

	it('skips short tokens even inside a reveal dialog', () => {
		const dialogText = 'Save your key abc123 and store it safely.';
		const snap = `- dialog: ${dialogText}`;
		const out = applyDomMask(snap, {
			passwordValues: [],
			dialogTexts: [{ text: dialogText, revealPhraseHit: true }],
		});
		expect(out).toContain('abc123');
		expect(out).not.toContain(SECRET_PLACEHOLDER);
	});

	it('respects the replacement cap for pathological inputs', () => {
		// Generate 60 distinct high-entropy tokens, all in a reveal dialog.
		const tokens = Array.from(
			{ length: 60 },
			(_, i) => `zX${i}Q1aB2cD3eF4gH5iJ6kL7mN8oP9${i.toString(36).padStart(3, '0')}xR`,
		);
		const dialogText = `Save your key. ${tokens.join(' ')}`;
		const snap = tokens.join(' | ');
		const out = applyDomMask(
			snap,
			{
				passwordValues: [],
				dialogTexts: [{ text: dialogText, revealPhraseHit: true }],
			},
			{ cap: 50 },
		);
		const masks = out.match(new RegExp(escapeForRegex(SECRET_PLACEHOLDER), 'g'));
		expect(masks?.length ?? 0).toBeLessThanOrEqual(50);
	});

	// -------------------------------------------------------------------------
	// Pass interaction
	// -------------------------------------------------------------------------

	it('preserves [ref=eN] markers around masked values', () => {
		const dialogText = 'Save your key notreal-IMzLaCKsU6ZxAbt2qFc9XYdRpQ7vNtBmKL now.';
		const snap = '- dialog [ref=e1]\n  - text [ref=e2]: notreal-IMzLaCKsU6ZxAbt2qFc9XYdRpQ7vNtBmKL';
		const out = applyDomMask(snap, {
			passwordValues: [],
			dialogTexts: [{ text: dialogText, revealPhraseHit: true }],
		});
		expect(out).toContain('[ref=e1]');
		expect(out).toContain('[ref=e2]');
		expect(out).not.toContain('notreal-IMzLaCKsU6ZxAbt2qFc9XYdRpQ7vNtBmKL');
	});

	it('applies both passes in a single call', () => {
		const secret = 'notreal-IMzLaCKsU6ZxAbt2qFc9XYdRpQ7vNtBmKL';
		const snap = `- textbox "Password" [ref=e1]: hunter2\n- dialog: Save your key ${secret} now`;
		const out = applyDomMask(snap, {
			passwordValues: ['hunter2'],
			dialogTexts: [{ text: `Save your key ${secret} now`, revealPhraseHit: true }],
		});
		expect(out).not.toContain('hunter2');
		expect(out).not.toContain(secret);
		expect(out).toContain(PASSWORD_PLACEHOLDER);
		expect(out).toContain(SECRET_PLACEHOLDER);
	});
});

function escapeForRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
