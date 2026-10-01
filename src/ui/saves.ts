/**
 * Save slots in localStorage.
 *  - `norgo.save.<seed>.<name>`      opaque server save string (ServerMessage 'saved')
 *  - `norgo.savemeta.<seed>.<name>`  JSON metadata for the load screen (appearance, world name, time)
 * `<seed>` is the seed exactly as the player typed it (NewGameChoice.seed), matching
 * what the client core writes. Saves without metadata (e.g. dev quick-start) are
 * still listed with what can be recovered from the key.
 */
import type { HumanoidAppearance } from '../humanoid/types';
import { randomAppearance } from '../humanoid/appearance';
import { parseSeed } from '../core/rng';
import { createProfile } from '../world/profile';

export interface SaveMeta {
  /** Seed text as typed (text seeds hash to a number via parseSeed). */
  seedText: string;
  name: string;
  worldName: string;
  appearance: HumanoidAppearance;
  savedAt: number;
  day?: number;
  location?: string;
  level?: number;
  /** True when no metadata was stored and the appearance is a stand-in. */
  partial?: boolean;
}

export interface SaveSlot {
  key: string;
  meta: SaveMeta;
  size: number;
}

const SAVE = 'norgo.save.';
const META = 'norgo.savemeta.';

export function saveKey(seedText: string, name: string): string {
  return `${SAVE}${seedText}.${name}`;
}

export function writeSave(meta: SaveMeta, data: string | null): boolean {
  try {
    if (data !== null) localStorage.setItem(saveKey(meta.seedText, meta.name), data);
    localStorage.setItem(`${META}${meta.seedText}.${meta.name}`, JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

export function readSave(seedText: string, name: string): string | null {
  try {
    return localStorage.getItem(saveKey(seedText, name));
  } catch {
    return null;
  }
}

export function deleteSave(seedText: string, name: string): void {
  try {
    localStorage.removeItem(saveKey(seedText, name));
    localStorage.removeItem(`${META}${seedText}.${name}`);
  } catch {
    /* ignore */
  }
}

/** Find the storage key holding exactly this save payload for a player (written by the core). */
export function findSaveKeyByData(name: string, data: string): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SAVE) && k.endsWith(`.${name}`) && localStorage.getItem(k) === data) return k;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function seedTextFromKey(key: string, name: string): string {
  return key.slice(SAVE.length, key.length - name.length - 1);
}

/** All saves, most recent first. */
export function listSaves(): SaveSlot[] {
  const out: SaveSlot[] = [];
  const seen = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(META)) continue;
      try {
        const meta = JSON.parse(localStorage.getItem(k) ?? '') as SaveMeta;
        const key = saveKey(meta.seedText, meta.name);
        const data = localStorage.getItem(key);
        if (!data) continue;
        seen.add(key);
        out.push({ key, meta, size: data.length });
      } catch {
        /* corrupt meta */
      }
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(SAVE) || seen.has(k)) continue;
      // Metadata-less save: "<seed>.<name>" — assume the seed has no dots.
      const rest = k.slice(SAVE.length);
      const dot = rest.indexOf('.');
      if (dot <= 0) continue;
      const seedText = rest.slice(0, dot), name = rest.slice(dot + 1);
      const data = localStorage.getItem(k) ?? '';
      out.push({
        key: k,
        size: data.length,
        meta: {
          seedText, name, worldName: createProfile(parseSeed(seedText)).name, savedAt: 0, partial: true,
          appearance: randomAppearance('human', parseSeed(seedText + 'hero')),
        },
      });
    }
  } catch {
    /* storage unavailable */
  }
  out.sort((a, b) => b.meta.savedAt - a.meta.savedAt);
  return out;
}
