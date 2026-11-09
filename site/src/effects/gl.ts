export type Rgb = [number, number, number];

let colourProbe: CanvasRenderingContext2D | null | undefined;

export function rgbOf(colour: string): Rgb {
  colourProbe ??= document.createElement("canvas").getContext("2d");
  if (!colourProbe) return [0, 0, 0];
  colourProbe.fillStyle = "#000000";
  colourProbe.fillStyle = colour;
  const hex = colourProbe.fillStyle.replace("#", "");
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
}

export const cssValue = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property).trim();
export const cssNumber = (element: Element, property: string, fallback: number) => parseFloat(cssValue(element, property)) || fallback;

function compiled(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export function linkedProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | undefined {
  const vertex = compiled(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compiled(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  const compiledWell = (shader: WebGLShader | null) => shader && gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (program && compiledWell(vertex) && compiledWell(fragment)) {
    gl.attachShader(program, vertex!);
    gl.attachShader(program, fragment!);
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
  }
  const linked = Boolean(program && gl.getProgramParameter(program, gl.LINK_STATUS));
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (linked) return program!;
  gl.deleteProgram(program);
  return undefined;
}

export const quadVertexSource = `
  attribute vec2 corner;
  void main() {
    gl_Position = vec4(corner, 0.0, 1.0);
  }
`;

export function quad(gl: WebGLRenderingContext): WebGLBuffer | null {
  const corners = gl.createBuffer();
  if (!corners) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return corners;
}

export const uniformsOf = <Name extends string>(gl: WebGLRenderingContext, program: WebGLProgram, names: readonly Name[]) =>
  Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<Name, WebGLUniformLocation | null>;

export function texture(gl: WebGLRenderingContext, filter: number): WebGLTexture | null {
  const made = gl.createTexture();
  if (!made) return null;
  gl.bindTexture(gl.TEXTURE_2D, made);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return made;
}

export const deviceScale = () => Math.min(window.devicePixelRatio || 1, 2);

export const noiseSource = `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float layered(vec2 p) {
    float total = 0.0;
    float amount = 0.5;
    for (int octave = 0; octave < 4; octave++) {
      total += amount * noise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      amount *= 0.5;
    }
    return total;
  }

  float bayer2(vec2 a) {
    a = floor(a);
    return fract(dot(a, vec2(0.5, a.y * 0.75)));
  }

  float bayer4(vec2 a) {
    return bayer2(0.5 * a) * 0.25 + bayer2(a);
  }
`;

const softwareRenderers = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export function drawnInSoftware(gl: WebGLRenderingContext): boolean {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (!info) return false;
  return softwareRenderers.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
}
