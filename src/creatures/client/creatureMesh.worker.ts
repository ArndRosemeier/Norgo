/**
 * Builds high-detail creature meshes off the main thread. The species is
 * regenerated deterministically from the world seed, so only (seed, index,
 * resolution) cross the boundary; geometry comes back as transferable arrays.
 */
import type * as THREE from 'three';
import { createProfile } from '../../world/profile';
import { speciesList } from '../species';
import { buildBody } from '../body';
import { buildCreatureGeometry } from './creatureMesh';

export interface PackedGeometry {
  attributes: { name: string; array: Float32Array | Uint16Array | Uint32Array; itemSize: number; normalized: boolean }[];
  index: Uint16Array | Uint32Array | null;
}

export interface MeshJob {
  id: number;
  seed: number;
  species: number;
  res: number;
}

export interface MeshResult {
  id: number;
  body: PackedGeometry;
  membrane: PackedGeometry | null;
}

const profiles = new Map<number, ReturnType<typeof createProfile>>();

function pack(g: THREE.BufferGeometry, transfer: Transferable[]): PackedGeometry {
  const attributes: PackedGeometry['attributes'] = [];
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const array = a.array as Float32Array | Uint16Array | Uint32Array;
    attributes.push({ name, array, itemSize: a.itemSize, normalized: a.normalized });
    transfer.push(array.buffer);
  }
  const index = g.index ? (g.index.array as Uint16Array | Uint32Array) : null;
  if (index) transfer.push(index.buffer);
  return { attributes, index };
}

self.onmessage = (ev: MessageEvent<MeshJob>) => {
  const job = ev.data;
  let profile = profiles.get(job.seed);
  if (!profile) profiles.set(job.seed, (profile = createProfile(job.seed)));
  const sp = speciesList(profile)[job.species];
  const geo = buildCreatureGeometry(buildBody(sp), job.res);
  const transfer: Transferable[] = [];
  const res: MeshResult = { id: job.id, body: pack(geo.body, transfer), membrane: geo.membrane ? pack(geo.membrane, transfer) : null };
  (self as unknown as Worker).postMessage(res, transfer);
};
