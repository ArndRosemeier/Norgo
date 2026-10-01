"""
Stem sets for Norgo's adaptive score.

Every set is one musical "place": a key, mode and tempo shared by all of its
layers, so the game can mix any variation of any layer with any other. Layers:

  drone    sustained harmonic bed (always on while the set plays)
  texture  arpeggios, shimmer, movement without a lead line
  melody   a lead line (comes and goes)
  perc     unpitched rhythm only (activity, towns, combat)

Prompts are written for Stable Audio 3 Small-Music.
"""
from __future__ import annotations

NOTE_HZ = {
    'C': 130.81, 'C#': 138.59, 'D': 146.83, 'D#': 155.56, 'E': 164.81, 'F': 174.61,
    'F#': 185.00, 'G': 196.00, 'G#': 207.65, 'A': 220.00, 'A#': 233.08, 'B': 246.94,
}
NOTE_PC = {n: i for i, n in enumerate(NOTE_HZ)}
MODES = {
    'ionian': [0, 2, 4, 5, 7, 9, 11],
    'dorian': [0, 2, 3, 5, 7, 9, 10],
    'phrygian': [0, 1, 3, 5, 7, 8, 10],
    'lydian': [0, 2, 4, 6, 7, 9, 11],
    'mixolydian': [0, 2, 4, 5, 7, 9, 10],
    'aeolian': [0, 2, 3, 5, 7, 8, 10],
    'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
    'phrygian dominant': [0, 1, 4, 5, 7, 8, 10],
}
# Key names as musicians write them (the model follows 'Eb major' far better than 'D# major').
PROMPT_NOTE = {'C#': 'C#', 'D#': 'Eb', 'F#': 'F#', 'G#': 'Ab', 'A#': 'Bb'}
# How the prompt names the key (the model knows major/minor best).
PROMPT_KEY = {
    'ionian': 'major', 'lydian': 'major', 'mixolydian': 'major',
    'dorian': 'minor', 'phrygian': 'minor', 'aeolian': 'minor',
    'harmonic minor': 'minor', 'phrygian dominant': 'minor',
}

LAYERS = ('drone', 'texture', 'melody', 'perc')
# Layers that must sit exactly on the set's beat grid; the others float in free time.
LOCKED = ('texture', 'perc')
VARIATIONS = {'drone': 2, 'texture': 2, 'melody': 3, 'perc': 2}

# Role wording per layer; {pal} is the set's palette for that layer.
ROLE = {
    'drone': 'sustained ambient drone and slow evolving pad only, {pal}, free time, no rhythm, no drums, no percussion, no melody, harmonic bed',
    'texture': 'gentle repeating arpeggio ostinato only, {pal}, strict tempo, no drums, no lead melody',
    'melody': 'solo lead melody only, {pal}, rubato, free time, expressive phrases with long rests, no drums, no pads, no accompaniment',
    'perc': 'percussion only, {pal}, steady groove, no melodic instruments, no pads, no bass',
}

SETS: dict[str, dict] = {
    # ---- exploration (surface, day)
    'meadow': dict(
        tonic='D', mode='dorian', bpm=76, genre='Pastoral Fantasy Folk',
        mood='warm, hopeful, sunlit open fields',
        pal=dict(drone='warm strings and soft accordion pad', texture='fingerpicked acoustic guitar and celtic harp',
                 melody='wooden flute', perc='soft frame drum and light shaker'),
    ),
    'woodland': dict(
        tonic='G', mode='aeolian', bpm=70, genre='Fantasy Forest Ambient',
        mood='mysterious, green, dappled light, ancient trees',
        pal=dict(drone='low cello and dark string pad', texture='plucked harp and glockenspiel',
                 melody='alto recorder', perc='muted hand drums and wooden clicks'),
    ),
    'jungle': dict(
        tonic='E', mode='phrygian', bpm=88, genre='Exotic Tribal Ambient',
        mood='humid, lush, dense, alive',
        pal=dict(drone='breathy low pad and didgeridoo-like drone', texture='marimba and kalimba patterns',
                 melody='bamboo flute', perc='djembe, talking drum and shakers'),
    ),
    'highland': dict(
        tonic='A', mode='aeolian', bpm=66, genre='Nordic Cinematic Ambient',
        mood='cold, vast, windswept, lonely mountains',
        pal=dict(drone='deep low strings and airy choir pad', texture='nyckelharpa ostinato and bowed psaltery',
                 melody='solo hardanger fiddle', perc='steady frame drum pattern on every beat with soft shaker'),
    ),
    'desert': dict(
        tonic='D', mode='phrygian dominant', bpm=84, genre='Middle Eastern Fantasy',
        mood='hot, shimmering, ancient, sun-scorched',
        pal=dict(drone='oud drone and low string pad', texture='santur and qanun patterns',
                 melody='ney flute', perc='darbuka and riq'),
    ),
    'coast': dict(
        tonic='F', mode='lydian', bpm=70, genre='Airy Fantasy Ambient',
        mood='open sky, sea breeze, floating, bright',
        pal=dict(drone='soft synth pad and gentle strings', texture='harp glissandi and celesta',
                 melody='clarinet', perc='light hand drum groove and brushed snare'),
    ),
    'wonder': dict(
        tonic='E', mode='lydian', bpm=60, genre='Ethereal Ambient',
        mood='magical, crystalline, otherworldly, glowing',
        pal=dict(drone='shimmering glass pad and choir aahs', texture='crystal bells and music box arpeggios',
                 melody='glass harmonica', perc='soft chimes and finger cymbals'),
    ),
    'ember': dict(
        tonic='C', mode='phrygian', bpm=72, genre='Dark Fantasy Ambient',
        mood='ominous, smoldering, volcanic, heavy',
        pal=dict(drone='low brass drone and dark synth pad', texture='low plucked strings and anvil tones',
                 melody='duduk', perc='taiko and deep toms'),
    ),
    # ---- night and below
    'night': dict(
        tonic='C#', mode='aeolian', bpm=60, genre='Nocturnal Fantasy Ambient',
        mood='quiet, starlit, calm but watchful',
        pal=dict(drone='soft string pad and low choir hum', texture='slow piano and harp arpeggios',
                 melody='solo cello', perc='very soft frame drum heartbeat'),
    ),
    'cave': dict(
        tonic='G', mode='phrygian', bpm=56, genre='Dark Cave Ambient',
        mood='enclosed, damp, echoing, tense',
        pal=dict(drone='deep sub drone and bowed metal', texture='dripping marimba and glass tones',
                 melody='distant bass clarinet', perc='sparse low tom hits and stone knocks'),
    ),
    'underglow': dict(
        tonic='D#', mode='lydian', bpm=58, genre='Alien Ethereal Ambient',
        mood='bioluminescent, vast, awe, underground wonder',
        pal=dict(drone='warm evolving synth pad and choir', texture='celesta and hang drum arpeggios',
                 melody='soft theremin-like lead', perc='soft hang drum pulses'),
    ),
    'underdread': dict(
        tonic='F#', mode='phrygian', bpm=64, genre='Dark Horror Ambient',
        mood='dread, ancient bones, fire below, menace',
        pal=dict(drone='low dissonant strings and dark choir', texture='col legno strings and low harp',
                 melody='low horn', perc='slow war drums and metallic hits'),
    ),
    # ---- settlements
    'hearth': dict(
        tonic='G', mode='mixolydian', bpm=96, genre='Medieval Tavern Folk',
        mood='cozy, lively, friendly village',
        pal=dict(drone='hurdy-gurdy drone and warm strings', texture='lute and mandolin strumming',
                 melody='tin whistle', perc='bodhran and tambourine'),
    ),
    'sylvan': dict(
        tonic='E', mode='dorian', bpm=72, genre='Elven Fantasy',
        mood='graceful, serene, timeless, elegant',
        pal=dict(drone='soft strings and ethereal choir pad', texture='celtic harp arpeggios',
                 melody='silver flute', perc='soft finger drums and chimes'),
    ),
    'forge': dict(
        tonic='C', mode='aeolian', bpm=84, genre='Dwarven Fantasy',
        mood='sturdy, proud, deep halls, hammer and stone',
        pal=dict(drone='low brass and deep male choir hum', texture='low strings ostinato',
                 melody='french horn', perc='anvil hits and big low drums'),
    ),
    'wild': dict(
        tonic='A', mode='phrygian', bpm=100, genre='Tribal Fantasy',
        mood='raw, fierce, primal camp',
        pal=dict(drone='throat-singing drone and low strings', texture='plucked bone lyre and rattles',
                 melody='horn call and rough flute', perc='heavy tribal drums and stomps'),
    ),
    # ---- danger
    'combat': dict(
        tonic='D', mode='harmonic minor', bpm=132, genre='Epic Fantasy Battle',
        mood='urgent, intense, driving, heroic danger',
        pal=dict(drone='low brass and tense string tremolo', texture='driving string ostinato',
                 melody='heroic horn and string lead', perc='epic taiko and war drums'),
    ),
    'boss': dict(
        tonic='C', mode='harmonic minor', bpm=140, genre='Dark Epic Orchestral',
        mood='overwhelming, monstrous, climactic',
        pal=dict(drone='massive low brass and dark choir', texture='aggressive staccato strings',
                 melody='brass and choir lead', perc='huge taiko ensemble and anvils'),
    ),
}


PLAIN = {'major': 'ionian', 'minor': 'aeolian'}


def plain_mode(mode: str) -> str:
    """The plain major/minor scale the prompt actually asks for."""
    return PLAIN[PROMPT_KEY[mode]]


def safe_degrees(mode: str) -> list[int]:
    """Scale degrees shared by the set's mode and its plain prompted key: notes that fit
    whether the model played the mode or just plain major/minor."""
    plain = set(MODES[plain_mode(mode)])
    return [d for d in MODES[mode] if d in plain]


def loop_bars(bpm: float, target_s: float = 36.0) -> int:
    """Whole 4-bar phrases giving a loop of roughly target_s seconds."""
    bar = 240.0 / bpm
    return max(8, int(round(target_s / bar / 4)) * 4)


def prompt_for(set_id: str, layer: str) -> str:
    s = SETS[set_id]
    key = f"{PROMPT_NOTE.get(s['tonic'], s['tonic'])} {PROMPT_KEY[s['mode']]}"
    role = ROLE[layer].format(pal=s['pal'][layer])
    head = 'TrackType: Music, VocalType: Instrumental'
    if layer == 'perc':
        return f"{head}, Genre: {s['genre']}, {s['bpm']} BPM, {role}, {s['mood']}, loopable, steady tempo, no intro, no ending"
    return f"{head}, Genre: {s['genre']}, Key: {key}, {s['bpm']} BPM, {role}, {s['mood']}, loopable, steady tempo, no intro, no ending"
