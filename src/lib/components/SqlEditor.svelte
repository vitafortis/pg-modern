<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView, keymap, placeholder as placeholderExt, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
	import { EditorState, Compartment, Prec } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
	import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
	import { sql, MariaSQL, MySQL, PostgreSQL, SQLite } from '@codemirror/lang-sql';
	import { tags as t } from '@lezer/highlight';
	import { statementAt } from '#lib/sql-split.ts';
	import type { Engine, Flavor } from '#lib/types.ts';

	let {
		value = $bindable(''),
		schema = {},
		engine = 'postgres',
		flavor = null,
		defaultSchema = 'public',
		onrun,
		onsave,
		onexplain
	}: {
		value: string;
		schema?: Record<string, Record<string, string[]>>;
		engine?: Engine;
		flavor?: Flavor | null;
		defaultSchema?: string;
		/** Called with the selection, the statement under the cursor, or (`all`) the whole buffer. */
		onrun: (sql: string, scope: 'selection' | 'statement' | 'all') => void;
		/** ⌘S / Ctrl+S. */
		onsave?: () => void;
		/** Called with the selection or the statement under the cursor (⌥⌘↵ analyzes). */
		onexplain?: (sql: string, analyze: boolean) => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView;
	const language = new Compartment();

	const highlight = HighlightStyle.define([
		{ tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syntax-keyword)', fontWeight: '500' },
		{ tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
		{ tag: [t.number, t.bool, t.null], color: 'var(--syntax-number)' },
		{ tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
		{ tag: [t.typeName, t.standard(t.name)], color: 'var(--syntax-type)' },
		{ tag: [t.function(t.variableName), t.function(t.name)], color: 'var(--syntax-function)' },
		{ tag: t.special(t.name), color: 'var(--foreground)' },
		{ tag: t.operator, color: 'var(--muted-foreground)' }
	]);

	const theme = EditorView.theme({
		'&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--foreground)' },
		'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
		'.cm-content': { padding: '12px 0', caretColor: 'var(--primary)' },
		'.cm-gutters': { backgroundColor: 'var(--surface)', border: 'none', color: 'color-mix(in oklch, var(--muted-foreground) 55%, transparent)' },
		'.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', minWidth: '44px' },
		'.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 45%, transparent)' },
		'.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
		'.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
			backgroundColor: 'color-mix(in oklch, var(--primary) 28%, transparent) !important'
		},
		'&.cm-focused': { outline: 'none' },
		'.cm-matchingBracket': { backgroundColor: 'var(--primary-soft)', outline: '1px solid color-mix(in oklch, var(--primary) 50%, transparent)' },
		'.cm-placeholder': { color: 'var(--muted-foreground)', opacity: '0.6' },
		'.cm-tooltip': { border: '1px solid var(--border)', backgroundColor: 'var(--card)', borderRadius: '10px', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
		'.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '18em' },
		'.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
		'.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary-soft)', color: 'var(--foreground)' },
		'.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal', marginLeft: '8px' }
	});

	const sqlLang = (s: typeof schema, e: Engine, f: Flavor | null, d: string) =>
		sql({ dialect: e === 'mysql' ? (f === 'mariadb' ? MariaSQL : MySQL) : e === 'sqlite' ? SQLite : PostgreSQL, schema: s, defaultSchema: d || undefined, upperCaseKeywords: false });

	/** The selection, or else the statement under the cursor. */
	function current(): { text: string; scope: 'selection' | 'statement' } | null {
		const state = view.state;
		const sel = state.selection.main;
		if (!sel.empty) return { text: state.sliceDoc(sel.from, sel.to), scope: 'selection' };
		const stmt = statementAt(state.doc.toString(), sel.head, engine);
		return stmt ? { text: stmt.text, scope: 'statement' } : null;
	}

	function run(scope: 'statement' | 'all') {
		if (scope === 'all') onrun(view.state.doc.toString(), 'all');
		else {
			const c = current();
			if (c) onrun(c.text, c.scope);
		}
		return true;
	}

	function explain(analyze: boolean) {
		const c = current();
		if (c && onexplain) onexplain(c.text, analyze);
		return true;
	}

	/** Explains the statement under the cursor (or the selection) — for the toolbar button. */
	export function explainCurrent(analyze = false) {
		explain(analyze);
	}

	/** Runs the statement under the cursor (or the selection) — exposed for the toolbar button. */
	export function runCurrent() {
		run('statement');
	}

	export function runAll() {
		run('all');
	}

	export function focus() {
		view?.focus();
	}

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [
					lineNumbers(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					drawSelection(),
					EditorView.lineWrapping,
					history(),
					bracketMatching(),
					closeBrackets(),
					indentOnInput(),
					autocompletion({ activateOnTyping: true }),
					placeholderExt('select * from …   ⌘↵ runs the statement under the cursor'),
					Prec.highest(
						keymap.of([
							{ key: 'Mod-Enter', run: () => run('statement') },
							{ key: 'Shift-Mod-Enter', run: () => run('all') },
							{ key: 'Alt-Mod-Enter', run: () => explain(true) },
							{
								key: 'Mod-s',
								run: () => {
									onsave?.();
									return true;
								},
								preventDefault: true
							}
						])
					),
					keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
					language.of(sqlLang(schema, engine, flavor, defaultSchema)),
					syntaxHighlighting(highlight),
					theme,
					EditorView.updateListener.of((u) => {
						if (u.docChanged) value = u.state.doc.toString();
					})
				]
			})
		});
		return () => view.destroy();
	});

	$effect(() => {
		const lang = sqlLang(schema, engine, flavor, defaultSchema);
		view?.dispatch({ effects: language.reconfigure(lang) });
	});

	// Accept external value changes (e.g. loading from history).
	$effect(() => {
		const v = value;
		if (view && v !== view.state.doc.toString()) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
		}
	});
</script>

<div bind:this={host} class="h-full min-h-0 overflow-hidden"></div>
