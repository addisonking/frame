<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import PreviewViewport from './PreviewViewport.svelte';
	import PreviewTimeline from './PreviewTimeline.svelte';
	import type { ConversionConfig, CropSettings, MetadataStatus } from '$lib/types';
	import {
		createPreviewCrop,
		createPreviewPlayback,
		createPreviewRenderer
	} from '$lib/features/preview';

	type PreviewMediaKind = 'unknown' | 'video' | 'audio' | 'image';

	let {
		filePath,
		mediaKind,
		metadataStatus = 'idle',
		initialStartTime,
		initialEndTime,
		rotation = '0',
		flipHorizontal = false,
		flipVertical = false,
		onSave,
		onUpdateConfig,
		controlsDisabled = false,
		initialCrop = null,
		sourceWidth,
		sourceHeight
	}: {
		filePath: string;
		mediaKind?: 'video' | 'audio' | 'image';
		metadataStatus?: MetadataStatus;
		initialStartTime?: string;
		initialEndTime?: string;
		rotation?: ConversionConfig['rotation'];
		flipHorizontal?: boolean;
		flipVertical?: boolean;
		onSave: (start?: string, end?: string) => void;
		onUpdateConfig?: (config: Partial<ConversionConfig>) => void;
		controlsDisabled?: boolean;
		initialCrop?: CropSettings | null;
		sourceWidth?: number;
		sourceHeight?: number;
	} = $props();

	const previewMediaKind = $derived<PreviewMediaKind>(
		metadataStatus === 'ready' && mediaKind ? mediaKind : 'unknown'
	);
	const isImage = $derived(previewMediaKind === 'image');
	const trimDisabled = $derived(controlsDisabled || isImage || previewMediaKind === 'unknown');

	const playback = createPreviewPlayback({
		isImage: () => previewMediaKind === 'image',
		onSave: (start, end) => onSave(start, end)
	});

	const crop = createPreviewCrop({
		getRotation: () => rotation,
		getFlipHorizontal: () => flipHorizontal,
		getFlipVertical: () => flipVertical,
		getSourceWidth: () => sourceWidth,
		getSourceHeight: () => sourceHeight,
		getControlsDisabled: () => controlsDisabled,
		onUpdateConfig: (config) => onUpdateConfig?.(config)
	});

	const renderer = createPreviewRenderer();

	$effect(() => {
		const nextStartTime = initialStartTime;
		const nextEndTime = initialEndTime;
		untrack(() => playback.syncInitialValues(nextStartTime, nextEndTime));
	});

	$effect(() => {
		void initialCrop;
		void rotation;
		void flipHorizontal;
		void flipVertical;
		untrack(() => crop.syncInitialCrop(initialCrop));
	});

	$effect(() => {
		const naturalWidth = renderer.naturalWidth;
		const naturalHeight = renderer.naturalHeight;
		untrack(() => crop.setNaturalDimensions(naturalWidth, naturalHeight));
	});

	$effect(() => {
		void filePath;
		void previewMediaKind;
		untrack(() => {
			void renderer.setSource(filePath, previewMediaKind);
		});
	});

	$effect(() => {
		const nextMediaKind = previewMediaKind;
		const nextRotation = rotation;
		const nextFlipHorizontal = flipHorizontal;
		const nextFlipVertical = flipVertical;
		const cropMode = crop.cropMode;
		const appliedCrop = crop.appliedCrop;
		const draftCrop = crop.draftCrop;
		const nextSourceWidth = sourceWidth;
		const nextSourceHeight = sourceHeight;
		untrack(() =>
			renderer.setPresentationState({
				mediaKind: nextMediaKind,
				rotation: nextRotation,
				flipHorizontal: nextFlipHorizontal,
				flipVertical: nextFlipVertical,
				cropMode,
				appliedCrop,
				draftCrop,
				sourceWidth: nextSourceWidth,
				sourceHeight: nextSourceHeight
			})
		);
	});

	onMount(() => {
		return () => {
			playback.destroy();
			crop.destroy();
			renderer.destroy();
		};
	});
</script>

<div class="card-highlight flex h-full flex-col rounded-lg bg-frame-gray-100 p-4 shadow-md">
	<PreviewViewport
		{filePath}
		mediaKind={previewMediaKind}
		{renderer}
		{crop}
		{playback}
		{controlsDisabled}
		{flipHorizontal}
		{flipVertical}
	/>
	<PreviewTimeline {playback} {trimDisabled} {isImage} />
</div>
