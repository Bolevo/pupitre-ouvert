// Learning the text by heart: the level of help of each movement (vanishing cues) and one run
// through the text, typed word by word. Pure logic, no DOM (unit-tested).
//
// One level per movement, the same for all its lines (lines at different levels looked like
// different exercises): 0 every word shown (type over it), 1 every other word, 2 the first word of
// each line, 3 none. A movement typed with 95 % of its words right or more goes up one level,
// below 80 % down one. Light spacing: a level not practised for a while drops by one (GAP_DAYS).
import { ttKey } from '../i18n';
import { norm, type Word } from './text';

export const MAX_LEVEL = 3;
/** Days after which a level drops by one, by level. */
export const GAP_DAYS = [0, 1, 3, 7];
const DAY = 86_400_000;
export const UP_AT = 0.95;
export const DOWN_BELOW = 0.8;

export interface LevelProgress {
  l: number; // level 0..3
  at: number; // last practised (ms)
}

/** The level to practise at now: one less when not practised for a while. */
export function effectiveLevel(p: LevelProgress | undefined, now: number): number {
  if (!p) return 0;
  const l = Math.max(0, Math.min(MAX_LEVEL, Math.round(p.l) || 0));
  return l > 0 && now - p.at > GAP_DAYS[l] * DAY ? l - 1 : l;
}

/** The level after a movement was typed at `lvl` with `ok` words right out of `n`. */
export function nextLevel(lvl: number, ok: number, n: number): number {
  const acc = n ? ok / n : 0;
  if (acc >= UP_AT) return Math.min(MAX_LEVEL, lvl + 1);
  if (acc < DOWN_BELOW) return Math.max(0, lvl - 1);
  return lvl;
}

/** Whether a word is shown as a cue at level `lvl`: `i` is its place in the movement (every
 *  other word, counted through the whole movement), `first` whether it starts its line. */
export function cueShown(lvl: number, i: number, first: boolean): boolean {
  if (lvl <= 0) return true;
  if (lvl === 1) return i % 2 === 0;
  if (lvl === 2) return first;
  return false;
}

/** The help at a level, in words. */
/** The levels of help, by their French names (shown through `tt`). */
export const HELP = [ttKey('texte visible'), ttKey('un mot sur deux'), ttKey('premier mot'), ttKey('aucune')];

export type Mode = 'initials' | 'words';
/** Word states in a run. */
export const PENDING = 0;
export const OK = 1;
export const MISS = 2;

export interface DrillLine {
  id: string;
  words: Word[];
}

/** What a key did. */
export type DrillEvent =
  | { kind: 'none' } // nothing (a key without a letter, the run is over)
  | { kind: 'typed' } // a letter of the word (mode « Mots »), the word goes on
  | { kind: 'wrong' } // a wrong key: the word stays
  | { kind: 'ok' | 'miss'; lineDone: boolean; end: boolean };

/** One run through some lines, in order. */
export class Drill {
  li: number;
  wi = 0;
  /** Typed so far for the current word (mode « Mots »), as typed. */
  typed = '';
  /** Wrong keys on the current word (mode « Initiales »: the second one reveals it). */
  tries = 0;
  /** A wrong letter was typed in the current word (mode « Mots »). */
  slipped = false;
  readonly marks: Uint8Array[];
  streak = 0;
  bestStreak = 0;
  ok = 0;
  miss = 0;
  startedAt = 0;
  endedAt = 0;
  /** Typed from the first word to the last, in one mode, without jumping: only such a run can be
   *  a record. */
  fromStart: boolean;

  /** `from`: the same run typed until now in the other mode: it goes on from the start of its
   *  current line, with the words already typed, missed and counted. */
  constructor(
    readonly lines: DrillLine[],
    readonly mode: Mode,
    private readonly now: () => number = Date.now,
    from?: Drill,
  ) {
    this.marks = lines.map((l) => new Uint8Array(l.words.length));
    this.li = 0;
    if (from && !from.done && from.lines === lines) {
      this.li = from.li;
      for (let i = 0; i < this.li; i++) this.marks[i].set(from.marks[i]);
      for (let i = 0; i < this.li; i++)
        for (const m of this.marks[i]) {
          if (m === OK) this.ok++;
          else this.miss++;
        }
      this.startedAt = from.startedAt;
      this.streak = from.streak;
      this.bestStreak = from.bestStreak;
    }
    // a score typed in two modes is not a record
    this.fromStart = !from || from.done || (from.li === 0 && from.wi === 0);
    this.skipEmpty();
  }

  /** Goes on from the start of line `li` (before or after the current one, or after the end of
   *  the run): the words of that line and of the following ones are typed again (their marks are
   *  cleared), the lines before keep theirs. Not a record any more. */
  jumpTo(li: number) {
    li = Math.max(0, Math.min(this.lines.length - 1, li));
    for (let i = li; i < this.lines.length; i++) {
      for (const m of this.marks[i]) {
        if (m === OK) this.ok--;
        else if (m === MISS) this.miss--;
      }
      this.marks[i].fill(PENDING);
    }
    this.li = li;
    this.wi = 0;
    this.typed = '';
    this.tries = 0;
    this.slipped = false;
    this.streak = 0;
    this.endedAt = 0;
    this.fromStart = false;
    this.skipEmpty();
  }

  get done(): boolean {
    return this.li >= this.lines.length;
  }
  get word(): Word | undefined {
    return this.lines[this.li]?.words[this.wi];
  }
  get total(): number {
    return this.lines.reduce((n, l) => n + l.words.length, 0);
  }
  /** Words before the current one (the place in the text, whatever the start of the run). */
  get position(): number {
    let n = this.wi;
    for (let i = 0; i < Math.min(this.li, this.lines.length); i++) n += this.lines[i].words.length;
    return n;
  }
  /** Words typed or missed so far in this run. */
  get count(): number {
    return this.ok + this.miss;
  }
  missesOf(li: number): number {
    return this.marks[li].reduce((n, m) => n + (m === MISS ? 1 : 0), 0);
  }
  /** Whether the letters typed so far still match the word (mode « Mots »). */
  get typedRight(): boolean {
    const w = this.word;
    return !!w && w.key.startsWith(norm(this.typed));
  }

  /** One typed character. */
  input(ch: string): DrillEvent {
    const w = this.word;
    if (!w) return { kind: 'none' };
    if (ch === '?') return this.reveal();
    if (/\s/.test(ch)) {
      // a space after a word (a habit on a phone) is nothing; with letters typed, it validates
      return this.mode === 'words' && this.typed ? this.submit() : { kind: 'none' };
    }
    const n = norm(ch);
    if (!n) return { kind: 'none' }; // apostrophes, hyphens, punctuation are not typed
    if (!this.startedAt) this.startedAt = this.now();
    if (this.mode === 'initials') {
      if (n[0] === w.key[0]) return this.finish(OK, this.tries > 0); // right at the second try: no streak
      this.tries++;
      return this.tries >= 2 ? this.finish(MISS) : { kind: 'wrong' };
    }
    // a wrong letter is corrected (Backspace) before the next one: the word never runs on in red
    if (!this.typedRight) return { kind: 'wrong' };
    this.typed += ch;
    const t = norm(this.typed);
    if (t === w.key) return this.finish(OK, this.slipped);
    if (w.key.startsWith(t)) return { kind: 'typed' };
    this.slipped = true;
    return { kind: 'wrong' };
  }

  /** Backspace: one letter less (mode « Mots »). */
  backspace(): DrillEvent {
    if (this.mode !== 'words' || !this.typed) return { kind: 'none' };
    this.typed = Array.from(this.typed).slice(0, -1).join('');
    return { kind: 'typed' };
  }

  /** Enter: validates the letters typed (a miss: right, they would have been taken already);
   *  with nothing typed, shows the word (a miss). */
  submit(): DrillEvent {
    if (!this.word) return { kind: 'none' };
    return this.reveal();
  }

  /** Shows the current word: a miss. */
  reveal(): DrillEvent {
    if (!this.word) return { kind: 'none' };
    if (!this.startedAt) this.startedAt = this.now();
    return this.finish(MISS);
  }

  /** `slip`: right after a wrong key (a typo corrected): not an error, but the streak restarts. */
  private finish(mark: number, slip = false): DrillEvent {
    this.marks[this.li][this.wi] = mark;
    if (mark === OK) {
      this.ok++;
      this.streak = slip ? 0 : this.streak + 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.miss++;
      this.streak = 0;
    }
    this.typed = '';
    this.tries = 0;
    this.slipped = false;
    this.wi++;
    let lineDone = false;
    if (this.wi >= this.lines[this.li].words.length) {
      lineDone = true;
      this.li++;
      this.wi = 0;
      this.skipEmpty();
    }
    if (this.done && !this.endedAt) this.endedAt = this.now();
    return { kind: mark === OK ? 'ok' : 'miss', lineDone, end: this.done };
  }

  private skipEmpty() {
    while (this.li < this.lines.length && !this.lines[this.li].words.length) this.li++;
    if (this.done && !this.endedAt && this.startedAt) this.endedAt = this.now();
  }

  /** Share of the words typed right, 0..1. */
  get accuracy(): number {
    return this.count ? this.ok / this.count : 0;
  }
  get elapsed(): number {
    return this.startedAt ? (this.endedAt || this.now()) - this.startedAt : 0;
  }
}

/** A run's score is better than the best one: more accurate, or as accurate and faster. */
export function isBetter(acc: number, ms: number, best: { acc: number; ms: number } | undefined): boolean {
  if (!best) return true;
  const a = Math.round(acc * 1000);
  const b = Math.round(best.acc * 1000);
  return a > b || (a === b && ms < best.ms);
}
