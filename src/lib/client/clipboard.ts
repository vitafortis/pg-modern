import { toast } from './state.svelte.ts';

/**
 * Copies text, falling back to a hidden textarea where the async clipboard API is
 * missing (plain-http homelab addresses aren't a secure context).
 */
export async function copyText(text: string, label = 'Copied to clipboard'): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
		} else {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand('copy');
			ta.remove();
			if (!ok) throw new Error('copy failed');
		}
		toast('success', label);
		return true;
	} catch {
		toast('error', 'Could not copy to the clipboard');
		return false;
	}
}
