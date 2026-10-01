/**
 * Water: an ocean/river plane at sea level and a dark underground sea.
 * A coarse height map baked around the camera gives shoreline foam, depth tint
 * and hides the plane inside caves under dry land.
 */
import * as THREE from 'three';
import type { WorldGenerator } from '../world/generator';
import { SEA_LEVEL, UNDERWORLD_SEA_LEVEL } from '../world/constants';
import { Column } from '../world/generator';

const HM_RES = 128;
const HM_SPAN = 2048; // meters covered by the height map

export class Water {
  readonly group = new THREE.Group();
  readonly surface: THREE.Mesh;
  readonly underSea: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private hmData = new Float32Array(HM_RES * HM_RES);
  private hmBack = new Float32Array(HM_RES * HM_RES);
  private hmTex: THREE.DataTexture;
  private hmCenter = new THREE.Vector2(1e9, 1e9);
  private pendingCenter: THREE.Vector2 | null = null;
  private pendingRow = 0;
  private col = new Column();

  constructor(private gen: WorldGenerator) {
    const p = gen.profile;
    const c = (rgb: [number, number, number]) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    this.hmTex = new THREE.DataTexture(this.hmData, HM_RES, HM_RES, THREE.RedFormat, THREE.FloatType);
    this.hmTex.magFilter = THREE.LinearFilter;
    this.hmTex.minFilter = THREE.LinearFilter;
    this.hmTex.wrapS = this.hmTex.wrapT = THREE.ClampToEdgeWrapping;
    this.hmTex.needsUpdate = true;
    this.uniforms = {
      uTime: { value: 0 },
      uShallow: { value: c(p.waterColor) },
      uDeep: { value: c(p.waterDeep) },
      uSky: { value: new THREE.Color(0.5, 0.7, 0.9) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uHeight: { value: this.hmTex },
      uHmOrigin: { value: new THREE.Vector2(0, 0) },
      uHmSpan: { value: HM_SPAN },
      uLevel: { value: SEA_LEVEL },
      uDay: { value: 1 },
      uUnder: { value: 0 },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.0008 },
      uGlow: { value: 0 },
    };
    const mat = this.makeMaterial(this.uniforms);
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.surface = new THREE.Mesh(geo, mat);
    this.surface.scale.set(24000, 1, 24000);
    this.surface.frustumCulled = false;
    this.surface.renderOrder = 10;
    this.surface.name = 'water';
    this.group.add(this.surface);

    const uu = { ...this.uniforms, uLevel: { value: UNDERWORLD_SEA_LEVEL }, uShallow: { value: new THREE.Color(0.02, 0.08, 0.1) }, uDeep: { value: new THREE.Color(0.0, 0.01, 0.02) }, uGlow: { value: 1 } };
    this.underSea = new THREE.Mesh(geo, this.makeMaterial(uu));
    this.underSea.scale.set(6000, 1, 6000);
    this.underSea.position.y = UNDERWORLD_SEA_LEVEL;
    this.underSea.frustumCulled = false;
    this.underSea.visible = false;
    this.group.add(this.underSea);
  }

  private makeMaterial(uniforms: Record<string, THREE.IUniform>) {
    return new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uLevel, uHmSpan, uDay, uUnder, uFogDensity, uGlow;
        uniform vec3 uShallow, uDeep, uSky, uSunDir, uSunColor, uFogColor;
        uniform sampler2D uHeight;
        uniform vec2 uHmOrigin;
        varying vec3 vW;
        float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
        }
        float waves(vec2 p) {
          float h = 0.0;
          h += sin(dot(p, vec2(0.13, 0.07)) + uTime * 1.1) * 0.5;
          h += sin(dot(p, vec2(-0.09, 0.17)) + uTime * 1.4) * 0.35;
          h += sin(dot(p, vec2(0.31, -0.22)) + uTime * 2.1) * 0.15;
          h += vnoise(p * 0.6 + uTime * 0.35) * 0.4 + vnoise(p * 1.7 - uTime * 0.5) * 0.18 + vnoise(p * 4.1 + uTime * 0.9) * 0.07;
          return h;
        }
        void main() {
          vec2 huv = (vW.xz - uHmOrigin) / uHmSpan + 0.5;
          float ground = -1000.0;
          if (uGlow < 0.5 && huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0) ground = texture2D(uHeight, huv).r;
          // Water does not exist inside dry land (caves below sea level).
          if (ground > uLevel + 2.5) discard;
          float depth = max(uLevel - ground, 0.0);
          vec3 camToP = vW - cameraPosition;
          float dist = length(camToP);
          vec3 V = -camToP / dist;
          float e = 0.35;
          float h0 = waves(vW.xz), hx = waves(vW.xz + vec2(e, 0.0)), hz = waves(vW.xz + vec2(0.0, e));
          float amp = mix(0.55, 0.15, smoothstep(30.0, 600.0, dist));
          vec3 N = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
          if (V.y < 0.0) N = -N; // seen from below
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 base = mix(uShallow, uDeep, smoothstep(0.0, 18.0, depth));
          vec3 sky = uSky * mix(0.08, 1.0, uDay);
          vec3 col = mix(base * mix(0.15, 1.0, uDay), sky, fres * 0.85);
          vec3 Hs = normalize(V + normalize(uSunDir));
          float spec = pow(max(dot(N, Hs), 0.0), 220.0) * 6.0 * smoothstep(-0.05, 0.05, uSunDir.y);
          col += uSunColor * spec;
          // Shore foam.
          float foam = smoothstep(1.4, 0.0, depth) * (0.55 + 0.45 * sin(uTime * 1.5 + depth * 6.0 + vnoise(vW.xz * 0.3) * 6.0));
          col = mix(col, vec3(0.9, 0.95, 1.0) * mix(0.2, 1.0, uDay), clamp(foam, 0.0, 1.0) * 0.6 * step(-500.0, ground));
          // Bioluminescence in the underground sea.
          if (uGlow > 0.5) {
            float b = smoothstep(0.82, 1.0, vnoise(vW.xz * 0.25 + uTime * 0.05)) * (0.5 + 0.5 * sin(uTime * 2.0 + vW.x));
            col += vec3(0.1, 0.6, 0.8) * b * 0.6;
          }
          float alpha = mix(0.55, 0.96, smoothstep(0.0, 6.0, depth));
          alpha = max(alpha, fres);
          // Fog.
          float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
          col = mix(col, uFogColor, f);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  /** Per-frame update. Height map is rebuilt progressively when the camera moves far. */
  update(camera: THREE.Camera, dt: number) {
    this.uniforms.uTime.value += dt;
    const cx = Math.round(camera.position.x / 128) * 128;
    const cz = Math.round(camera.position.z / 128) * 128;
    this.surface.position.set(camera.position.x, SEA_LEVEL, camera.position.z);
    this.underSea.position.set(camera.position.x, UNDERWORLD_SEA_LEVEL, camera.position.z);
    this.underSea.visible = camera.position.y < UNDERWORLD_SEA_LEVEL + 160;
    this.surface.visible = camera.position.y > -90;
    if (!this.pendingCenter && Math.hypot(cx - this.hmCenter.x, cz - this.hmCenter.y) > 256) {
      this.pendingCenter = new THREE.Vector2(cx, cz);
      this.pendingRow = 0;
    }
    if (this.pendingCenter) {
      const rows = this.hmCenter.x > 1e8 ? HM_RES : 6;
      const pc = this.pendingCenter;
      for (let r = 0; r < rows && this.pendingRow < HM_RES; r++, this.pendingRow++) {
        const z = pc.y + ((this.pendingRow + 0.5) / HM_RES - 0.5) * HM_SPAN;
        for (let i = 0; i < HM_RES; i++) {
          const x = pc.x + ((i + 0.5) / HM_RES - 0.5) * HM_SPAN;
          this.hmBack[i + this.pendingRow * HM_RES] = this.gen.column(x, z, this.col, false, false).height;
        }
      }
      if (this.pendingRow >= HM_RES) {
        this.hmData.set(this.hmBack);
        this.hmTex.needsUpdate = true;
        this.hmCenter.copy(pc);
        (this.uniforms.uHmOrigin.value as THREE.Vector2).copy(pc);
        this.pendingCenter = null;
      }
    }
  }
}
