import { WorldGenerator } from '../src/world/generator';
import { BIOMES } from '../src/world/biomes';
const seed = Number(process.argv[2] ?? 1234);
const t0 = performance.now();
const g = new WorldGenerator(seed);
console.log('profile', g.profile.name, 'weird', g.profile.weirdness.toFixed(2), 'grav', g.profile.baseGravity.toFixed(2), 'biomes', g.profile.biomes.filter(b=>b&&b.weight>0).map(b=>BIOMES[b.id].name).join(','));
console.log('races', g.profile.races.map(r=>r.id).join(','));
const sp = g.findSpawn();
console.log('spawn', sp.map(v=>v.toFixed(1)), 'ms', (performance.now()-t0).toFixed(0));
const cx = Math.floor(sp[0]/32)*32, cy = Math.floor(sp[1]/32)*32, cz=Math.floor(sp[2]/32)*32;
for (const lod of [0,1,2,3,4]) {
  const s = 32<<lod;
  const t = performance.now(); let n=0, uni=0;
  for (let dy=-1; dy<=1; dy++) for (let dx=0; dx<2; dx++) { const c = g.fillChunk(Math.floor(cx/s)*s+dx*s, Math.floor(cy/s)*s+dy*s, Math.floor(cz/s)*s, lod); n++; if (c.uniform) uni++; }
  console.log('lod', lod, 'avg ms', ((performance.now()-t)/n).toFixed(1), 'uniform', uni, '/', n);
}
// height samples
let line=''; for (let i=0;i<60;i++){ const h=g.heightAt(sp[0]+i*40, sp[2]); line+=h.toFixed(0)+' ';} console.log(line);
const t2=performance.now(); let s2=0; for(let i=0;i<2000;i++) s2+=g.density(sp[0]+i*0.37, sp[1]-2+ (i%7), sp[2]); console.log('density() us', ((performance.now()-t2)/2000*1000).toFixed(1));
console.log('gravity', g.gravityAt(sp[0], sp[1], sp[2]).toFixed(2), 'sites near', g.sites.sitesNear(sp[0], sp[2], 2000).map(s=>s.name+':'+s.size+':'+s.race).join(' '));
