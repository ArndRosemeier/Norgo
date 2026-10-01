/**
 * Time of day, celestial bodies, lighting, fog and weather presentation.
 * Time and weather are authoritative on the server; the client feeds them in.
 */
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import type { WorldProfile } from '../world/profile';
import type { WorldGenerator } from '../world/generator';
import { Biome, BIOMES } from '../world/biomes';
import { Sky } from './sky';
import { Water } from './water';
import { caveAmbient } from './skyOcclusion';
import { clamp, lerp, smoothstep } from '../core/math';
import { UNDERWORLD_CEIL } from '../world/constants';

import type { WeatherState, WeatherKind } from '../shared/types';
export type { WeatherState, WeatherKind };

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();

export class Environment {
  readonly sun: SunLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly sky: Sky;
  readonly water: Water;
  readonly fog: THREE.FogExp2;
  /** 0..1 fraction of day (0.25 = sunrise, 0.5 = noon). */
  timeOfDay = 0.32;
  dayCount = 0;
  weather: WeatherState = { kind: 'clear', intensity: 0, windX: 1, windZ: 0.3 };
  /** Smoothed values */
  private underground = 0;
  private biomeFog = new THREE.Color(0.7, 0.8, 0.9);
  private biomeFogDensity = 1;
  private weatherSmooth = 0;
  sunDir = new THREE.Vector3(0, 1, 0);
  /** Global wind for vegetation shaders. */
  readonly wind = { dir: new THREE.Vector2(1, 0.3), strength: 0.3, time: 0 };
  private profile: WorldProfile;
  /** Multiplier on surface fog density (tied to the view distance setting). */
  fogScale = 1;

  constructor(private scene: THREE.Scene, private gen: WorldGenerator) {
    const p = (this.profile = gen.profile);
    this.sun = new SunLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 2;
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a4030, 0.6);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.05);
    scene.add(this.ambient);
    this.fog = new THREE.FogExp2(0xaabbcc, 0.0006);
    scene.fog = this.fog;
    this.sky = new Sky(p);
    scene.add(this.sky.mesh);
    this.water = new Water(gen);
    scene.add(this.water.group);
  }

  /** Sun direction for a time of day, including axial tilt and seasonal-ish wobble. */
  computeSunDir(t: number, out: THREE.Vector3): THREE.Vector3 {
    const ang = (t - 0.25) * Math.PI * 2; // 0 at sunrise
    const tilt = this.profile.axialTilt;
    out.set(Math.cos(ang), Math.sin(ang) * Math.cos(tilt), Math.sin(ang) * Math.sin(tilt) + 0.25);
    return out.normalize();
  }

  update(camera: THREE.Camera, dt: number, worldTime: number) {
    const p = this.profile;
    this.wind.time += dt;
    const sky = this.sky.uniforms;
    sky.uTime.value = worldTime;

    // --- sun & moons
    this.computeSunDir(this.timeOfDay, this.sunDir);
    const sunH = this.sunDir.y;
    const day = smoothstep(-0.12, 0.15, sunH);
    const golden = 1 - smoothstep(0.0, 0.3, Math.abs(sunH));
    (sky.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    sky.uDay.value = day;
    for (let i = 0; i < p.moons.length && i < 3; i++) {
      const m = p.moons[i];
      const a = (this.timeOfDay * m.orbit + m.phase) * Math.PI * 2 + this.dayCount * 0.21 * m.orbit;
      (sky.uMoonDir.value as THREE.Vector3[])[i].set(Math.cos(a), Math.sin(a) * 0.85 + 0.2, Math.sin(a) * 0.4 - 0.3).normalize();
    }

    // --- underground factor (camera)
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const surface = this.gen.heightAt(cx, cz);
    const depth = surface - cy;
    const ug = clamp((depth - 4) / 14, 0, 1);
    this.underground = lerp(this.underground, ug, 1 - Math.exp(-dt * 2));
    const inUw = cy < UNDERWORLD_CEIL + 20 && this.gen.isUnderworld(cx, cy, cz);

    // --- biome fog
    const col = this.gen.cachedColumn(cx, cz);
    const bdef = BIOMES[inUw ? col.uwBiome : col.biome];
    const bdef2 = BIOMES[col.biome2];
    tmpColor.setRGB(...bdef.fogTint, THREE.SRGBColorSpace);
    tmpColor2.setRGB(...bdef2.fogTint, THREE.SRGBColorSpace);
    tmpColor.lerp(tmpColor2, inUw ? 0 : col.blend);
    this.biomeFog.lerp(tmpColor, 1 - Math.exp(-dt * 0.8));
    const bfd = lerp(bdef.fog, bdef2.fog, inUw ? 0 : col.blend);
    this.biomeFogDensity = lerp(this.biomeFogDensity, bfd, 1 - Math.exp(-dt * 0.8));

    // --- weather smoothing
    const wTarget = this.weather.kind === 'clear' ? 0 : this.weather.kind === 'cloudy' ? 0.35 * this.weather.intensity : this.weather.intensity;
    this.weatherSmooth = lerp(this.weatherSmooth, wTarget, 1 - Math.exp(-dt * 0.3));
    sky.uWeather.value = this.weatherSmooth * (this.weather.kind === 'fog' ? 0.3 : 1);

    // --- light colors
    const sunCol = tmpColor.setRGB(...p.sunColor, THREE.SRGBColorSpace);
    const warm = tmpColor2.setRGB(1.0, 0.55, 0.3);
    const sunLightColor = sunCol.clone().lerp(warm, golden * 0.6);
    this.sun.color.copy(sunLightColor);
    this.sun.intensity = 3.2 * smoothstep(-0.04, 0.12, sunH) * (1 - this.weatherSmooth * 0.7);
    // Night: moonlight takes over (dimmer, bluish), using the same light from the brightest moon.
    const moonVis = p.moons.length > 0 && sunH < 0 ? (1 - day) * 0.22 : 0;
    if (sunH < 0.0 && moonVis > 0) {
      const md = (sky.uMoonDir.value as THREE.Vector3[])[0];
      this.sun.position.copy(md).multiplyScalar(100);
      this.sun.color.setRGB(0.55, 0.62, 0.85);
      this.sun.intensity = moonVis * Math.max(0, md.y) * 2;
    } else {
      this.sun.position.copy(this.sunDir).multiplyScalar(100);
    }

    const zen = new THREE.Color().setRGB(...p.skyZenith, THREE.SRGBColorSpace);
    const hor = new THREE.Color().setRGB(...p.skyHorizon, THREE.SRGBColorSpace);
    // Night keeps a cool, readable moonlit ambient (brighter with more moons).
    const nightSky = new THREE.Color(0.32, 0.4, 0.62).multiplyScalar(0.55 + 0.25 * Math.min(2, p.moons.length));
    this.hemi.color.copy(zen).lerp(hor, 0.5).lerp(nightSky, 1 - day).multiplyScalar(lerp(0.32, 1, day));
    this.hemi.groundColor.setRGB(...p.foliage, THREE.SRGBColorSpace).multiplyScalar(0.5 * lerp(0.1, 1, day));
    this.hemi.intensity = lerp(0.9, 0.55, 1 - day) * (1 - this.weatherSmooth * 0.3);
    this.ambient.intensity = 0.07 + 0.03 * day;

    // --- fog
    const fogDay = hor.clone().lerp(this.biomeFog, 0.45);
    const fogNight = new THREE.Color(0.012, 0.016, 0.03);
    const fogCol = fogNight.lerp(fogDay, day);
    fogCol.lerp(new THREE.Color(1.0, 0.6, 0.35), golden * 0.25 * day);
    const weatherFog = this.weather.kind === 'fog' ? this.weather.intensity * 4 : this.weatherSmooth * 1.6;
    let density = 0.00055 * p.fogDensity * this.biomeFogDensity * (1 + weatherFog) * this.fogScale;
    // Underground fog: biome tinted, denser, dark.
    const ugCol = tmpColor.setRGB(...(inUw ? BIOMES[col.uwBiome].fogTint : [0.06, 0.06, 0.07] as [number, number, number]), THREE.SRGBColorSpace).multiplyScalar(inUw ? 0.25 : 0.4);
    fogCol.lerp(ugCol, this.underground);
    density = lerp(density, inUw ? 0.006 : 0.012, this.underground);
    this.fog.color.copy(fogCol);
    this.fog.density = density;
    (sky.uFogColor.value as THREE.Color).copy(fogCol);
    sky.uUnderground.value = this.underground;
    caveAmbient.value.copy(inUw ? new THREE.Color().setRGB(...BIOMES[col.uwBiome].fogTint).multiplyScalar(0.11) : new THREE.Color(0.014, 0.016, 0.022));

    // --- water
    const wu = this.water.uniforms;
    (wu.uSky.value as THREE.Color).copy(hor).lerp(zen, 0.4);
    (wu.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (wu.uSunColor.value as THREE.Color).copy(sunLightColor);
    wu.uDay.value = day;
    (wu.uFogColor.value as THREE.Color).copy(fogCol);
    wu.uFogDensity.value = density;
    this.water.update(camera, dt);
    this.sky.update(camera);

    // --- wind
    const w = this.weather;
    this.wind.dir.set(w.windX, w.windZ).normalize();
    this.wind.strength = 0.25 + this.weatherSmooth * 0.9;
  }

  /** Current surface biome at a point (for audio/UI). */
  biomeName(x: number, y: number, z: number): string {
    if (this.gen.isUnderworld(x, y, z)) return BIOMES[this.gen.cachedColumn(x, z).uwBiome].name;
    const c = this.gen.cachedColumn(x, z);
    if (y < c.height - 12) return 'Caves';
    return BIOMES[c.biome === Biome.Ocean ? c.biome2 : c.biome].name;
  }
}
