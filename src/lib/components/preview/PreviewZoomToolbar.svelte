<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { IconMinus, IconPlus } from '$lib/icons';

	let {
		disabled,
		onZoomIn,
		onZoomOut
	}: {
		disabled: boolean;
		onZoomIn: () => void;
		onZoomOut: () => void;
	} = $props();
</script>

<div
	class="button-highlight pointer-events-auto absolute! right-4 bottom-4 z-40 flex items-center gap-2 rounded-md bg-background p-1 shadow-xl"
	onclick={(event) => event.stopPropagation()}
	onmousedown={(event) => event.stopPropagation()}
	role="presentation"
>
	<Button size="icon" variant="ghost" onclick={onZoomOut} {disabled}>
		<IconMinus size={16} />
	</Button>
	<Button size="icon" variant="ghost" onclick={onZoomIn} {disabled}>
		<IconPlus size={16} />
	</Button>
</div>
