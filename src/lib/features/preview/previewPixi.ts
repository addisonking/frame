import 'pixi.js/unsafe-eval';
import {
	Application,
	Assets,
	Container,
	GpuUboSystem,
	Graphics,
	Sprite,
	Texture,
	WGSL_ALIGN_SIZE_DATA,
	uniformParsers
} from 'pixi.js';

interface PreviewUboElement {
	data: {
		name: string;
		type: string;
		size: number;
		value: unknown;
	};
	offset: number;
}

type PreviewUboUploadFunction = (
	name: string,
	data: Float32Array,
	offset: number,
	uniforms: Record<string, unknown>,
	value: unknown,
	dataInt32: Int32Array | null
) => void;

const previewUboParserFunctions: PreviewUboUploadFunction[] = [
	(name, data, offset, uniforms) => {
		const matrix = (uniforms[name] as { toArray: (transpose: boolean) => number[] }).toArray(true);
		data[offset] = matrix[0];
		data[offset + 1] = matrix[1];
		data[offset + 2] = matrix[2];
		data[offset + 4] = matrix[3];
		data[offset + 5] = matrix[4];
		data[offset + 6] = matrix[5];
		data[offset + 8] = matrix[6];
		data[offset + 9] = matrix[7];
		data[offset + 10] = matrix[8];
	},
	(name, data, offset, uniforms) => {
		const value = uniforms[name] as { x: number; y: number; width: number; height: number };
		data[offset] = value.x;
		data[offset + 1] = value.y;
		data[offset + 2] = value.width;
		data[offset + 3] = value.height;
	},
	(name, data, offset, uniforms) => {
		const value = uniforms[name] as { x: number; y: number };
		data[offset] = value.x;
		data[offset + 1] = value.y;
	},
	(name, data, offset, uniforms) => {
		const value = uniforms[name] as { red: number; green: number; blue: number; alpha: number };
		data[offset] = value.red;
		data[offset + 1] = value.green;
		data[offset + 2] = value.blue;
		data[offset + 3] = value.alpha;
	},
	(name, data, offset, uniforms) => {
		const value = uniforms[name] as { red: number; green: number; blue: number };
		data[offset] = value.red;
		data[offset + 1] = value.green;
		data[offset + 2] = value.blue;
	}
];

const previewUboSingleFunctionsWGSL: Record<string, PreviewUboUploadFunction> = {
	f32: (_name, data, offset, _uniforms, value) => {
		data[offset] = value as number;
	},
	i32: (_name, data, offset, _uniforms, value, dataInt32) => {
		(dataInt32 ?? data)[offset] = value as number;
	},
	u32: (_name, data, offset, _uniforms, value, dataInt32) => {
		(dataInt32 ?? data)[offset] = value as number;
	},
	'vec2<f32>': (_name, data, offset, _uniforms, value) => {
		const vector = value as ArrayLike<number>;
		data[offset] = vector[0];
		data[offset + 1] = vector[1];
	},
	'vec3<f32>': (_name, data, offset, _uniforms, value) => {
		const vector = value as ArrayLike<number>;
		data[offset] = vector[0];
		data[offset + 1] = vector[1];
		data[offset + 2] = vector[2];
	},
	'vec4<f32>': (_name, data, offset, _uniforms, value) => {
		const vector = value as ArrayLike<number>;
		data[offset] = vector[0];
		data[offset + 1] = vector[1];
		data[offset + 2] = vector[2];
		data[offset + 3] = vector[3];
	},
	'vec2<i32>': (_name, data, offset, _uniforms, value, dataInt32) => {
		const vector = value as ArrayLike<number>;
		const target = dataInt32 ?? data;
		target[offset] = vector[0];
		target[offset + 1] = vector[1];
	},
	'vec3<i32>': (_name, data, offset, _uniforms, value, dataInt32) => {
		const vector = value as ArrayLike<number>;
		const target = dataInt32 ?? data;
		target[offset] = vector[0];
		target[offset + 1] = vector[1];
		target[offset + 2] = vector[2];
	},
	'vec4<i32>': (_name, data, offset, _uniforms, value, dataInt32) => {
		const vector = value as ArrayLike<number>;
		const target = dataInt32 ?? data;
		target[offset] = vector[0];
		target[offset + 1] = vector[1];
		target[offset + 2] = vector[2];
		target[offset + 3] = vector[3];
	},
	'vec2<u32>': (_name, data, offset, _uniforms, value, dataInt32) => {
		const vector = value as ArrayLike<number>;
		const target = dataInt32 ?? data;
		target[offset] = vector[0];
		target[offset + 1] = vector[1];
	},
	'vec3<u32>': (_name, data, offset, _uniforms, value, dataInt32) => {
		const vector = value as ArrayLike<number>;
		const target = dataInt32 ?? data;
		target[offset] = vector[0];
		target[offset + 1] = vector[1];
		target[offset + 2] = vector[2];
	},
	'vec4<u32>': (_name, data, offset, _uniforms, value, dataInt32) => {
		const vector = value as ArrayLike<number>;
		const target = dataInt32 ?? data;
		target[offset] = vector[0];
		target[offset + 1] = vector[1];
		target[offset + 2] = vector[2];
		target[offset + 3] = vector[3];
	},
	'mat2x2<f32>': (_name, data, offset, _uniforms, value) => {
		const matrix = value as ArrayLike<number>;
		data[offset] = matrix[0];
		data[offset + 1] = matrix[1];
		data[offset + 2] = matrix[2];
		data[offset + 3] = matrix[3];
	},
	'mat3x3<f32>': (_name, data, offset, _uniforms, value) => {
		const matrix = value as ArrayLike<number>;
		data[offset] = matrix[0];
		data[offset + 1] = matrix[1];
		data[offset + 2] = matrix[2];
		data[offset + 4] = matrix[3];
		data[offset + 5] = matrix[4];
		data[offset + 6] = matrix[5];
		data[offset + 8] = matrix[6];
		data[offset + 9] = matrix[7];
		data[offset + 10] = matrix[8];
	},
	'mat4x4<f32>': (_name, data, offset, _uniforms, value) => {
		const matrix = value as ArrayLike<number>;
		for (let index = 0; index < 16; index += 1) {
			data[offset + index] = matrix[index];
		}
	},
	'mat3x2<f32>': createPreviewMatrixUploadFunction(3, 2),
	'mat4x2<f32>': createPreviewMatrixUploadFunction(4, 2),
	'mat2x3<f32>': createPreviewMatrixUploadFunction(2, 3),
	'mat4x3<f32>': createPreviewMatrixUploadFunction(4, 3),
	'mat2x4<f32>': createPreviewMatrixUploadFunction(2, 4),
	'mat3x4<f32>': createPreviewMatrixUploadFunction(3, 4)
};

function createPreviewMatrixUploadFunction(columns: number, rows: number): PreviewUboUploadFunction {
	return (_name, data, offset, _uniforms, value) => {
		const matrix = value as ArrayLike<number>;
		for (let index = 0; index < columns * rows; index += 1) {
			data[offset + ((index / columns) | 0) * 4 + (index % columns)] = matrix[index];
		}
	};
}

function createPreviewArrayUploadFunction(uboElement: PreviewUboElement): PreviewUboUploadFunction {
	const layout = WGSL_ALIGN_SIZE_DATA[uboElement.data.type];
	const stride = Math.max(layout.size, layout.align) / 4;
	const elementSize = layout.size / 4;
	const useIntData = uboElement.data.type.includes('i32');

	return (_name, data, offset, _uniforms, value, dataInt32) => {
		const source = value as ArrayLike<number>;
		const target = useIntData ? (dataInt32 ?? data) : data;
		let sourceIndex = 0;

		for (let index = 0; index < uboElement.data.size; index += 1) {
			for (let component = 0; component < elementSize; component += 1) {
				target[offset + component] = source[sourceIndex];
				sourceIndex += 1;
			}
			offset += stride;
		}
	};
}

function createPreviewUboSyncPolyfillWGSL(uboElements: PreviewUboElement[]) {
	const functionMap: Record<string, { offset: number; upload: PreviewUboUploadFunction }> = {};
	const parsers = uniformParsers as Array<{
		type: string;
		test: (data: PreviewUboElement['data']) => boolean;
	}>;

	for (const uboElement of uboElements) {
		const uniform = uboElement.data;
		const parserIndex = parsers.findIndex(
			(parser) => uniform.type === parser.type && parser.test(uniform)
		);
		const upload =
			parserIndex >= 0
				? previewUboParserFunctions[parserIndex]
				: uniform.size === 1
					? previewUboSingleFunctionsWGSL[uniform.type]
					: createPreviewArrayUploadFunction(uboElement);
		if (!upload) {
			throw new Error(`[Preview Pixi] Unsupported WebGPU UBO uniform type: ${uniform.type}`);
		}

		functionMap[uniform.name] = {
			offset: uboElement.offset / 4,
			upload
		};
	}

	return (
		uniforms: Record<string, unknown>,
		data: Float32Array,
		dataInt32: Int32Array | null,
		offset = 0
	) => {
		for (const name in functionMap) {
			const entry = functionMap[name];
			entry.upload(name, data, offset + entry.offset, uniforms, uniforms[name], dataInt32);
		}
	};
}

Object.assign(GpuUboSystem.prototype, {
	_generateUboSync: createPreviewUboSyncPolyfillWGSL
});

export { Application, Assets, Container, Graphics, Sprite, Texture };
