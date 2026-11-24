// The mixer, as track headers in a multitrack editor: one row per voice and the piano. On a phone
// it takes the line's place while open; on a wide screen it unfolds above the controls.
// Eye = the part shown in the line below the pages (a voice or the piano; its notes can be held).
// S = solo (several allowed), M = mute, volume, and the instrument that plays the part.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { INSTRUMENTS, type InstId } from '../audio/instruments';
import type { Movement, Part } from '../pack/types';
import { audibleParts, followPart, lyricVerses, resetSettings, movement, myPart, playing, position, prefs, setLang, setPrefs, setTrack, trackOf, tracksOpen, unmuteAll } from '../state';
import { Icon } from './Icon';
import { setRecOn } from '../rec';
import { ticker } from './timing';
import { releaseFocus, Volume } from './Volume';
import { soundingAt } from '../util/search';
import { appVersion, versionLabel } from '../version';
import { helpPage, LANGS, lang, partLabel, tt, ttKey } from '../i18n';

export function Tracks({ onClose }: { onClose?: () => void }) {
  const mv = movement.value;
  const tracks = prefs.value.tracks;
  const me = myPart.value;
  const meters = useRef(new Map<string, HTMLSpanElement>());
  const [confirmReset, setConfirmReset] = useState(false);
  const byPart = useMemo(() => (mv ? notesByPart(mv) : new Map()), [mv]);
  const version = useMemo(appVersion, []);
  // light a part's meter while it sings
  useEffect(() => {
    let wasOn = new Set<string>();
    const stop = ticker(() => {
      // the list is hidden unless opened (styles.css); nothing to light then. Known from its state,
      // not from the element: reading its layout here made the browser bring the running
      // animations up to date on the main thread four times a second
      if (!meters.current.size || !tracksOpen.value) return 250;
      const on = new Set<string>();
      if (playing.value) {
        const st = position();
        for (const [id, arr] of byPart) if (soundingAt(arr, st)) on.add(id);
      }
      for (const [id, el] of meters.current) {
        const v = on.has(id);
        if (v !== wasOn.has(id)) el.classList.toggle('on', v);
      }
      wasOn = on;
      return playing.value ? 40 : 200;
    });
    return stop;
  }, [byPart]);

  if (!mv) return null;
  const heard = new Set(audibleParts(mv, tracks));
  const changed = mv.parts.some((p) => trackOf(p).solo || trackOf(p).mute || trackOf(p).support);
  const follow = (p: Part) => {
    if (p.id === myPart.value) return;
    followPart(p.id);
  };
  const lines = mv.lyricLines ?? [];
  const shownLine = lyricVerses.value ? lines.find((l) => l.n === lyricVerses.value![0])?.id ?? 'all' : 'all';

  return (
    <section class="tracks" id="pistes" aria-label={tt('Réglages')}>
      <header class="tracks-head">
        <span class="tracks-title">{tt('Réglages')}</span>
        <Volume />
        <div class="seg small" role="group" aria-label={tt('Taille de la ligne du bas')} title={tt('Taille de la ligne du bas')}>
          {[0, 1, 2].map((i) => (
            <button class={prefs.value.laneSize === i ? 'on' : ''} style={{ fontSize: `${10 + i * 3}px` }} onClick={() => setPrefs({ laneSize: i })} aria-label={tt([ttKey('Petite'), ttKey('Moyenne'), ttKey('Grande')][i])}>
              A
            </button>
          ))}
        </div>
        {onClose && (
          <button class="tracks-close" onClick={onClose}>
            {tt('Fermer')}
            <Icon name="close" size={16} />
          </button>
        )}
      </header>
      <div class="track-rows" role="list">
        {mv.parts.map((p) => {
          const trk = trackOf(p);
          const name = partLabel(p.name);
          const isMe = p.id === me;
          const audible = heard.has(p.id);
          return (
            <div role="listitem" class={`track ${isMe ? 'me' : ''} ${audible ? '' : 'silent'}`} key={p.id}>
              <button
                class="t-eye"
                aria-pressed={isMe}
                title={isMe ? tt('{name} est affiché en grand en bas', { name }) : tt('Afficher {name} en grand en bas', { name })}
                aria-label={tt('Suivre {name}', { name })}
                onClick={() => follow(p)}
              >
                <Icon name={isMe ? 'eye' : 'eye-off'} size={18} />
              </button>
              <button class="t-name" onClick={() => follow(p)} title={tt('Suivre {name}', { name })}>
                <span
                  class="t-meter"
                  ref={(el) => {
                    if (el) meters.current.set(p.id, el);
                    else meters.current.delete(p.id);
                  }}
                />
                {name}
              </button>
              <button
                class={`t-btn solo ${trk.solo ? 'on' : ''}`}
                aria-pressed={trk.solo}
                title={tt('Solo : n’entendre que les voix en solo (enlève le muet)')}
                aria-label={tt('Solo {name}', { name })}
                onClick={() => setTrack(p, { solo: !trk.solo })}
              >
                S
              </button>
              <button
                class={`t-btn mute ${trk.mute ? 'on' : ''}`}
                aria-pressed={trk.mute}
                title={tt('Muet (enlève le solo)')}
                aria-label={tt('Muet {name}', { name })}
                onClick={() => setTrack(p, { mute: !trk.mute })}
              >
                M
              </button>
              <input
                class="t-vol"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={trk.vol}
                aria-label={tt('Volume {name}', { name })}
                title={tt('Volume {n} %', { n: Math.round(trk.vol * 100) })}
                onInput={(e) => setTrack(p, { vol: +(e.target as HTMLInputElement).value })}
                onPointerUp={releaseFocus}
              />
              <select class="t-inst" value={trk.inst} aria-label={tt('Instrument {name}', { name })} onChange={(e) => setTrack(p, { inst: (e.target as HTMLSelectElement).value as InstId })}>
                {INSTRUMENTS.map((i) => (
                  <option value={i.id}>{tt(i.label)}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <footer class="tracks-foot">
        <button class="tracks-reset" disabled={!changed} onClick={unmuteAll} title={tt('Enlever tous les solos, muets et soutiens')}>
          {tt('Tout entendre')}
        </button>
        <button
          class={`tracks-reset ${confirmReset ? 'confirm' : ''}`}
          title={tt('Tout remettre par défaut : volumes, solos, muets, instruments, tempo, affichage')}
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              window.setTimeout(() => setConfirmReset(false), 3500);
            } else {
              setConfirmReset(false);
              resetSettings();
            }
          }}
        >
          {confirmReset ? tt('Confirmer ?') : tt('Réglages par défaut')}
        </button>
        {/* phones: the help is here, with the options (in the top bar it took room from the movements) */}
        <a class="tracks-help" href={helpPage()} target="_blank" rel="noopener" title={tt('Aide : comment se servir de Pupitre Ouvert')}>
          <Icon name="help" size={17} />
          {tt('Aide')}
        </a>
        {version && (
          // which version of the app this is; the date is in the tooltip where there is one (styles.css)
          <span class="tracks-version" title={tt('Pupitre Ouvert sur cet appareil : {version}', { version: versionLabel(version) })}>
            {tt('Version')} {version.name}
            {version.when && <span class="tv-date"> · {version.when}</span>}
          </span>
        )}
        <button
          class={`tracks-rec ${prefs.value.recOn ? 'on' : ''}`}
          role="switch"
          aria-checked={!!prefs.value.recOn}
          title={tt('Ajoute sous la barre de lecture un panneau pour enregistrer ma voix et la réécouter avec la musique (utilise le micro)')}
          onClick={() => setRecOn(!prefs.value.recOn)}
        >
          <span class="sw" aria-hidden="true" />
          {tt('Enregistrer ma voix')}
        </button>
        {/* the language of the app: each named in itself, so that it can be found in the other one */}
        <div class="seg small tracks-lang" role="radiogroup" aria-label="Langue · Language" title="Langue · Language">
          {LANGS.map(([id, label]) => (
            <button role="radio" aria-checked={lang.value === id} class={lang.value === id ? 'on' : ''} lang={id} onClick={() => setLang(id)}>
              {label}
            </button>
          ))}
        </div>
        {lines.length > 1 && (
          <label class="tracks-lyrics">
            {tt('Paroles')}
            <select value={shownLine} onChange={(e) => setPrefs({ lyrics: (e.target as HTMLSelectElement).value })}>
              {lines.map((l) => (
                <option value={l.id}>{l.label}</option>
              ))}
              <option value="all">{tt('Toutes')}</option>
            </select>
          </label>
        )}
      </footer>
    </section>
  );
}

type Span = { t: number; d: number };

function notesByPart(mv: Movement): Map<string, Span[]> {
  const m = new Map<string, Span[]>();
  for (const n of mv.notes) {
    let a = m.get(n.part);
    if (!a) m.set(n.part, (a = []));
    a.push({ t: n.t, d: n.d });
  }
  for (const a of m.values()) a.sort((x, y) => x.t - y.t);
  return m;
}
