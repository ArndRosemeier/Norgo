/**
 * Settlement layout model. Generated deterministically from a SiteInfo by the
 * settlement module; used by the client to build meshes and by the server for
 * NPC agendas (homes, workplaces, beds, markets), collisions and destruction.
 *
 * Everything here is plain JSON-safe data. The pure generators live in
 * `layout.ts` (towns), `poi.ts` (points of interest) and `build/*` (piece
 * blueprints), so server and client derive identical results from the seed.
 */
import type { Vec3 } from '../shared/types';
import type { RaceId } from '../humanoid/types';

export type BuildingRole =
  | 'house' | 'hut' | 'longhouse' | 'tavern' | 'smithy' | 'market' | 'temple' | 'shrine' | 'barracks' | 'watchtower'
  | 'farm' | 'barn' | 'mill' | 'workshop' | 'library' | 'mage_tower' | 'stable' | 'warehouse' | 'hall' | 'burrow'
  | 'tent' | 'well' | 'gate' | 'wall' | 'ruin' | 'camp' | 'monument'
  // Infrastructure (added by the settlements module): bridges where roads cross water, piers on shores.
  | 'bridge' | 'dock';

export type ArchStyle =
  | 'timber' | 'stonekeep' | 'elven' | 'orcish' | 'burrow' | 'goblin' | 'sylvan' | 'drakeborn' | 'umbral' | 'megalith' | 'ruined';

/** A spot NPCs use: bed, work station, seat, shop counter, prayer spot, guard post... */
export interface SmartSpot {
  id: string;
  kind: 'bed' | 'work' | 'seat' | 'counter' | 'pray' | 'guard' | 'cook' | 'drink' | 'read' | 'farm' | 'idle' | 'forge' | 'market';
  pos: Vec3;
  /** Facing (yaw). */
  yaw: number;
  /** Building it belongs to. */
  building?: string;
}

/** Roof families the construction kit knows. */
export type RoofKind = 'gable' | 'hip' | 'conical' | 'dome' | 'mansard' | 'flat' | 'shed' | 'none';

/** Furniture kinds placed by the interior planner (each becomes a destructible piece). */
export type FurnitureKind =
  | 'bed' | 'bunk' | 'table' | 'longtable' | 'chair' | 'stool' | 'bench' | 'hearth' | 'shelf' | 'bookcase' | 'anvil' | 'forge'
  | 'altar' | 'counter' | 'barrel' | 'crate' | 'chest' | 'wardrobe' | 'workbench' | 'cauldron' | 'rack' | 'desk' | 'pew'
  | 'throne' | 'lectern' | 'haybale' | 'millstone' | 'sacks' | 'trough' | 'rug' | 'loom' | 'orb';

/** A furniture item in building-local coordinates (x right, z front = door side, y up from the floor). */
export interface FurnitureInfo {
  kind: FurnitureKind;
  /** Local position (floor level). */
  x: number;
  z: number;
  /** Floor height of the storey it stands on (0 = ground floor). */
  y: number;
  /** Local yaw (0 = faces local +Z, i.e. toward the front door). */
  yaw: number;
  /** Footprint (w along local x before rotation, d along local z). */
  w: number;
  d: number;
}

export interface BuildingInfo {
  id: string;
  role: BuildingRole;
  style: ArchStyle;
  race: RaceId;
  /** Footprint centre and rotation. pos.y is the ground-floor level. */
  pos: Vec3;
  yaw: number;
  /** Footprint size (x = width, z = depth) and height in meters. */
  size: [number, number, number];
  /** Door positions (world). */
  doors: Vec3[];
  spots: SmartSpot[];
  /** Number of residents this building houses. */
  residents: number;
  /** Destructible pieces (ids are stable: `${building.id}:${index}`). */
  pieceCount: number;
  seed: number;

  // ---- optional detail (filled by the settlements module) ----
  /** Storeys above ground. */
  floors?: number;
  roof?: RoofKind;
  /** Secondary style blended in (mixed households: e.g. timber upper floor on a dwarven stone base). */
  style2?: ArchStyle;
  /** Round footprint (towers, tents, mushroom houses, burrows). */
  round?: boolean;
  /** Ground offsets relative to pos.y at the footprint corners (-x-z, +x-z, +x+z, -x+z); ≤ 0 means ground below the floor. */
  ground?: [number, number, number, number];
  /** Furnishing plan (local coordinates). Spots are derived from it. */
  furniture?: FurnitureInfo[];
  /** Household wealth 0..1 (materials, ornaments, number of windows). */
  wealth?: number;
  /** Display name for signs and dialog ("The Gilded Boar", "Temple of the Ember"). */
  title?: string;
  /** District index in mixed settlements (0 = primary culture). */
  district?: number;
  /** Whether the building is part of the fortification ring. */
  fortification?: boolean;
}

/** Small free-standing prop (destructible piece of a prop group). */
export type PropKind =
  | 'barrel' | 'crate' | 'cart' | 'stall' | 'fence' | 'haystack' | 'sign' | 'banner' | 'statue' | 'grave' | 'campfire'
  | 'scarecrow' | 'lamp' | 'bench' | 'woodpile' | 'trough' | 'well' | 'totem' | 'brazier' | 'crystal' | 'mushroom'
  | 'planter' | 'sacks' | 'anvil' | 'rack' | 'boat' | 'tent' | 'standing_stone' | 'gate_fence' | 'pole';

export interface PropInfo {
  /** Stable object id `B:<siteId>:p<group>:<index>`. */
  id: string;
  kind: PropKind;
  pos: Vec3;
  yaw: number;
  /** Uniform scale. */
  scale: number;
  /** Variant seed (shape/colour details). */
  seed: number;
  /** Optional length for linear props (fence runs). */
  len?: number;
  /**
   * Ground profile for linear props: terrain heights relative to pos.y at
   * evenly spaced samples along local x from -len/2 to +len/2 (fence posts).
   */
  ground?: number[];
  style: ArchStyle;
}

/** Cultivated field outside town (rendered as furrows & crops; farm spots line it). */
export interface FieldInfo {
  pos: Vec3;
  yaw: number;
  w: number;
  d: number;
  crop: 'wheat' | 'cabbage' | 'corn' | 'vines' | 'pumpkin' | 'mushroom' | 'flax' | 'fallow';
  seed: number;
}

/** Procedural heraldry of a settlement (banners, shields, signs). */
export interface Heraldry {
  /** Field colours (sRGB hex). */
  field: number;
  field2: number;
  /** Charge colour. */
  charge: number;
  division: 'plain' | 'party' | 'fess' | 'quarterly' | 'chevron' | 'bend' | 'pale' | 'saltire';
  emblem: 'sun' | 'moon' | 'star' | 'tree' | 'tower' | 'hammer' | 'skull' | 'flame' | 'leaf' | 'crown' | 'eye' | 'mountain' | 'boar' | 'wave' | 'cross' | 'crystal';
}

export interface SettlementLayout {
  siteId: string;
  name: string;
  race: RaceId;
  race2: RaceId | null;
  center: Vec3;
  radius: number;
  buildings: BuildingInfo[];
  /** Street polylines (world XZ + y). */
  streets: { points: Vec3[]; width: number }[];
  /** Plaza / market centre. */
  plaza: Vec3;
  walls: boolean;
  /** Free-standing spots (well, campfire, market stalls, fields). */
  spots: SmartSpot[];
  population: number;
  /** Settlement wealth 0..1 and defensive strength 0..1 (shapes NPC jobs & events). */
  wealth: number;
  defense: number;

  // ---- optional detail (filled by the settlements module) ----
  style?: ArchStyle;
  style2?: ArchStyle | null;
  /** Plaza radius (m). */
  plazaRadius?: number;
  props?: PropInfo[];
  fields?: FieldInfo[];
  /** World positions of town gates (walled towns). */
  gates?: Vec3[];
  heraldry?: Heraldry;
  /** Radius around center containing everything (incl. farms, bridges, docks). */
  extent?: number;
  /** Street kinds aligned with `streets` (main / ring / side / lane / plaza). */
  streetKinds?: ('main' | 'ring' | 'side' | 'lane')[];
}

/** Structures at a point of interest (ruins, shrines, camps...). Pieces have ids `P:<poiId>:<index>`. */
export interface PoiLayout {
  poiId: string;
  kind: string;
  center: Vec3;
  /** One pseudo-building record (id `P:<poiId>`, role ruin/shrine/camp/monument...) whose blueprint holds every piece. */
  structure: BuildingInfo;
  spots: SmartSpot[];
  /** Short evocative description for the game master / journal. */
  description: string;
  extent: number;
}
