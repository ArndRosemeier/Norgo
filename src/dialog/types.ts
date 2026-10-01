/**
 * Dialog presentation model. The dialog system produces DialogView updates for
 * the client; responses come back as choice ids or free text (free text is
 * routed to an LLM-capable brain when configured).
 */
import type { EntityId } from '../shared/types';

export interface DialogChoice {
  id: string;
  text: string;
  /** Hints shown to the player: skill checks, disposition effects, quest markers. */
  hint?: string;
  /** Skill check shown as e.g. "[Persuasion 25]". */
  check?: { skill: string; difficulty: number; chance: number };
  disabled?: boolean;
  /** Ends the conversation. */
  exit?: boolean;
  /** Choice category for UI styling: topic, quest, trade, check, social, back, exit. */
  kind?: 'topic' | 'quest' | 'trade' | 'check' | 'social' | 'back' | 'exit' | 'say';
}

export interface DialogLine {
  speaker: string;
  speakerId?: EntityId;
  text: string;
  mood?: 'neutral' | 'happy' | 'angry' | 'sad' | 'afraid' | 'surprised' | 'disgusted' | 'focused' | 'pain';
}

export interface DialogView {
  sessionId: string;
  npcId: EntityId;
  npcName: string;
  /** Short descriptor, e.g. "Dwarven smith, wary of you". */
  npcTitle: string;
  /**
   * Lines added by this update (the player's echoed choice followed by the
   * NPC's response). The UI appends them to its transcript.
   */
  lines: DialogLine[];
  choices: DialogChoice[];
  /** Free text input allowed (keyword matcher, or the LLM brain when configured). */
  freeText: boolean;
  ended: boolean;
  /** Disposition towards the player -100..100. */
  disposition: number;
  /** Trade window available. */
  canTrade: boolean;

  // ---- optional extensions (dialog module) ----
  /** Waiting for an asynchronous brain (LLM) reply — show a "thinking" indicator. */
  thinking?: boolean;
  /** Which brain produced the reply ('scripted' | 'llm'). */
  brain?: string;
  /** Disposition tier label ("hostile", "cold", "neutral", "warm", "friend"). */
  tier?: string;
  /** The client should open the trade window for this NPC now (send { t: 'trade', npc }). */
  openTrade?: boolean;
}
