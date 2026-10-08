export function bytes(n: number | null | undefined): string {
	if (n == null) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat();

export const compact = (n: number) => compactFmt.format(n);
export const int = (n: number) => intFmt.format(n);

export function ago(iso: string | null | undefined): string {
	if (!iso) return 'never';
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
	return new Date(iso).toLocaleDateString();
}

export function duration(ms: number): string {
	if (ms < 1) return '<1 ms';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

/** Renders a cell value as display text. */
export function cellText(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

export function csv(fields: string[], rows: unknown[][]): string {
	const esc = (v: unknown) => {
		if (v === null || v === undefined) return '';
		const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
		return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	return [fields.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

export function download(filename: string, content: string, type = 'text/plain') {
	const url = URL.createObjectURL(new Blob([content], { type }));
	const a = Object.assign(document.createElement('a'), { href: url, download: filename });
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const COLORS: Record<string, string> = {
	violet: 'oklch(65% 0.24 292)',
	blue: 'oklch(65% 0.18 250)',
	cyan: 'oklch(75% 0.13 210)',
	green: 'oklch(72% 0.17 155)',
	amber: 'oklch(80% 0.15 75)',
	orange: 'oklch(70% 0.18 45)',
	rose: 'oklch(66% 0.21 15)',
	slate: 'oklch(65% 0.02 260)'
};
