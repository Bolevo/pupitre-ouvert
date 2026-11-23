// What the app keeps on the device (works added from a .zip, recordings): one IndexedDB database
// of its own (see site.ts), with the few calls the app needs.
import { createStore, del as idbDel, get as idbGet, keys as idbKeys, set as idbSet } from 'idb-keyval';
import { NS } from '../site';

let store: ReturnType<typeof createStore> | undefined;
const db = () => (store ??= createStore(NS, 'keyval'));

export const get = <T = unknown>(key: IDBValidKey): Promise<T | undefined> => idbGet<T>(key, db());
export const set = (key: IDBValidKey, value: unknown): Promise<void> => idbSet(key, value, db());
export const del = (key: IDBValidKey): Promise<void> => idbDel(key, db());
export const keys = (): Promise<IDBValidKey[]> => idbKeys(db());
