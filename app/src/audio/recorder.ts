// « Enregistrer ma voix »: the microphone, opened only while recording (the tracks are stopped as
// soon as the recording stops), and a small AudioWorklet that hands its samples to the main thread
// with their context frame (public/rec-worklet.js). The take itself is built by TakeBuilder (take.ts).

/** A headset's microphone (Bluetooth, wired headset…) by its label (labels are known once the
 *  permission is given; Android Chrome: "Speakerphone", "Headset earpiece", "Bluetooth …", the
 *  headset's name, "Default"). */
export const HEADSET_MIC = /bluetooth|\bsco\b|headset|headphone|casque|écouteur|shokz|openrun|airpods|buds|hands-?free|mains libres/i;
/** A label that names the device's own microphone. */
export const BUILT_IN_MIC = /speaker|built-?in|intégr|internal|interne|microphone|micro/i;

/** The audio inputs (labels are empty until the microphone permission is given). */
export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  } catch {
    return [];
  }
}

/** The device to ask for: the chosen one if it is still there; otherwise (automatic, or it went
 *  away) the device's own microphone: recording with it keeps a Bluetooth headset in its
 *  high-quality listening mode (A2DP) instead of switching it to the mono "phone call" mode its own
 *  microphone needs. The first labelled input that is not a headset, preferring one named like a
 *  built-in microphone; undefined (the system's default) when none can be told apart. */
export function pickMic(mics: Pick<MediaDeviceInfo, 'deviceId' | 'label'>[], chosen: string): string | undefined {
  if (chosen && mics.some((m) => m.deviceId === chosen)) return chosen;
  const ok = mics.filter((m) => m.deviceId && m.deviceId !== 'default' && m.label && !HEADSET_MIC.test(m.label) && !/^default$|^par défaut$/i.test(m.label.trim()));
  return (ok.find((m) => BUILT_IN_MIC.test(m.label)) ?? ok[0])?.deviceId;
}

const CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

/** Opens the microphone (the permission prompt, the first time). When the labels are already
 *  known (permission given before), only the chosen or built-in microphone is opened: opening the
 *  default one, even briefly, could flip a Bluetooth headset to its phone profile. */
export async function openMic(chosen: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported');
  const ask = (deviceId?: string) =>
    navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...CONSTRAINTS, deviceId: { exact: deviceId } } : CONSTRAINTS });
  let want = pickMic(await listMics(), chosen);
  let stream: MediaStream;
  try {
    stream = await ask(want);
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (want && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError')) stream = await ask().catch(fail);
    else return fail(e);
  }
  if (!want) {
    // the first time ever, the labels were unknown: now they are; if the built-in microphone can
    // be told apart and is not the one opened, open it instead (once)
    want = pickMic(await listMics(), chosen);
    const got = stream.getAudioTracks()[0]?.getSettings().deviceId;
    if (want && want !== got) {
      try {
        const again = await ask(want);
        stop(stream);
        stream = again;
      } catch {
        /* keep the default one */
      }
    }
  }
  return stream;
}

export class MicError extends Error {
  constructor(readonly kind: 'denied' | 'none' | 'busy' | 'unsupported' | 'silent' | 'other') {
    super(kind);
  }
}

function fail(e: unknown): never {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('none');
  if (name === 'NotReadableError' || name === 'AbortError') throw new MicError('busy');
  throw new MicError('other');
}

export function stop(stream: MediaStream) {
  for (const t of stream.getTracks()) t.stop();
}

/** Input latency (s) the browser reports for the microphone, or a typical value. */
export function inputLatency(stream: MediaStream): number {
  const s = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
  return s?.latency && s.latency > 0 && s.latency < 1 ? s.latency : 0.02;
}

const loaded = new WeakSet<BaseAudioContext>();

/** The capture graph: microphone → worklet (mono) → silent gain → destination (so that it runs).
 *  The microphone is never heard: nothing of it reaches the output (no monitoring, no feedback).
 *  `onData` gets each batch; stop() asks the worklet for the last samples, then takes everything
 *  down and stops the microphone. */
export async function capture(ctx: AudioContext, stream: MediaStream, workletUrl: string, onData: (frame: number, data: Float32Array, live: boolean) => void) {
  if (!loaded.has(ctx)) {
    await ctx.audioWorklet.addModule(workletUrl);
    loaded.add(ctx);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pupitre-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  let done: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent) => {
    if (e.data === 'done') done?.();
    else if (e.data && e.data.data) onData(e.data.frame, e.data.data, !!e.data.live);
  };
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      // the samples still in the worklet's batch (at most 2048 frames), within 300 ms at worst
      await new Promise<void>((resolve) => {
        done = resolve;
        node.port.postMessage('flush');
        window.setTimeout(resolve, 300);
      });
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      mute.disconnect();
      stop(stream);
    },
  };
}
