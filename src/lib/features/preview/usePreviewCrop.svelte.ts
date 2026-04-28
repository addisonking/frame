import type { ConversionConfig, CropSettings } from '$lib/types';
import {
	type CropRect,
	type DragHandle,
	MIN_CROP,
	getAspectValue,
	clamp,
	clampRect,
	transformCropRect,
	remapDragDeltas,
	adjustRectToRatio,
	enforceAspect
} from '$lib/utils/crop';

interface PreviewCropOptions {
	getRotation: () => ConversionConfig['rotation'];
	getFlipHorizontal: () => boolean;
	getFlipVertical: () => boolean;
	getSourceWidth: () => number | undefined;
	getSourceHeight: () => number | undefined;
	getControlsDisabled: () => boolean;
	onUpdateConfig?: (config: Partial<ConversionConfig>) => void;
}

export function createPreviewCrop({
	getRotation,
	getFlipHorizontal,
	getFlipVertical,
	getSourceWidth,
	getSourceHeight,
	getControlsDisabled,
	onUpdateConfig
}: PreviewCropOptions) {
	let containerWidth = $state(0);
	let containerHeight = $state(0);
	let videoBounds = $state({ width: 0, height: 0 });
	let naturalWidth = $state(0);
	let naturalHeight = $state(0);

	let cropMode = $state(false);
	let appliedCrop = $state<CropRect | null>(null);
	let draftCrop = $state<CropRect | null>(null);
	let cropAspect = $state<string>('free');
	let cropHandle = $state<DragHandle | null>(null);
	let cropDragOrigin = $state<{
		handle: DragHandle;
		startRect: CropRect;
		startX: number;
		startY: number;
	} | null>(null);

	const isSideRotation = $derived(getRotation() === '90' || getRotation() === '270');

	const hasCropDimensions = $derived.by(() => {
		const baseWidth = getSourceWidth() ?? naturalWidth;
		const baseHeight = getSourceHeight() ?? naturalHeight;
		if (!baseWidth || !baseHeight) return false;
		if (getRotation() === '90' || getRotation() === '270') {
			return Boolean(baseHeight && baseWidth);
		}
		return true;
	});

	const videoStyle = $derived.by(() => {
		if (!containerWidth || !containerHeight) {
			return 'width: 100%; height: 100%;';
		}

		const baseW = getSourceWidth() ?? naturalWidth;
		const baseH = getSourceHeight() ?? naturalHeight;

		if (!baseW || !baseH) {
			return 'width: 100%; height: auto;';
		}

		let targetRect = { x: 0, y: 0, width: 1, height: 1 };

		if (!cropMode && appliedCrop) {
			targetRect = appliedCrop;
		}

		const contentW = baseW * targetRect.width;
		const contentH = baseH * targetRect.height;
		const visualW = isSideRotation ? contentH : contentW;
		const visualH = isSideRotation ? contentW : contentH;
		const scale = Math.min(containerWidth / visualW, containerHeight / visualH);

		return `width: ${visualW * scale}px; height: ${visualH * scale}px;`;
	});

	function setContainerSize(width: number, height: number) {
		containerWidth = width;
		containerHeight = height;
	}

	function setVideoBounds(width: number, height: number) {
		videoBounds = { width, height };
	}

	function setNaturalDimensions(width: number, height: number) {
		naturalWidth = width;
		naturalHeight = height;
	}

	function syncInitialCrop(initialCrop?: CropSettings | null) {
		if (initialCrop?.enabled && initialCrop.sourceWidth && initialCrop.sourceHeight) {
			const rawRect = {
				x: initialCrop.x / initialCrop.sourceWidth,
				y: initialCrop.y / initialCrop.sourceHeight,
				width: initialCrop.width / initialCrop.sourceWidth,
				height: initialCrop.height / initialCrop.sourceHeight
			};

			appliedCrop = clampRect(
				transformCropRect(
					rawRect,
					getRotation(),
					getFlipHorizontal(),
					getFlipVertical(),
					true
				)
			);

			cropAspect = initialCrop.aspectRatio ?? 'free';
		} else if (!cropMode) {
			appliedCrop = null;
			cropAspect = 'free';
		}

		if (!cropMode) {
			draftCrop = null;
		}
	}

	function defaultCropRect(): CropRect {
		return { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
	}

	function getBaseDimensions(rot: ConversionConfig['rotation'] = getRotation()) {
		let baseWidth = getSourceWidth() ?? naturalWidth;
		let baseHeight = getSourceHeight() ?? naturalHeight;
		if (!baseWidth || !baseHeight) return null;
		if (rot === '90' || rot === '270') {
			[baseWidth, baseHeight] = [baseHeight, baseWidth];
		}
		return { width: baseWidth, height: baseHeight };
	}

	function persistCrop(rect: CropRect | null, overrides: Partial<ConversionConfig> = {}) {
		if (!onUpdateConfig) return;

		const nextRotation = overrides.rotation ?? getRotation();
		const nextFlipH = overrides.flipHorizontal ?? getFlipHorizontal();
		const nextFlipV = overrides.flipVertical ?? getFlipVertical();

		if (!rect) {
			onUpdateConfig({ crop: null, ...overrides });
			return;
		}

		const dims = getBaseDimensions(nextRotation);
		if (!dims) return;

		const outputRect = transformCropRect(rect, nextRotation, nextFlipH, nextFlipV, false);

		const payload: CropSettings = {
			enabled: true,
			x: Math.round(outputRect.x * dims.width),
			y: Math.round(outputRect.y * dims.height),
			width: Math.round(outputRect.width * dims.width),
			height: Math.round(outputRect.height * dims.height),
			sourceWidth: dims.width,
			sourceHeight: dims.height,
			aspectRatio: cropAspect === 'free' ? null : cropAspect
		};

		onUpdateConfig({ crop: payload, ...overrides });
	}

	function toggleCropMode() {
		if (getControlsDisabled() || !hasCropDimensions) return;

		if (cropMode) {
			cropMode = false;
			draftCrop = null;
			return;
		}

		cropMode = true;
		draftCrop = appliedCrop ? { ...appliedCrop } : defaultCropRect();
	}

	function selectAspect(id: string) {
		cropAspect = id;
		if (!draftCrop) return;
		if (id === 'free') {
			draftCrop = clampRect({ ...draftCrop });
			return;
		}

		const ratio = getAspectValue(id);
		if (!ratio) return;
		const width = getSourceWidth() ?? naturalWidth;
		const height = getSourceHeight() ?? naturalHeight;
		draftCrop = clampRect(adjustRectToRatio(draftCrop, ratio, width, height, isSideRotation));
	}

	function applyCrop() {
		if (!draftCrop || !hasCropDimensions) return;

		const isFull =
			draftCrop.x <= 0.001 &&
			draftCrop.y <= 0.001 &&
			draftCrop.width >= 0.999 &&
			draftCrop.height >= 0.999;

		if (isFull) {
			persistCrop(null);
			appliedCrop = null;
			cropAspect = 'free';
		} else {
			persistCrop(draftCrop);
			appliedCrop = { ...draftCrop };
		}

		cropMode = false;
		draftCrop = null;
	}

	function resetCropSelection() {
		if (!draftCrop) {
			draftCrop = defaultCropRect();
		} else {
			draftCrop = { x: 0, y: 0, width: 1, height: 1 };
		}

		cropAspect = 'free';
	}

	function handleRotateToggle() {
		if (!onUpdateConfig || getControlsDisabled()) return;
		const rotation = getRotation();
		const steps: ConversionConfig['rotation'][] = ['0', '90', '180', '270'];
		const index = steps.indexOf(rotation);
		const next = steps[(index + 1) % steps.length];

		if (appliedCrop) {
			persistCrop(appliedCrop, { rotation: next });
		} else {
			onUpdateConfig({ rotation: next });
		}
	}

	function toggleFlip(axis: 'horizontal' | 'vertical') {
		if (!onUpdateConfig || getControlsDisabled()) return;

		const nextFlipH = axis === 'horizontal' ? !getFlipHorizontal() : getFlipHorizontal();
		const nextFlipV = axis === 'vertical' ? !getFlipVertical() : getFlipVertical();

		if (appliedCrop) {
			persistCrop(appliedCrop, { flipHorizontal: nextFlipH, flipVertical: nextFlipV });
		} else {
			onUpdateConfig({ flipHorizontal: nextFlipH, flipVertical: nextFlipV });
		}
	}

	function beginCropDrag(handle: DragHandle, event: MouseEvent) {
		if (!draftCrop || !cropMode) return;
		event.preventDefault();
		event.stopPropagation();
		cropHandle = handle;
		cropDragOrigin = {
			handle,
			startRect: { ...draftCrop },
			startX: event.clientX,
			startY: event.clientY
		};
		window.addEventListener('mousemove', handleCropDrag);
		window.addEventListener('mouseup', endCropDrag);
	}

	function handleCropDrag(event: MouseEvent) {
		if (!cropHandle || !cropDragOrigin || !draftCrop || !videoBounds.width || !videoBounds.height) {
			return;
		}

		const normalizedDx = (event.clientX - cropDragOrigin.startX) / videoBounds.width;
		const normalizedDy = (event.clientY - cropDragOrigin.startY) / videoBounds.height;

		const { dx, dy } = remapDragDeltas(
			normalizedDx,
			normalizedDy,
			getRotation(),
			false,
			false
		);

		const startRect = cropDragOrigin.startRect;

		if (cropHandle === 'move') {
			const nextX = clamp(startRect.x + dx, 0, 1 - startRect.width);
			const nextY = clamp(startRect.y + dy, 0, 1 - startRect.height);
			draftCrop = { x: nextX, y: nextY, width: startRect.width, height: startRect.height };
			return;
		}

		const edges = {
			left: startRect.x,
			right: startRect.x + startRect.width,
			top: startRect.y,
			bottom: startRect.y + startRect.height
		};

		if (cropHandle.includes('w')) {
			edges.left = clamp(startRect.x + dx, 0, edges.right - MIN_CROP);
		}
		if (cropHandle.includes('e')) {
			edges.right = clamp(startRect.x + startRect.width + dx, edges.left + MIN_CROP, 1);
		}
		if (cropHandle.includes('n')) {
			edges.top = clamp(startRect.y + dy, 0, edges.bottom - MIN_CROP);
		}
		if (cropHandle.includes('s')) {
			edges.bottom = clamp(startRect.y + startRect.height + dy, edges.top + MIN_CROP, 1);
		}

		let nextRect: CropRect = {
			x: edges.left,
			y: edges.top,
			width: edges.right - edges.left,
			height: edges.bottom - edges.top
		};

		if (cropAspect !== 'free') {
			const ratio = getAspectValue(cropAspect);
			if (ratio) {
				const width = getSourceWidth() ?? naturalWidth;
				const height = getSourceHeight() ?? naturalHeight;
				nextRect = enforceAspect(
					nextRect,
					cropHandle,
					startRect,
					ratio,
					width,
					height,
					isSideRotation
				);
			}
		}

		draftCrop = clampRect(nextRect);
	}

	function endCropDrag() {
		detachCropListeners();
		cropHandle = null;
		cropDragOrigin = null;
	}

	function detachCropListeners() {
		window.removeEventListener('mousemove', handleCropDrag);
		window.removeEventListener('mouseup', endCropDrag);
	}

	function destroy() {
		detachCropListeners();
	}

	return {
		get cropMode() {
			return cropMode;
		},
		get appliedCrop() {
			return appliedCrop;
		},
		get draftCrop() {
			return draftCrop;
		},
		get cropAspect() {
			return cropAspect;
		},
		get videoStyle() {
			return videoStyle;
		},
		get hasCropDimensions() {
			return hasCropDimensions;
		},
		get isSideRotation() {
			return isSideRotation;
		},
		setContainerSize,
		setVideoBounds,
		setNaturalDimensions,
		syncInitialCrop,
		toggleCropMode,
		selectAspect,
		applyCrop,
		resetCropSelection,
		handleRotateToggle,
		toggleFlip,
		beginCropDrag,
		destroy
	};
}

export type PreviewCropController = ReturnType<typeof createPreviewCrop>;
