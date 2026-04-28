import { Application, Container, Graphics, Sprite } from 'pixi.js';

export interface PreviewPixiScene {
	app: Application;
	spriteContainer: Container;
	rotationContainer: Container;
	flipContainer: Container;
	sprite: Sprite;
	cropMask: Graphics;
	cropOverlay: Graphics;
}

export async function createPreviewPixiScene(
	canvas: HTMLCanvasElement,
	width: number,
	height: number,
	resolution: number
): Promise<PreviewPixiScene> {
	const app = new Application();
	await app.init({
		canvas,
		width: Math.max(1, width),
		height: Math.max(1, height),
		resolution,
		autoDensity: true,
		backgroundAlpha: 0,
		antialias: true,
		autoStart: false,
		preference: 'webgpu'
	});

	const spriteContainer = new Container();
	const rotationContainer = new Container();
	const flipContainer = new Container();
	const sprite = new Sprite();
	const cropMask = new Graphics();
	const cropOverlay = new Graphics();
	sprite.anchor.set(0.5);
	sprite.visible = false;
	flipContainer.addChild(sprite);
	rotationContainer.addChild(flipContainer);
	spriteContainer.addChild(rotationContainer);
	spriteContainer.addChild(cropOverlay);
	app.stage.addChild(spriteContainer);
	app.stage.addChild(cropMask);

	return {
		app,
		spriteContainer,
		rotationContainer,
		flipContainer,
		sprite,
		cropMask,
		cropOverlay
	};
}
