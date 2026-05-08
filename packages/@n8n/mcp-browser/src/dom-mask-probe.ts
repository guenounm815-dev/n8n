// ---------------------------------------------------------------------------
// Structural probe — runs in the page context to gather mask targets.
//
// Authored as a real TS function so we get type checking, ESLint coverage,
// and DOM autocompletion while writing it. At runtime it is serialized via
// `Function.prototype.toString()` and injected into the page as a single
// expression of the form `(<serialized fn>)(arg1, arg2, ...)` — declaring
// and immediately calling the function in one go, so `page.evaluate()`
// receives a value rather than a statement. See dom-mask.ts:
// STRUCTURAL_PROBE_SCRIPT for the call site.
//
// Constraints to keep this stable across `tsc` targets:
// - Use a `function` declaration (not arrow), so `.toString()` returns
//   nearly verbatim source.
// - Take regex source strings as positional args; do NOT close over module
//   scope (closures don't survive `.toString()`).
// - Keep helpers as inner functions inside `structuralProbe` so they're
//   serialized as part of the body.
// ---------------------------------------------------------------------------

export interface ProbeResult {
	passwordValues: string[];
	dialogTexts: Array<{ text: string; revealPhraseHit: boolean }>;
}

export function structuralProbe(
	revealPatternSources: readonly string[],
	copyButtonPatternSource: string,
	revealButtonPatternSource: string,
	sensitiveTestidPatternSource: string,
	sensitiveAriaLabelPatternSource: string,
	ariaPasswordLabelSource: string,
	passwordAutocompleteSource: string,
	testidAttrs: readonly string[],
): ProbeResult {
	// All bindings used inside this function come from arguments — module
	// scope is not visible at runtime since `Function.prototype.toString()`
	// only serializes the body.

	const passwordValues: string[] = [];
	const dialogTexts: Array<{ text: string; revealPhraseHit: boolean }> = [];
	const seenContainers = new Set<Element>();

	const REVEAL_REGEXES = revealPatternSources.map((s) => new RegExp(s, 'i'));
	const COPY_REGEX = new RegExp(copyButtonPatternSource, 'i');
	const REVEAL_BUTTON_REGEX = new RegExp(revealButtonPatternSource, 'i');
	const TESTID_REGEX = new RegExp(sensitiveTestidPatternSource, 'i');
	const SENSITIVE_ARIA_REGEX = new RegExp(sensitiveAriaLabelPatternSource, 'i');
	const ARIA_LABEL = new RegExp(ariaPasswordLabelSource, 'i');
	const AUTOCOMPLETE = new RegExp(passwordAutocompleteSource, 'i');

	function getTestId(el: Element): string {
		for (const attr of testidAttrs) {
			const v = el.getAttribute(attr);
			if (v) return v;
		}
		return '';
	}

	function getButtonName(btn: Element): string {
		const aria = btn.getAttribute('aria-label')?.trim();
		if (aria) return aria;
		const inner = (btn as HTMLElement).innerText?.trim();
		if (inner) return inner;
		return btn.textContent?.trim() ?? '';
	}

	function getInnerText(el: Element): string {
		return ((el as HTMLElement).innerText || el.textContent || '').trim();
	}

	function pushDialogText(el: Element, revealPhraseHit: boolean): void {
		if (seenContainers.has(el)) return;
		const text = getInnerText(el);
		if (!text) return;
		seenContainers.add(el);
		dialogTexts.push({ text, revealPhraseHit });
	}

	function hasButtonMatching(scope: Element, regex: RegExp): boolean {
		const btns = scope.querySelectorAll('button, [role="button"]');
		for (const btn of Array.from(btns)) {
			const name = getButtonName(btn);
			if (name && regex.test(name)) return true;
		}
		return false;
	}

	// Walk up to a stable ancestor (form/section/aside/article/main, or 4
	// levels max) so we mask a sensible container — not the entire body.
	function ancestorContainer(start: Element): Element | null {
		const stops = new Set(['FORM', 'SECTION', 'ASIDE', 'ARTICLE', 'MAIN', 'DIV']);
		let cur: Element | null = start;
		let depth = 0;
		while (cur && depth < 4) {
			if (cur.parentElement && stops.has(cur.parentElement.tagName)) {
				return cur.parentElement;
			}
			cur = cur.parentElement;
			depth++;
		}
		return start.parentElement;
	}

	// Pass A — password-shaped <input> values
	try {
		const inputs = document.querySelectorAll('input');
		for (const el of Array.from(inputs)) {
			const t = (el.type || '').toLowerCase();
			const aria = el.getAttribute('aria-label') ?? '';
			const ac = el.getAttribute('autocomplete') ?? '';
			const tid = getTestId(el);
			const readOnly = el.hasAttribute('readonly') || el.hasAttribute('disabled');
			const noSpell = el.getAttribute('spellcheck') === 'false';
			const looksMonospace = readOnly && noSpell && (el.value?.length ?? 0) >= 20;
			const isPwd =
				t === 'password' ||
				ARIA_LABEL.test(aria) ||
				AUTOCOMPLETE.test(ac) ||
				(!!tid && TESTID_REGEX.test(tid)) ||
				looksMonospace;
			if (isPwd && el.value) passwordValues.push(String(el.value));
		}
	} catch {
		// best-effort
	}

	// Pass B — open dialogs, with a reveal-phrase OR copy-button trigger
	try {
		const dialogs = document.querySelectorAll('[role="dialog"], dialog[open]');
		for (const d of Array.from(dialogs)) {
			if ((d as HTMLElement).hidden) continue;
			if (d.getAttribute('aria-hidden') === 'true') continue;

			let hit = false;
			const text = getInnerText(d);
			if (!text) continue;
			for (const r of REVEAL_REGEXES) {
				if (r.test(text)) {
					hit = true;
					break;
				}
			}
			if (!hit) {
				// Locale-agnostic fallback: a copy-action button inside the
				// dialog is a near-universal reveal-flow signal.
				if (hasButtonMatching(d, COPY_REGEX)) hit = true;
			}
			pushDialogText(d, hit);
		}
	} catch {
		// best-effort
	}

	// Pass C — sensitive test-id containers (data-testid="admin-key" etc.)
	// Treat their text as a reveal context regardless of dialog wrapping or
	// page locale. Skip <input>/<textarea> — already handled in Pass A.
	try {
		const selector = testidAttrs.map((a) => `[${a}]`).join(', ');
		const els = document.querySelectorAll(selector);
		for (const el of Array.from(els)) {
			const tid = getTestId(el);
			if (!tid || !TESTID_REGEX.test(tid)) continue;
			if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') continue;
			pushDialogText(el, true);
		}
	} catch {
		// best-effort
	}

	// Pass D — sensitive aria-label / aria-labelledby containers (Stripe-
	// style "secret key" spans). Treat their text as a reveal context.
	try {
		const labelled = document.querySelectorAll('[aria-label], [aria-labelledby]');
		for (const el of Array.from(labelled)) {
			if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') continue;
			let label = el.getAttribute('aria-label')?.trim() ?? '';
			if (!label) {
				const ref = el.getAttribute('aria-labelledby');
				if (ref) {
					// aria-labelledby may list multiple IDs separated by spaces
					const ids = ref.split(/\s+/).filter(Boolean);
					const parts: string[] = [];
					for (const id of ids) {
						const target = document.getElementById(id);
						if (target) parts.push(getInnerText(target));
					}
					label = parts.join(' ').trim();
				}
			}
			if (!label || !SENSITIVE_ARIA_REGEX.test(label)) continue;
			pushDialogText(el, true);
		}
	} catch {
		// best-effort
	}

	// Pass E — Reveal-button + copy-button container detection (non-dialog
	// pages, e.g. Stripe /keys). For each copy-button, walk to a stable
	// ancestor (Form/Section/Aside/Article/Main/Div within 4 levels). If
	// that ancestor also contains a reveal-button (or a sensitive aria-label
	// element), treat its text as a reveal context. The "+ reveal" join
	// keeps this from triggering on every page that happens to have a
	// "Copy URL" share button.
	try {
		const allButtons = document.querySelectorAll('button, [role="button"]');
		for (const btn of Array.from(allButtons)) {
			const name = getButtonName(btn);
			if (!name || !COPY_REGEX.test(name)) continue;
			const container = ancestorContainer(btn);
			if (!container) continue;
			// Already handled by Pass B / C / D — skip dialogs and sensitive
			// containers we've already pushed.
			if (seenContainers.has(container)) continue;
			if (container.matches('[role="dialog"], dialog[open]')) continue;
			const hasReveal = hasButtonMatching(container, REVEAL_BUTTON_REGEX);
			const hasSensitiveAria = Array.from(
				container.querySelectorAll('[aria-label], [aria-labelledby]'),
			).some((el) => {
				const lbl = el.getAttribute('aria-label')?.trim() ?? '';
				return lbl && SENSITIVE_ARIA_REGEX.test(lbl);
			});
			if (!hasReveal && !hasSensitiveAria) continue;
			pushDialogText(container, true);
		}
	} catch {
		// best-effort
	}

	// Pass F — <code>/<pre>/<kbd> elements inside a sensitive ancestor.
	// Secrets are almost always rendered in monospace. Treat them as reveal
	// context only if a nearby ancestor (4 levels) carries a high-confidence
	// signal: sensitive-testid, sensitive-aria-label, or copy-button. Skip
	// dialog-only ancestors — Pass B already covers those.
	try {
		const codeEls = document.querySelectorAll('code, pre, kbd');
		for (const code of Array.from(codeEls)) {
			let cur: Element | null = code.parentElement;
			let confidence: 'testid' | 'aria' | 'copy' | null = null;
			let depth = 0;
			while (cur && depth < 4 && !confidence) {
				const tid = getTestId(cur);
				if (tid && TESTID_REGEX.test(tid)) {
					confidence = 'testid';
					break;
				}
				const lbl = cur.getAttribute('aria-label')?.trim() ?? '';
				if (lbl && SENSITIVE_ARIA_REGEX.test(lbl)) {
					confidence = 'aria';
					break;
				}
				if (hasButtonMatching(cur, COPY_REGEX)) {
					confidence = 'copy';
					break;
				}
				cur = cur.parentElement;
				depth++;
			}
			if (!confidence) continue;
			pushDialogText(code, true);
		}
	} catch {
		// best-effort
	}

	return { passwordValues, dialogTexts };
}
