import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { getPreviewAssetUrl, loadPreviewTexture, unloadPreviewAsset } from './previewAssets';
import { createPreviewPixiScene } from './previewPixiApp';
import {
	DEFAULT_PREVIEW_ZOOM,
	MAX_PREVIEW_ZOOM,
	MIN_PREVIEW_ZOOM,
	PREVIEW_TRANSFORM_EPSILON,
	PREVIEW_TRANSFORM_LERP,
	PREVIEW_ZOOM_STEP,
	clampPreviewTransform,
	clampValue,
	defaultPreviewTransform,
	getPreviewResolution,
	getSceneMetrics
} from './previewScene';
import type {
	PreviewMediaKind,
	PreviewPresentationState,
	PreviewSource,
	PreviewTransform
} from './previewTypes';

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
	let isLoading = $state(false);
	let error = $state<string | null>(null);
	let frameLoopCleanup: (() => void) | null = null;
	let currentAssetUrl = $state<string | null>(null);
	let pendingSource: PreviewSource | null = null;
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

	function getSceneState() {
		return {
			presentation,
			naturalWidth,
			naturalHeight,
			wrapperWidth,
			wrapperHeight
		};
	}

	function resizeAppToWrapper() {
		if (!app || !wrapperWidth || !wrapperHeight) return;

		app.renderer.resize(
			Math.max(1, wrapperWidth),
			Math.max(1, wrapperHeight),
			getPreviewResolution()
		);
	}

	async function ensureApp(): Promise<boolean> {
		if (!canvasElement) return false;
		if (!wrapperElement || !wrapperWidth || !wrapperHeight) return false;
		if (app) return true;
		if (appInitPromise) {
			await appInitPromise;
			return Boolean(app);
		}

		appInitPromise = (async () => {
			const scene = await createPreviewPixiScene(
				canvasElement,
				wrapperWidth,
				wrapperHeight,
				getPreviewResolution()
			);

			app = scene.app;
			spriteContainer = scene.spriteContainer;
			rotationContainer = scene.rotationContainer;
			flipContainer = scene.flipContainer;
			sprite = scene.sprite;
			cropMask = scene.cropMask;
			resizeAppToWrapper();
			updateScene();
		})();

		try {
			await appInitPromise;
		} finally {
			appInitPromise = null;
		}

		return Boolean(app);
	}

	async function clearTexture() {
		frameLoopCleanup?.();
		frameLoopCleanup = null;

		if (mediaElement) {
			mediaElement.pause();
		}

		if (currentAssetUrl) {
			await unloadPreviewAsset(currentAssetUrl);
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

	function getErrorMessage(cause: unknown) {
		return cause instanceof Error ? cause.message : 'Failed to load preview media';
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
		previewTransform = clampPreviewTransform(getSceneState(), nextTransform);

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

	async function setSource(filePath: string, mediaKind: PreviewMediaKind) {
		const requestId = ++sourceRequestId;
		pendingSource = { filePath, mediaKind };
		presentation = { ...presentation, mediaKind };
		error = null;

		if (mediaKind === 'unknown' || mediaKind === 'audio') {
			pendingSource = null;
			isLoading = false;
			await clearTexture();
			resetPreviewTransform(true);
			return;
		}

		if (!canvasElement || !wrapperElement || !wrapperWidth || !wrapperHeight) {
			isLoading = true;
			return;
		}

		const hasApp = await ensureApp();
		if (!hasApp) return;
		if (requestId !== sourceRequestId) return;

		const assetUrl = getPreviewAssetUrl(filePath);
		if (currentAssetUrl === assetUrl && texture) {
			pendingSource = null;
			isLoading = false;
			return;
		}

		isLoading = true;
		try {
			await clearTexture();
			resetPreviewTransform(true);
			if (requestId !== sourceRequestId) return;

			const { texture: loaded } = await loadPreviewTexture(filePath);

			if (requestId !== sourceRequestId) {
				const latestAssetUrl = pendingSource ? getPreviewAssetUrl(pendingSource.filePath) : null;
				if (latestAssetUrl !== assetUrl && currentAssetUrl !== assetUrl) {
					loaded.destroy(false);
					await unloadPreviewAsset(assetUrl);
				}
				return;
			}

			currentAssetUrl = assetUrl;
			pendingSource = null;
			isLoading = false;
			bindTexture(loaded);
		} catch (cause) {
			if (requestId !== sourceRequestId) return;
			isLoading = false;
			error = getErrorMessage(cause);
			pendingSource = null;
			await clearTexture();
			resetPreviewTransform(true);
		}
	}

	function retryPendingSource() {
		if (!pendingSource || pendingSource.mediaKind === 'audio') return;
		if (!canvasElement || !wrapperElement) return;

		const { filePath, mediaKind } = pendingSource;
		void setSource(filePath, mediaKind);
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
		void ensureApp().then(retryPendingSource);
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
				resizeAppToWrapper();
			}
			updateScene();
			void ensureApp().then(retryPendingSource);
		};

		resizeObserver = new ResizeObserver(updateWrapperSize);
		resizeObserver.observe(wrapperElement);
		updateWrapperSize();
		void ensureApp().then(retryPendingSource);
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
			: clampPreviewTransform(getSceneState(), previewTransform);
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
			renderedPreviewTransform = clampPreviewTransform(getSceneState(), renderedPreviewTransform);
		}

		const renderTransform = presentation.cropMode
			? defaultPreviewTransform()
			: renderedPreviewTransform;
		const metrics = getSceneMetrics(getSceneState(), renderTransform.zoom);
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
		get isLoading() {
			return isLoading;
		},
		get error() {
			return error;
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
