<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
	// Gradient ids must be unique per instance; the logo appears more than once on some pages.
	const id = $props.id();
</script>

<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
	<defs>
		<linearGradient id="{id}-fill" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="oklch(72% 0.17 292.717)" />
			<stop offset="1" stop-color="oklch(48% 0.25 292.717)" />
		</linearGradient>
		<linearGradient id="{id}-sheen" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.22" />
			<stop offset="0.5" stop-color="#fff" stop-opacity="0" />
		</linearGradient>
	</defs>
	<rect width="32" height="32" rx="9" fill="url(#{id}-fill)" />
	<rect width="32" height="32" rx="9" fill="url(#{id}-sheen)" />
	<!-- Three stacked layers: the data, read from the top. -->
	<g stroke="#fff" stroke-width="1.8" stroke-linejoin="round">
		<path d="M16 24.1 25 19.8 16 15.5 7 19.8Z" fill="none" stroke-opacity="0.45" />
		<path d="M16 21.8 25 17.5 16 13.2 7 17.5Z" fill="none" stroke-opacity="0.7" />
		<path d="M16 16.3 25 12 16 7.7 7 12Z" fill="#fff" stroke="none" />
	</g>
</svg>
