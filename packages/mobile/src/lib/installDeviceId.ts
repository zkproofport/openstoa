/**
 * THIS INSTALL's id — one value, stable for the life of the install, distinct
 * for every physical device even when two are the same model.
 *
 * WHY NOT A MAC ADDRESS, which is the obvious answer and no longer a real one:
 * both platforms deliberately took it away. iOS has returned the fixed
 * `02:00:00:00:00:00` to apps since iOS 7, and Android since 10; the value that
 * used to identify hardware is now the same constant on every phone on earth.
 * Wi-Fi MACs are randomised per network as well. So a MAC would not distinguish
 * two iPhones — it would make them look identical, which is the exact failure
 * this id exists to avoid.
 *
 * WHY NOT the vendor ids either. `identifierForVendor` resets when the last app
 * from a vendor is removed, and Android's `ANDROID_ID` is per-signing-key and
 * resets on a factory reset. Both would silently mint "a new device" for the
 * same phone, which under a one-device rule means locking someone out of their
 * own account for a reason they cannot see.
 *
 * SO: a random value we make ourselves and keep in the OS keystore. It is
 * exactly as unique as a hardware id, it never collides, it survives restarts
 * and updates, and it discloses nothing about the hardware. Deleting the app
 * ends it — which is correct, because that IS a new install and the keys went
 * with the old one.
 *
 * SEPARATE FROM the MLS leaf's device id on purpose. That one is persisted by
 * `mlsSession` and the saved group state is keyed from it, so adopting a
 * different value there would orphan every joined room. They answer different
 * questions — "which install is this session on" and "which leaf in this tree"
 * — and tying them together would mean one cannot change without breaking the
 * other.
 */

/** Keystore/Keychain key. Namespaced, because the store is shared with the host. */
export const INSTALL_DEVICE_ID_KEY = 'openstoa.device.id';

export interface SecureStoreLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** 16 random bytes, hex. Long enough that collision is not a thing worth modelling. */
function mint(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/*
 * One resolution per process, shared by every caller.
 *
 * A promise rather than a value: two screens asking at once during startup must
 * not both mint and both write, because the loser's id would be the one already
 * sent in a header — and the account would look like it had two devices.
 */
let pending: Promise<string> | null = null;

/**
 * Read it, or make it on first run.
 *
 * NEVER THROWS. Without a secure store — an older host, a device that refuses
 * the keystore — this returns a per-process value instead of failing the
 * request that needed it. The consequence is honest and small: that install
 * looks like a new device after each launch, so the one-device rule nags. The
 * alternative, refusing to make requests at all, is worse for a value that is
 * not a credential.
 */
export function installDeviceId(store?: SecureStoreLike): Promise<string> {
  if (pending) return pending;
  pending = (async () => {
    if (!store) return mint();
    try {
      const saved = await store.getItem(INSTALL_DEVICE_ID_KEY);
      if (saved && saved.length > 0) return saved;
      const fresh = mint();
      await store.setItem(INSTALL_DEVICE_ID_KEY, fresh);
      /*
       * Re-read rather than trusting the write: two processes (the app and a
       * notification extension) can both miss and both write, and the value
       * that survived is the one the next launch will read. Returning what we
       * wrote would give this launch an id no future launch agrees with.
       */
      const confirmed = await store.getItem(INSTALL_DEVICE_ID_KEY);
      return confirmed && confirmed.length > 0 ? confirmed : fresh;
    } catch {
      return mint();
    }
  })();
  return pending;
}

/** Tests only — a fresh module state without reloading the module. */
export function __resetInstallDeviceId(): void {
  pending = null;
}
