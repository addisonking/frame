import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Assets, Texture } from './previewPixi';
import type { PreviewMediaKind } from './previewTypes';

const PREVIEW_IMAGE_LOAD_TIMEOUT_MS = 10_000;

interface LoadPreviewTextureOptions {
	mediaKind?: PreviewMediaKind;
}

function getImageMimeType(filePath: string) {
	const extension = filePath.split('.').pop()?.toLowerCase();

	switch (extension) {
		case 'avif':
			return 'image/avif';
		case 'bmp':
			return 'image/bmp';
		case 'gif':
			return 'image/gif';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'webp':
			return 'image/webp';
		default:
			return 'application/octet-stream';
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);

		promise.then(
			(value) => {
				window.clearTimeout(timeoutId);
				resolve(value);
			},
			(cause: unknown) => {
				window.clearTimeout(timeoutId);
				reject(cause);
			}
		);
	});
}

async function loadPreviewImageTexture(filePath: string) {
	const assetUrl = convertFileSrc(filePath);
	const bytes = await withTimeout(
		readFile(filePath),
		PREVIEW_IMAGE_LOAD_TIMEOUT_MS,
		`Timed out reading preview image: ${filePath}`
	);
	const blob = new Blob([bytes], { type: getImageMimeType(filePath) });
	const image = await withTimeout(
		createImageBitmap(blob),
		PREVIEW_IMAGE_LOAD_TIMEOUT_MS,
		`Timed out decoding preview image: ${filePath}`
	);
	const texture = Texture.from(image, true);

	return { assetUrl, texture };
}

async function loadPreviewAssetTexture(filePath: string) {
	const assetUrl = convertFileSrc(filePath);
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

	if (!(loaded instanceof Texture)) {
		throw new Error('Pixi Assets.load did not return a Texture for preview media');
	}

	return { assetUrl, texture: loaded };
}

export async function loadPreviewTexture(filePath: string, options: LoadPreviewTextureOptions = {}) {
	if (options.mediaKind === 'image') {
		return loadPreviewImageTexture(filePath);
	}

	return loadPreviewAssetTexture(filePath);
}

export async function unloadPreviewAsset(assetUrl: string) {
	try {
		await Assets.unload(assetUrl);
	} catch {
		// Ignore cache unload issues for local media assets.
	}
}

export function getPreviewAssetUrl(filePath: string) {
	return convertFileSrc(filePath);
}
