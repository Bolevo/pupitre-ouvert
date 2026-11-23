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
    <section class={`rec ${rec ? 'is-rec' : ''}`} aria-label="Enregistrer ma voix">
      <RecButton />
      <button
        class={`rec-ctl rec-take ${on ? 'on' : ''}`}
        aria-pressed={on}
        disabled={!t}
        aria-label="Entendre ma voix enregistrée"
        title={on ? 'Ma voix enregistrée est entendue avec la musique (toucher pour la couper)' : 'Ma voix enregistrée est coupée (toucher pour l’entendre)'}
        onClick={() => setTakeOn(!on)}
      >
        <Icon name={on ? 'wave' : 'wave-off'} size={18} />
        <span>Ma voix enregistrée</span>
      </button>
      <input
        class="rec-vol"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={vol}
        disabled={!t}
        aria-label="Volume de ma voix enregistrée"
        title={`Volume de ma voix enregistrée : ${Math.round(vol * 100)} %`}
        onInput={(e) => setTakeVol(+(e.target as HTMLInputElement).value)}
      />
      {t && !rec && (
        <button class="rec-ctl rec-listen" aria-label={`Écouter depuis le début de l’enregistrement (mesure ${from})`} title={`Écouter depuis le début de l’enregistrement (mesure ${from})`} onClick={listenTake}>
          <Icon name="first" size={16} />
          <span>mes. {from}</span>
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
      <button class="rec-btn recording" style={{ '--lvl': lvl.toFixed(2) }} aria-label="Arrêter l’enregistrement (il est gardé)" title="Arrêter l’enregistrement : il est gardé (Espace aussi)" onClick={stopRecording}>
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
      aria-label="Enregistrer ma voix depuis ici"
      title="Enregistrer ma voix avec la musique, depuis l’endroit où elle est (remplace l’enregistrement de ce mouvement)"
      onClick={() => void startRecording()}
    >
      <span class="rec-dot" aria-hidden="true" />
      <span class="rec-label">Enregistrer</span>
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
        <span class="long">Enregistrement… (■ ou Espace pour arrêter)</span>
        <span class="short">Enregistrement…</span>
      </span>
    );
  if (busy === 'starting') return <span>Préparation du micro…</span>;
  if (busy === 'saving') return <span>Sauvegarde…</span>;
  if (recMsg.value) return <span class="rec-msg">{recMsg.value}</span>;
  if (!t)
    return (
      <span class="rec-none">
        <span class="long">Pas d’enregistrement pour ce mouvement</span>
        <span class="short">Pas d’enregistrement</span>
      </span>
    );
  const tempo = takeTempo(mv, t);
  if (silent)
    return (
      <button class="rec-tempo" onClick={() => setRate(t.rate)} title="Ma voix enregistrée ne s’entend qu’à son tempo : toucher pour y revenir">
        <span class="long">Muette à ce tempo : enregistrée à </span>
        <span class="short">Muette · </span>
        <NoteGlyph beat={tempo.beat} px={15} /> = {tempo.value}
      </button>
    );
  const a = mv.measures[measureIndexAt(mv, t.startSt + 1)]?.n;
  const b = mv.measures[measureIndexAt(mv, Math.min(takeEndSt(t), mv.durationMs) - 1)]?.n;
  const d = new Date(t.at);
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const s = Math.round(t.durMs / 1000);
  return (
    <span class="rec-sum" title={`Enregistrée le ${d.toLocaleString('fr-FR')}, ${s} s`}>
      mes. {a === b ? a : `${a}–${b}`} · <NoteGlyph beat={tempo.beat} px={15} /> = {tempo.value}
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
      <button class="rec-ctl rec-more" aria-label="Réglages de l’enregistrement" aria-expanded={open} aria-haspopup="dialog" title="Micro, décalage, exporter, importer, supprimer" onClick={() => setOpen(!open)}>
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div class="pop rec-pop" role="dialog" aria-label="Ma voix enregistrée">
          <div class="pop-title">Ma voix enregistrée</div>
          <label class="rp-row rp-vol">
            <span>Volume</span>
            <input type="range" min={0} max={1} step={0.01} value={vol} disabled={!t} aria-label="Volume de ma voix enregistrée" onInput={(e) => setTakeVol(+(e.target as HTMLInputElement).value)} />
          </label>
          <label class="rp-row">
            <span>Micro</span>
            <select value={missing ? '' : chosen} disabled={rec} onChange={(e) => setRecDevice((e.target as HTMLSelectElement).value)}>
              <option value="">Automatique (micro intégré)</option>
              {(mics ?? [])
                .filter((m) => m.deviceId && m.deviceId !== 'default')
                .map((m, i) => (
                  <option value={m.deviceId}>{m.label || `Micro ${i + 1}`}</option>
                ))}
            </select>
          </label>
          <p class="rp-hint">
            {missing ? 'Le micro choisi n’est plus là : micro automatique. ' : ''}
            Le micro du téléphone laisse le casque Bluetooth en haute qualité.{micUsed.value ? ` Dernier utilisé : ${micUsed.value}.` : ''}
          </p>
          <div class="rp-row">
            <span>Décalage</span>
            <div class="rp-offset">
              <button class="tp-step" aria-label="Ma voix plus tôt (−10 ms)" title="Plus tôt" disabled={off <= -OFFSET_MAX} onClick={() => setRecOffset(off - 10)}>
                −
              </button>
              <output aria-live="polite">{off > 0 ? '+' : ''}{off} ms</output>
              <button class="tp-step" aria-label="Ma voix plus tard (+10 ms)" title="Plus tard" disabled={off >= OFFSET_MAX} onClick={() => setRecOffset(off + 10)}>
                +
              </button>
            </div>
          </div>
          <p class="rp-hint">
            Ma voix en retard sur la musique : −, en avance : +.{' '}
            <button class="rp-link" disabled={!off} onClick={() => setRecOffset(0)}>
              Revenir à 0
            </button>
          </p>
          <div class="rp-actions">
            <button class="pop-action" disabled={!t || rec} onClick={exportTake}>
              Exporter (.wav)
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
              {confirm === 'imp' ? 'Remplacer ?' : 'Importer…'}
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
              {confirm === 'del' ? 'Confirmer ?' : 'Supprimer'}
            </button>
          </div>
          <input
            ref={file}
            type="file"
            accept="audio/*,.wav"
            hidden
            aria-label="Fichier audio à importer"
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
