/**
 * Procedural sky dome: atmospheric gradient, sun, moons with phases, planetary
 * rings, stars, aurora and animated cloud layer — all driven by the world profile.
 */
import * as THREE from 'three';
import type { WorldProfile } from '../world/profile';

const MAX_MOONS = 3;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(profile: WorldProfile) {
    const moons = profile.moons.slice(0, MAX_MOONS);
    const c = (rgb: [number, number, number]) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uZenith: { value: c(profile.skyZenith) },
      uHorizon: { value: c(profile.skyHorizon) },
      uSunColor: { value: c(profile.sunColor) },
      uSunSize: { value: profile.sunSize },
      uDay: { value: 1 },
      uTime: { value: 0 },
      uMoonCount: { value: moons.length },
      uMoonDir: { value: [0, 1, 2].map(() => new THREE.Vector3(0, 1, 0)) },
      uMoonColor: { value: [0, 1, 2].map((i) => (moons[i] ? c(moons[i].color) : new THREE.Color())) },
      uMoonSize: { value: [0, 1, 2].map((i) => moons[i]?.size ?? 0) },
      uRings: { value: profile.hasRings ? 1 : 0 },
      uRingTilt: { value: profile.ringTilt },
      uRingColor: { value: c(profile.ringColor) },
      uStars: { value: profile.starDensity },
      uAurora: { value: profile.auroraStrength },
      uCloudCover: { value: profile.cloudCover },
      uCloudColor: { value: c(profile.cloudColor) },
      uUnderground: { value: 0 },
      uFogColor: { value: new THREE.Color() },
      uWeather: { value: 0 },
      uSeed: { value: (profile.seed % 1000) / 10 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
          gl_Position = p;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir, uZenith, uHorizon, uSunColor, uRingColor, uCloudColor, uFogColor;
        uniform float uSunSize, uDay, uTime, uRings, uRingTilt, uStars, uAurora, uCloudCover, uUnderground, uWeather, uSeed;
        uniform int uMoonCount;
        uniform vec3 uMoonDir[${MAX_MOONS}];
        uniform vec3 uMoonColor[${MAX_MOONS}];
        uniform float uMoonSize[${MAX_MOONS}];
        varying vec3 vDir;

        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
          return s;
        }

        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 sun = normalize(uSunDir);
          float sunH = sun.y;
          float day = smoothstep(-0.18, 0.12, sunH);
          float dusk = (1.0 - smoothstep(0.0, 0.35, abs(sunH + 0.02))) ;

          // Base gradient.
          float t = pow(max(h, 0.0), 0.45);
          vec3 dayCol = mix(uHorizon, uZenith, t);
          vec3 nightCol = mix(vec3(0.015, 0.02, 0.04), vec3(0.002, 0.004, 0.012), t) + uZenith * 0.02;
          vec3 col = mix(nightCol, dayCol, day);

          // Sunset halo.
          float sd = max(dot(d, sun), 0.0);
          vec3 duskCol = mix(vec3(1.0, 0.45, 0.18), uSunColor, 0.35);
          col += duskCol * dusk * pow(sd, 6.0) * 0.9 * (1.0 - t * 0.6);
          col += duskCol * dusk * (1.0 - smoothstep(0.0, 0.35, h)) * 0.35 * (0.4 + 0.6 * pow(sd, 2.0));
          // Mie glow around sun.
          col += uSunColor * pow(sd, 80.0) * 0.6 * (0.3 + day);

          // Below horizon: fade to fog/ground color.
          col = mix(col, uFogColor, smoothstep(0.0, -0.12, h));

          // Stars.
          float night = 1.0 - day;
          if (night > 0.01 && h > -0.05) {
            vec3 sp = d * 280.0;
            vec3 cell = floor(sp);
            float r = hash(cell + uSeed);
            float star = step(1.0 - 0.012 * uStars, r);
            vec3 f = fract(sp) - 0.5;
            float tw = 0.7 + 0.3 * sin(uTime * 3.0 + r * 100.0);
            float br = star * smoothstep(0.25, 0.0, length(f)) * tw;
            vec3 sc = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), hash(cell * 1.3));
            col += sc * br * night * 2.0;
            // Milky band.
            float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.2, 1.0))) * 3.5, 2.0));
            col += vec3(0.05, 0.05, 0.08) * band * fbm(d.xz * 9.0 + d.y * 4.0) * night * uStars;
          }

          // Aurora.
          if (uAurora > 0.0 && night > 0.05 && h > 0.0) {
            vec2 ap = d.xz / (h + 0.25);
            float a = 0.0;
            for (int i = 0; i < 3; i++) {
              float fi = float(i);
              float curtain = sin(ap.x * (1.3 + fi * 0.4) + fbm(ap * 0.6 + uTime * 0.02 + fi) * 4.0 + uTime * 0.1);
              a += smoothstep(0.85, 1.0, curtain) * (1.0 - smoothstep(0.0, 0.8, h)) * smoothstep(0.02, 0.15, h);
            }
            vec3 ac = mix(vec3(0.1, 1.0, 0.5), vec3(0.6, 0.2, 1.0), clamp(h * 2.0, 0.0, 1.0));
            col += ac * a * uAurora * night * 0.6;
          }

          // Planetary rings.
          if (uRings > 0.5) {
            vec3 rn = normalize(vec3(sin(uRingTilt), cos(uRingTilt) * 0.25, cos(uRingTilt)));
            float plane = dot(d, rn);
            float ang = atan(d.z, d.x);
            float width = 0.035 + 0.01 * sin(ang * 3.0);
            float ring = smoothstep(width, width * 0.6, abs(plane - 0.12)) * step(0.0, h + 0.05);
            float bands = 0.6 + 0.4 * sin((plane - 0.12) * 600.0) * sin((plane - 0.12) * 170.0 + 1.3);
            vec3 rc = uRingColor * ring * bands;
            col = mix(col, rc * (0.25 + 0.75 * max(day, 0.15)), ring * 0.65);
          }

          // Moons with phase lighting.
          for (int i = 0; i < ${MAX_MOONS}; i++) {
            if (i >= uMoonCount) break;
            vec3 md = normalize(uMoonDir[i]);
            float s = uMoonSize[i];
            float cd = dot(d, md);
            float rad = s * 0.5;
            float dist = acos(clamp(cd, -1.0, 1.0));
            if (dist < rad) {
              // Reconstruct sphere normal on the disk.
              vec3 tx = normalize(cross(md, vec3(0.0, 1.0, 0.0)) + 1e-4);
              vec3 ty = cross(tx, md);
              vec2 uv = vec2(dot(d - md * cd, tx), dot(d - md * cd, ty)) / rad;
              float z = sqrt(max(0.0, 1.0 - dot(uv, uv)));
              vec3 n = normalize(tx * uv.x + ty * uv.y - md * z);
              float lit = max(dot(n, -sun) * -1.0, 0.0);
              lit = max(dot(-n, sun), 0.0);
              float crater = 0.75 + 0.25 * fbm(uv * 4.0 + float(i) * 7.0);
              vec3 mc = uMoonColor[i] * crater * (0.04 + lit * 1.4);
              float edge = smoothstep(rad, rad * 0.97, dist);
              col = mix(col, mc + col * 0.1, edge);
            } else {
              col += uMoonColor[i] * exp(-(dist - rad) * 60.0) * 0.08 * night;
            }
          }

          // Sun disk.
          float sunR = 0.0095 * uSunSize;
          float sdist = acos(clamp(dot(d, sun), -1.0, 1.0));
          float disk = smoothstep(sunR, sunR * 0.85, sdist);
          col += uSunColor * disk * 18.0 * smoothstep(-0.05, 0.02, sunH);

          // Clouds on a virtual plane.
          if (h > 0.0 && uCloudCover > 0.0) {
            vec2 cp = d.xz / (h * 1.6 + 0.08) * 2.2 + vec2(uTime * 0.006, uTime * 0.002);
            float n = fbm(cp + uSeed);
            float n2 = fbm(cp * 2.3 - uTime * 0.004);
            float cover = mix(uCloudCover, 1.0, uWeather);
            float cl = smoothstep(1.0 - cover, 1.0 - cover + 0.35, n * 0.75 + n2 * 0.35);
            float fade = smoothstep(0.0, 0.18, h);
            vec3 lit = uCloudColor * mix(0.08, 1.0, day) + duskCol * dusk * 0.4;
            float shade = 0.65 + 0.35 * smoothstep(0.3, 0.9, n2);
            vec3 cc = lit * shade + uSunColor * pow(sd, 8.0) * 0.4 * day;
            cc = mix(cc, cc * 0.45, uWeather);
            col = mix(col, cc, cl * fade * 0.92);
          }
          // Storm darkening.
          col *= mix(1.0, 0.5, uWeather * day);

          // Underground: no sky.
          col = mix(col, uFogColor, uUnderground);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geo = new THREE.SphereGeometry(1, 48, 24);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.setScalar(5000);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';
  }

  update(camera: THREE.Camera) {
    this.mesh.position.copy(camera.position);
  }
}
