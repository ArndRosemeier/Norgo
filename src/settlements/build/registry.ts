/**
 * Style registry: dedicated builders (and optional far-LOD silhouettes) per
 * architecture style. Styles without an entry use the generic timber builder.
 */
import type { ArchStyle } from '../types';
import type { Kit } from './kit';
import type { BuildCtx, StyleBuilder } from './common';
import { buildTimber } from './styleTimber';
import { buildElven, silhouetteElven } from './styleElven';
import { buildSylvan, silhouetteSylvan } from './styleSylvan';
import { buildUmbral, silhouetteUmbral } from './styleUmbral';
import { buildOrcish, silhouetteOrcish } from './styleOrcish';
import { buildGoblin, silhouetteGoblin } from './styleGoblin';
import { buildMegalith, silhouetteMegalith } from './styleMegalith';
import { buildBurrow, silhouetteBurrow } from './styleBurrow';
import { buildStonekeep, silhouetteStonekeep } from './styleStonekeep';
import { buildDrakeborn, silhouetteDrakeborn } from './styleDrakeborn';

export const STYLE_BUILDERS: Partial<Record<ArchStyle, StyleBuilder>> = {
  timber: buildTimber,
  elven: buildElven,
  sylvan: buildSylvan,
  umbral: buildUmbral,
  orcish: buildOrcish,
  goblin: buildGoblin,
  megalith: buildMegalith,
  burrow: buildBurrow,
  stonekeep: buildStonekeep,
  drakeborn: buildDrakeborn,
};

export const STYLE_SILHOUETTES: Partial<Record<ArchStyle, (k: Kit, c: BuildCtx) => void>> = {
  elven: silhouetteElven,
  sylvan: silhouetteSylvan,
  umbral: silhouetteUmbral,
  orcish: silhouetteOrcish,
  goblin: silhouetteGoblin,
  megalith: silhouetteMegalith,
  burrow: silhouetteBurrow,
  stonekeep: silhouetteStonekeep,
  drakeborn: silhouetteDrakeborn,
};
