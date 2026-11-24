// « Enregistrer ma voix »: the slim panel under the bottom bar (only when the option is on, in the
// track list). ● records from where the music is parked; the recorded voice is a track heard with
// the music (on/off, volume); the « ⋯ » menu holds the microphone, the offset, export, import and
// delete. See rec.ts for the rules.
import { useEffect, useRef, useState } from 'preact/hooks';
import { listMics } from '../audio/recorder';
import { sameRate, takeEndSt } from '../audio/take';
import { deleteTake, exportTake, importTake, listenTake, micUsed, recBusy, recLevel, recMsg, recording, setRecDevice, setRecOffset, setTakeOn, setTakeVol, startRecording, stopRecording, take, type TakeInfo } from '../rec';
import { OFFSET_MAX, movement, prefs, setRate } from '../state';
import type { Movement } from '../pack/types';
import { tempoAt } from '../score/info';
import { NoteGlyph } from './Glyph';
import { Icon } from './Icon';
import { useDismiss } from './popover';
import { measureIndexAt } from './timing';
import { locale, tt } from '../i18n';

export function RecPanel() {
  const p = prefs.value;
  const mv = movement.value;
  if (!p.recOn || !mv) return null;
  const t = take.value?.mvId === mv.id ? take.value : null;
  const rec = !!recording.value;
  const on = p.takeOn !== false;
  const vol = p.takeVol ?? 0.9;
  const silent = !!t && !sameRate(t.rate, p.rate || 1);
  const from = t ? mv.measures[measureIndexAt(mv, t.startSt + 1)]?.n : '';
  return (
    <section class={`rec ${rec ? 'is-rec' : ''}`} aria-label={tt('Enregistrer ma voix')}>
      <RecButton />
      <button
        class={`rec-ctl rec-take ${on ? 'on' : ''}`}
        aria-pressed={on}
        disabled={!t}
        aria-label={tt('Entendre ma voix enregistrée')}
        title={on ? tt('Ma voix enregistrée est entendue avec la musique (toucher pour la couper)') : tt('Ma voix enregistrée est coupée (toucher pour l’entendre)')}
        onClick={() => setTakeOn(!on)}
      >
        <Icon name={on ? 'wave' : 'wave-off'} size={18} />
        <span>{tt('Ma voix enregistrée')}</span>
      </button>
      <input
        class="rec-vol"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={vol}
        disabled={!t}
        aria-label={tt('Volume de ma voix enregistrée')}
        title={tt('Volume de ma voix enregistrée : {n} %', { n: Math.round(vol * 100) })}
        onInput={(e) => setTakeVol(+(e.target as HTMLInputElement).value)}
      />
      {t && !rec && (
        <button class="rec-ctl rec-listen" aria-label={tt('Écouter depuis le début de l’enregistrement (mesure {n})', { n: from ?? '' })} title={tt('Écouter depuis le début de l’enregistrement (mesure {n})', { n: from ?? '' })} onClick={listenTake}>
          <Icon name="first" size={16} />
          <span>{tt('mes.')} {from}</span>
        </button>
      )}
      <div class="rec-info" role="status" aria-live="polite">
        <Info mv={mv} t={t} silent={silent} />
      </div>
      <RecMenu t={t} />
    </section>
  );
}

/** ● Enregistrer / ■ Arrêter, with the elapsed time and a ring that follows the microphone level. */
function RecButton() {
  const r = recording.value;
  const busy = recBusy.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!r) return;
    const id = window.setInterval(() => tick((x) => x + 1), 500);
    return () => window.clearInterval(id);
  }, [r]);
  if (r) {
    const s = Math.floor((performance.now() - r.since) / 1000);
    const lvl = Math.min(1, recLevel.value * 1.6);
    return (
      <button class="rec-btn recording" style={{ '--lvl': lvl.toFixed(2) }} aria-label={tt('Arrêter l’enregistrement (il est gardé)')} title={tt('Arrêter l’enregistrement : il est gardé (Espace aussi)')} onClick={stopRecording}>
        <Icon name="stop" size={14} />
        <span class="rec-time">
          {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
        </span>
      </button>
    );
  }
  return (
    <button
      class="rec-btn"
      disabled={!!busy}
      aria-label={tt('Enregistrer ma voix depuis ici')}
      title={tt('Enregistrer ma voix avec la musique, depuis l’endroit où elle est (remplace l’enregistrement de ce mouvement)')}
      onClick={() => void startRecording()}
    >
      <span class="rec-dot" aria-hidden="true" />
      <span class="rec-label">{tt('Enregistrer')}</span>
    </button>
  );
}

function takeTempo(mv: Movement, t: TakeInfo) {
  const sc = tempoAt(mv, measureIndexAt(mv, t.startSt + 1));
  return { beat: sc.beat, value: Math.round((sc.bpm / sc.beat) * t.rate) };
}

function Info({ mv, t, silent }: { mv: Movement; t: TakeInfo | null; silent: boolean }) {
  const busy = recBusy.value;
  if (recording.value)
    return (
      <span class="rec-live">
        <span class="long">{tt('Enregistrement… (■ ou Espace pour arrêter)')}</span>
        <span class="short">{tt('Enregistrement…')}</span>
      </span>
    );
  if (busy === 'starting') return <span>{tt('Préparation du micro…')}</span>;
  if (busy === 'saving') return <span>{tt('Sauvegarde…')}</span>;
  if (recMsg.value) return <span class="rec-msg">{recMsg.value}</span>;
  if (!t)
    return (
      <span class="rec-none">
        <span class="long">{tt('Pas d’enregistrement pour ce mouvement')}</span>
        <span class="short">{tt('Pas d’enregistrement')}</span>
      </span>
    );
  const tempo = takeTempo(mv, t);
  if (silent)
    return (
      <button class="rec-tempo" onClick={() => setRate(t.rate)} title={tt('Ma voix enregistrée ne s’entend qu’à son tempo : toucher pour y revenir')}>
        <span class="long">{tt('Muette à ce tempo : enregistrée à')} </span>
        <span class="short">{tt('Muette')} · </span>
        <NoteGlyph beat={tempo.beat} px={15} /> = {tempo.value}
      </button>
    );
  const a = mv.measures[measureIndexAt(mv, t.startSt + 1)]?.n;
  const b = mv.measures[measureIndexAt(mv, Math.min(takeEndSt(t), mv.durationMs) - 1)]?.n;
  const d = new Date(t.at);
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const s = Math.round(t.durMs / 1000);
  return (
    <span class="rec-sum" title={tt('Enregistrée le {date}, {s} s', { date: d.toLocaleString(locale()), s })}>
      {tt('mes.')} {a === b ? a : `${a}–${b}`} · <NoteGlyph beat={tempo.beat} px={15} /> = {tempo.value}
      <span class="long">
        {' '}
        · {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')} · {date}
      </span>
    </span>
  );
}

/** « ⋯ »: microphone, offset, export, import, delete. */
function RecMenu({ t }: { t: TakeInfo | null }) {
  const [open, setOpen] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[] | null>(null);
  const [confirm, setConfirm] = useState<'del' | 'imp' | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const confirmTimer = useRef(0);
  useDismiss(open, box, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    let live = true;
    const read = () => void listMics().then((l) => live && setMics(l));
    read();
    navigator.mediaDevices?.addEventListener?.('devicechange', read);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', read);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);
  useEffect(() => setConfirm(null), [open, t?.at]);
  const p = prefs.value;
  const chosen = p.recDevice ?? '';
  const off = p.recOffset ?? 0;
  const vol = p.takeVol ?? 0.9;
  const rec = !!recording.value || !!recBusy.value;
  const missing = !!chosen && !!mics && !mics.some((m) => m.deviceId === chosen);
  const ask = (what: 'del' | 'imp') => {
    setConfirm(what);
    window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirm(null), 3500);
  };
  return (
    <div class="rec-more-box" ref={box}>
      <button class="rec-ctl rec-more" aria-label={tt('Réglages de l’enregistrement')} aria-expanded={open} aria-haspopup="dialog" title={tt('Micro, décalage, exporter, importer, supprimer')} onClick={() => setOpen(!open)}>
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div class="pop rec-pop" role="dialog" aria-label={tt('Ma voix enregistrée')}>
          <div class="pop-title">{tt('Ma voix enregistrée')}</div>
          <label class="rp-row rp-vol">
            <span>{tt('Volume')}</span>
            <input type="range" min={0} max={1} step={0.01} value={vol} disabled={!t} aria-label={tt('Volume de ma voix enregistrée')} onInput={(e) => setTakeVol(+(e.target as HTMLInputElement).value)} />
          </label>
          <label class="rp-row">
            <span>{tt('Micro')}</span>
            <select value={missing ? '' : chosen} disabled={rec} onChange={(e) => setRecDevice((e.target as HTMLSelectElement).value)}>
              <option value="">{tt('Automatique (micro intégré)')}</option>
              {(mics ?? [])
                .filter((m) => m.deviceId && m.deviceId !== 'default')
                .map((m, i) => (
                  <option value={m.deviceId}>{m.label || tt('Micro {n}', { n: i + 1 })}</option>
                ))}
            </select>
          </label>
          <p class="rp-hint">
            {missing ? `${tt('Le micro choisi n’est plus là : micro automatique.')} ` : ''}
            {tt('Le micro du téléphone laisse le casque Bluetooth en haute qualité.')}
            {micUsed.value ? ` ${tt('Dernier utilisé : {mic}.', { mic: micUsed.value })}` : ''}
          </p>
          <div class="rp-row">
            <span>{tt('Décalage')}</span>
            <div class="rp-offset">
              <button class="tp-step" aria-label={tt('Ma voix plus tôt (−10 ms)')} title={tt('Plus tôt')} disabled={off <= -OFFSET_MAX} onClick={() => setRecOffset(off - 10)}>
                −
              </button>
              <output aria-live="polite">{off > 0 ? '+' : ''}{off} ms</output>
              <button class="tp-step" aria-label={tt('Ma voix plus tard (+10 ms)')} title={tt('Plus tard')} disabled={off >= OFFSET_MAX} onClick={() => setRecOffset(off + 10)}>
                +
              </button>
            </div>
          </div>
          <p class="rp-hint">
            {tt('Ma voix en retard sur la musique : −, en avance : +.')}{' '}
            <button class="rp-link" disabled={!off} onClick={() => setRecOffset(0)}>
              {tt('Revenir à 0')}
            </button>
          </p>
          <div class="rp-actions">
            <button class="pop-action" disabled={!t || rec} onClick={exportTake}>
              {tt('Exporter (.wav)')}
            </button>
            <button
              class={`pop-action ${confirm === 'imp' ? 'danger' : 'light'}`}
              disabled={rec}
              onClick={() => {
                if (t && confirm !== 'imp') return ask('imp');
                setConfirm(null);
                file.current?.click();
              }}
            >
              {confirm === 'imp' ? tt('Remplacer ?') : tt('Importer…')}
            </button>
            <button
              class={`pop-action ${confirm === 'del' ? 'danger' : 'light'}`}
              disabled={!t || rec}
              onClick={() => {
                if (confirm !== 'del') return ask('del');
                setConfirm(null);
                void deleteTake();
              }}
            >
              {confirm === 'del' ? tt('Confirmer ?') : tt('Supprimer')}
            </button>
          </div>
          <input
            ref={file}
            type="file"
            accept="audio/*,.wav"
            hidden
            aria-label={tt('Fichier audio à importer')}
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              (e.target as HTMLInputElement).value = '';
              if (f) {
                setOpen(false);
                void importTake(f);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
