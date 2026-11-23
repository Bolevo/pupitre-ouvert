/// <reference lib="webworker" />
// Worker glue around the resampler (see resample.ts).
import { resample, type ResampleJob } from './resample';

self.onmessage = (e: MessageEvent<ResampleJob>) => {
  const r = resample(e.data);
  (self as unknown as Worker).postMessage(r, [r.out.buffer]);
};
