import { convertFileSrc } from '@tauri-apps/api/core';
import { Application, Assets, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { CropRect } from '$lib/utils/crop';

type MediaKind = 'video' | 'audio' | 'image';
const MAX_PREVIEW_DPR = 2;
const DEFAULT_PREVIEW_ZOOM = 1;
const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 8;
const PREVIEW_ZOOM_STEP = 1.18;
const PREVIEW_PAN_OVERSCROLL = 2;
const PREVIEW_TRANSFORM_LERP = 0.2;
const PREVIEW_TRANSFORM_EPSILON = 0.01;

interface PreviewPresentationState {
	mediaKind: MediaKind;
	rotation: '0' | '90' | '180' | '270';
	flipHorizontal: boolean;
	flipVertical: boolean;
	cropMode: boolean;
	appliedCrop: CropRect | null;
	sourceWidth?: number;
	sourceHeight?: number;
}

interface PreviewTransform {
	zoom: number;
	offsetX: number;
	offsetY: number;
}

function getPreviewResolution(): number {
	if (typeof window === 'undefined') return 1;
	return Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_PREVIEW_DPR));
}

function clampValue(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function defaultPreviewTransform(): PreviewTransform {
	return { zoom: DEFAULT_PREVIEW_ZOOM, offsetX: 0, offsetY: 0 };
}

export function createPreviewRenderer() {
	let canvasElement = $state<HTMLCanvasElement | undefined>();
	let wrapperElement = $state<HTMLDivElement | undefined>();
	let app = $state<Application | null>(null);
	let appInitPromise: Promise<void> | null = null;
	let spriteContainer = $state<Container | null>(null);
	let rotationContainer = $state<Container | null>(null);
	let flipContainer = $state<Container | null>(null);
	let sprite = $state<Sprite | null>(null);
	let cropMask = $state<Graphics | null>(null);
	let resizeObserver = $state<ResizeObserver | null>(null);
	let texture = $state<Texture | null>(null);
	let mediaElement = $state<HTMLVideoElement | undefined>();
	let frameLoopCleanup: (() => void) | null = null;
	let currentAssetUrl = $state<string | null>(null);
	let sourceRequestId = 0;
	let naturalWidth = $state(0);
	let naturalHeight = $state(0);
	let wrapperWidth = $state(0);
	let wrapperHeight = $state(0);
	let previewTransform = $state<PreviewTransform>(defaultPreviewTransform());
	let renderedPreviewTransform: PreviewTransform = defaultPreviewTransform();
	let previewTransformFrame = 0;
	let presentation = $state<PreviewPresentationState>({
		mediaKind: 'video',
		rotation: '0',
		flipHorizontal: false,
		flipVertical: false,
		cropMode: false,
		appliedCrop: null
	});

	async function ensureApp() {
		if (!canvasElement || app) return;
		if (appInitPromise) {
			await appInitPromise;
			return;
		}

		appInitPromise = (async () => {
			const nextApp = new Application();
			await nextApp.init({
				canvas: canvasElement,
				width: Math.max(1, wrapperWidth || 1),
				height: Math.max(1, wrapperHeight || 1),
				resolution: getPreviewResolution(),
				autoDensity: true,
				backgroundAlpha: 0,
				antialias: true,
				autoStart: false,
				preference: 'webgpu'
			});

			const nextContainer = new Container();
			const nextRotationContainer = new Container();
			const nextFlipContainer = new Container();
			const nextSprite = new Sprite();
			const nextCropMask = new Graphics();
			nextSprite.anchor.set(0.5);
			nextSprite.visible = false;
			nextFlipContainer.addChild(nextSprite);
			nextRotationContainer.addChild(nextFlipContainer);
			nextContainer.addChild(nextRotationContainer);
			nextApp.stage.addChild(nextContainer);
			nextApp.stage.addChild(nextCropMask);

			app = nextApp;
			spriteContainer = nextContainer;
			rotationContainer = nextRotationContainer;
			flipContainer = nextFlipContainer;
			sprite = nextSprite;
			cropMask = nextCropMask;
			updateScene();
		})();

		try {
			await appInitPromise;
		} finally {
			appInitPromise = null;
		}
	}

	async function clearTexture() {
		frameLoopCleanup?.();
		frameLoopCleanup = null;

		if (mediaElement) {
			mediaElement.pause();
		}

		if (currentAssetUrl) {
			try {
				await Assets.unload(currentAssetUrl);
			} catch {
				// Ignore cache unload issues for local media assets.
			}
		}

		texture?.destroy(false);
		texture = null;
		mediaElement = undefined;
		currentAssetUrl = null;
		naturalWidth = 0;
		naturalHeight = 0;

		if (sprite) {
			sprite.texture = Texture.EMPTY;
			sprite.visible = false;
		}
	}

	function stopPreviewTransformAnimation() {
		if (!previewTransformFrame) return;
		window.cancelAnimationFrame(previewTransformFrame);
		previewTransformFrame = 0;
	}

	function isPreviewTransformSettled() {
		return (
			Math.abs(renderedPreviewTransform.zoom - previewTransform.zoom) <
				PREVIEW_TRANSFORM_EPSILON / 100 &&
			Math.abs(renderedPreviewTransform.offsetX - previewTransform.offsetX) <
				PREVIEW_TRANSFORM_EPSILON &&
			Math.abs(renderedPreviewTransform.offsetY - previewTransform.offsetY) <
				PREVIEW_TRANSFORM_EPSILON
		);
	}

	function startPreviewTransformAnimation() {
		if (previewTransformFrame) return;

		const tick = () => {
			previewTransformFrame = 0;

			renderedPreviewTransform = {
				zoom:
					renderedPreviewTransform.zoom +
					(previewTransform.zoom - renderedPreviewTransform.zoom) * PREVIEW_TRANSFORM_LERP,
				offsetX:
					renderedPreviewTransform.offsetX +
					(previewTransform.offsetX - renderedPreviewTransform.offsetX) * PREVIEW_TRANSFORM_LERP,
				offsetY:
					renderedPreviewTransform.offsetY +
					(previewTransform.offsetY - renderedPreviewTransform.offsetY) * PREVIEW_TRANSFORM_LERP
			};

			if (isPreviewTransformSettled()) {
				renderedPreviewTransform = previewTransform;
				updateScene();
				return;
			}

			updateScene();
			previewTransformFrame = window.requestAnimationFrame(tick);
		};

		previewTransformFrame = window.requestAnimationFrame(tick);
	}

	function applyPreviewTransform(nextTransform: PreviewTransform, immediate = false) {
		previewTransform = clampPreviewTransform(nextTransform);

		if (immediate) {
			stopPreviewTransformAnimation();
			renderedPreviewTransform = previewTransform;
			updateScene();
			return;
		}

		startPreviewTransformAnimation();
	}

	function resetPreviewTransform(immediate = false) {
		applyPreviewTransform(defaultPreviewTransform(), immediate);
	}

	function syncNaturalDimensions() {
		if (!texture) return;
		const width = presentation.sourceWidth ?? texture.source.width;
		const height = presentation.sourceHeight ?? texture.source.height;
		naturalWidth = width || 0;
		naturalHeight = height || 0;
		updateScene();
	}

	function bindTexture(nextTexture: Texture) {
		texture = nextTexture;
		if (nextTexture.source.resource instanceof HTMLVideoElement) {
			mediaElement = nextTexture.source.resource;
			mediaElement.muted = false;
			mediaElement.defaultMuted = false;
			mediaElement.volume = 1;
			mediaElement.loop = false;
			mediaElement.autoplay = false;
			mediaElement.playsInline = true;
			attachFrameLoop(mediaElement);
		} else {
			mediaElement = undefined;
		}

		if (sprite) {
			sprite.texture = nextTexture;
			sprite.visible = true;
		}

		syncNaturalDimensions();
	}

	function attachFrameLoop(video: HTMLVideoElement) {
		frameLoopCleanup?.();
		frameLoopCleanup = null;

		if (typeof video.requestVideoFrameCallback === 'function') {
			let callbackId = 0;

			const onFrame = () => {
				if (!app || mediaElement !== video) return;
				app.render();
				callbackId = video.requestVideoFrameCallback(onFrame);
			};

			const start = () => {
				if (callbackId) return;
				callbackId = video.requestVideoFrameCallback(onFrame);
			};

			const stop = () => {
				if (!callbackId) return;
				video.cancelVideoFrameCallback(callbackId);
				callbackId = 0;
			};
			const renderCurrentFrame = () => app?.render();

			video.addEventListener('play', start);
			video.addEventListener('pause', stop);
			video.addEventListener('ended', stop);
			video.addEventListener('seeking', renderCurrentFrame);
			video.addEventListener('seeked', renderCurrentFrame);
			video.addEventListener('timeupdate', renderCurrentFrame);
			video.addEventListener('loadeddata', renderCurrentFrame);

			if (!video.paused) {
				start();
			}

			frameLoopCleanup = () => {
				stop();
				video.removeEventListener('play', start);
				video.removeEventListener('pause', stop);
				video.removeEventListener('ended', stop);
				video.removeEventListener('seeking', renderCurrentFrame);
				video.removeEventListener('seeked', renderCurrentFrame);
				video.removeEventListener('timeupdate', renderCurrentFrame);
				video.removeEventListener('loadeddata', renderCurrentFrame);
			};
			return;
		}

		let rafId = 0;
		const tick = () => {
			if (!app || mediaElement !== video) return;
			app.render();
			if (!video.paused && !video.ended) {
				rafId = window.requestAnimationFrame(tick);
			}
		};
		const start = () => {
			if (rafId) return;
			rafId = window.requestAnimationFrame(tick);
		};
		const stop = () => {
			if (!rafId) return;
			window.cancelAnimationFrame(rafId);
			rafId = 0;
		};
		const renderCurrentFrame = () => app?.render();

		video.addEventListener('play', start);
		video.addEventListener('pause', stop);
		video.addEventListener('ended', stop);
		video.addEventListener('seeking', renderCurrentFrame);
		video.addEventListener('seeked', renderCurrentFrame);
		video.addEventListener('timeupdate', renderCurrentFrame);
		video.addEventListener('loadeddata', renderCurrentFrame);

		if (!video.paused) {
			start();
		}

		frameLoopCleanup = () => {
			stop();
			video.removeEventListener('play', start);
			video.removeEventListener('pause', stop);
			video.removeEventListener('ended', stop);
			video.removeEventListener('seeking', renderCurrentFrame);
			video.removeEventListener('seeked', renderCurrentFrame);
			video.removeEventListener('timeupdate', renderCurrentFrame);
			video.removeEventListener('loadeddata', renderCurrentFrame);
		};
	}

	async function setSource(filePath: string, mediaKind: MediaKind) {
		const requestId = ++sourceRequestId;
		presentation = { ...presentation, mediaKind };

		if (mediaKind === 'audio') {
			await clearTexture();
			resetPreviewTransform(true);
			return;
		}

		await ensureApp();
		if (requestId !== sourceRequestId) return;

		const assetUrl = convertFileSrc(filePath);
		if (currentAssetUrl === assetUrl && texture) return;

		await clearTexture();
		resetPreviewTransform(true);
		if (requestId !== sourceRequestId) return;

		const loaded = await Assets.load({
			src: assetUrl,
			data: {
				autoPlay: false,
				muted: false,
				loop: false,
				playsinline: true,
				preload: true
			}
		});
		if (requestId !== sourceRequestId) return;

		if (!(loaded instanceof Texture)) {
			throw new Error('Pixi Assets.load did not return a Texture for preview media');
		}

		currentAssetUrl = assetUrl;
		bindTexture(loaded);
	}

	function setPresentationState(nextPresentation: PreviewPresentationState) {
		const shouldResetView =
			presentation.mediaKind !== nextPresentation.mediaKind ||
			presentation.rotation !== nextPresentation.rotation ||
			presentation.flipHorizontal !== nextPresentation.flipHorizontal ||
			presentation.flipVertical !== nextPresentation.flipVertical ||
			presentation.appliedCrop !== nextPresentation.appliedCrop ||
			presentation.sourceWidth !== nextPresentation.sourceWidth ||
			presentation.sourceHeight !== nextPresentation.sourceHeight;

		if (shouldResetView) {
			previewTransform = defaultPreviewTransform();
			renderedPreviewTransform = defaultPreviewTransform();
			stopPreviewTransformAnimation();
		}

		presentation = nextPresentation;
		syncNaturalDimensions();
		updateScene();
	}

	function setCanvasElement(element?: HTMLCanvasElement) {
		canvasElement = element;
		void ensureApp();
	}

	function setWrapperElement(element?: HTMLDivElement) {
		if (wrapperElement === element) return;
		resizeObserver?.disconnect();
		wrapperElement = element;

		if (!wrapperElement) return;

		const updateWrapperSize = () => {
			if (!wrapperElement) return;
			const rect = wrapperElement.getBoundingClientRect();
			wrapperWidth = rect.width;
			wrapperHeight = rect.height;
			if (app) {
				app.renderer.resize(
					Math.max(1, rect.width),
					Math.max(1, rect.height),
					getPreviewResolution()
				);
			}
			updateScene();
		};

		resizeObserver = new ResizeObserver(updateWrapperSize);
		resizeObserver.observe(wrapperElement);
		updateWrapperSize();
		void ensureApp();
	}

	function getSceneMetrics(zoom = previewTransform.zoom) {
		const baseWidth = presentation.sourceWidth ?? naturalWidth;
		const baseHeight = presentation.sourceHeight ?? naturalHeight;
		if (!baseWidth || !baseHeight || !wrapperWidth || !wrapperHeight) return null;

		const cropRect =
			!presentation.cropMode && presentation.appliedCrop
				? presentation.appliedCrop
				: { x: 0, y: 0, width: 1, height: 1 };

		const contentWidth = baseWidth * cropRect.width;
		const contentHeight = baseHeight * cropRect.height;
		const sideRotation = presentation.rotation === '90' || presentation.rotation === '270';
		const visualWidth = sideRotation ? contentHeight : contentWidth;
		const visualHeight = sideRotation ? contentWidth : contentHeight;
		const fitScale = Math.min(wrapperWidth / visualWidth, wrapperHeight / visualHeight);
		const cropCenterX = cropRect.x + cropRect.width / 2 - 0.5;
		const cropCenterY = cropRect.y + cropRect.height / 2 - 0.5;

		return {
			baseWidth,
			baseHeight,
			cropCenterX,
			cropCenterY,
			fitScale,
			displayedWidth: visualWidth * fitScale * zoom,
			displayedHeight: visualHeight * fitScale * zoom
		};
	}

	function clampPreviewTransform(transform: PreviewTransform): PreviewTransform {
		const zoom = clampValue(transform.zoom, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM);
		const metrics = getSceneMetrics(zoom);

		if (!metrics || presentation.cropMode) {
			return { zoom: DEFAULT_PREVIEW_ZOOM, offsetX: 0, offsetY: 0 };
		}

		const maxOffsetX = Math.max(wrapperWidth * PREVIEW_PAN_OVERSCROLL, metrics.displayedWidth) / 2;
		const maxOffsetY =
			Math.max(wrapperHeight * PREVIEW_PAN_OVERSCROLL, metrics.displayedHeight) / 2;

		return {
			zoom,
			offsetX: clampValue(transform.offsetX, -maxOffsetX, maxOffsetX),
			offsetY: clampValue(transform.offsetY, -maxOffsetY, maxOffsetY)
		};
	}

	function setPreviewTransform(nextTransform: PreviewTransform) {
		applyPreviewTransform(nextTransform);
	}

	function zoomPreviewAt(clientX: number, clientY: number, deltaY: number) {
		if (!wrapperElement || presentation.cropMode) return;

		const rect = wrapperElement.getBoundingClientRect();
		if (
			clientX < rect.left ||
			clientX > rect.right ||
			clientY < rect.top ||
			clientY > rect.bottom
		) {
			return;
		}

		const oldZoom = previewTransform.zoom;
		const nextZoom = clampValue(
			oldZoom * (deltaY < 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP),
			MIN_PREVIEW_ZOOM,
			MAX_PREVIEW_ZOOM
		);

		if (nextZoom === oldZoom) return;

		const ratio = nextZoom / oldZoom;
		const pointerX = clientX - rect.left - wrapperWidth / 2;
		const pointerY = clientY - rect.top - wrapperHeight / 2;

		setPreviewTransform({
			zoom: nextZoom,
			offsetX: pointerX - (pointerX - previewTransform.offsetX) * ratio,
			offsetY: pointerY - (pointerY - previewTransform.offsetY) * ratio
		});
	}

	function zoomPreviewBy(direction: 1 | -1) {
		if (presentation.cropMode) return;

		const oldZoom = previewTransform.zoom;
		const nextZoom = clampValue(
			oldZoom * (direction > 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP),
			MIN_PREVIEW_ZOOM,
			MAX_PREVIEW_ZOOM
		);
		const ratio = nextZoom / oldZoom;

		setPreviewTransform({
			zoom: nextZoom,
			offsetX: previewTransform.offsetX * ratio,
			offsetY: previewTransform.offsetY * ratio
		});
	}

	function panPreviewBy(deltaX: number, deltaY: number) {
		if (presentation.cropMode) return;

		setPreviewTransform({
			zoom: previewTransform.zoom,
			offsetX: previewTransform.offsetX + deltaX,
			offsetY: previewTransform.offsetY + deltaY
		});
	}

	function updateScene() {
		if (
			!app ||
			!spriteContainer ||
			!rotationContainer ||
			!flipContainer ||
			!sprite ||
			!texture ||
			!cropMask
		)
			return;

		const effectiveTransform = presentation.cropMode
			? defaultPreviewTransform()
			: clampPreviewTransform(previewTransform);
		if (
			!presentation.cropMode &&
			(effectiveTransform.zoom !== previewTransform.zoom ||
				effectiveTransform.offsetX !== previewTransform.offsetX ||
				effectiveTransform.offsetY !== previewTransform.offsetY)
		) {
			previewTransform = effectiveTransform;
		}

		if (presentation.cropMode) {
			renderedPreviewTransform = defaultPreviewTransform();
		} else {
			renderedPreviewTransform = clampPreviewTransform(renderedPreviewTransform);
		}

		const renderTransform = presentation.cropMode
			? defaultPreviewTransform()
			: renderedPreviewTransform;
		const metrics = getSceneMetrics(renderTransform.zoom);
		if (!metrics) return;

		sprite.texture = texture;
		sprite.width = metrics.baseWidth;
		sprite.height = metrics.baseHeight;
		sprite.position.set(
			-(metrics.cropCenterX * metrics.baseWidth),
			-(metrics.cropCenterY * metrics.baseHeight)
		);
		sprite.visible = true;

		spriteContainer.position.set(
			wrapperWidth / 2 + renderTransform.offsetX,
			wrapperHeight / 2 + renderTransform.offsetY
		);
		spriteContainer.scale.set(
			metrics.fitScale * renderTransform.zoom,
			metrics.fitScale * renderTransform.zoom
		);
		rotationContainer.rotation = (Number(presentation.rotation) * Math.PI) / 180;
		flipContainer.scale.set(
			presentation.flipHorizontal ? -1 : 1,
			presentation.flipVertical ? -1 : 1
		);

		cropMask.clear();
		if (!presentation.cropMode && presentation.appliedCrop) {
			cropMask
				.rect(
					wrapperWidth / 2 + renderTransform.offsetX - metrics.displayedWidth / 2,
					wrapperHeight / 2 + renderTransform.offsetY - metrics.displayedHeight / 2,
					metrics.displayedWidth,
					metrics.displayedHeight
				)
				.fill(0xffffff);
			spriteContainer.mask = cropMask;
		} else {
			spriteContainer.mask = null;
		}

		app.render();
	}

	function destroy() {
		sourceRequestId += 1;
		stopPreviewTransformAnimation();
		resizeObserver?.disconnect();
		void clearTexture();
		app?.destroy(true, { children: true, texture: true });
		app = null;
		spriteContainer = null;
		rotationContainer = null;
		flipContainer = null;
		sprite = null;
		cropMask = null;
	}

	return {
		get mediaElement() {
			return mediaElement;
		},
		get naturalWidth() {
			return naturalWidth;
		},
		get naturalHeight() {
			return naturalHeight;
		},
		get previewZoom() {
			return previewTransform.zoom;
		},
		get hasPreviewTransform() {
			return (
				previewTransform.zoom !== DEFAULT_PREVIEW_ZOOM ||
				previewTransform.offsetX !== 0 ||
				previewTransform.offsetY !== 0
			);
		},
		setCanvasElement,
		setWrapperElement,
		setSource,
		setPresentationState,
		zoomPreviewAt,
		zoomPreviewBy,
		panPreviewBy,
		resetPreviewTransform,
		destroy
	};
}

export type PreviewRendererController = ReturnType<typeof createPreviewRenderer>;
