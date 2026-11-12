// The ADMIN_KEY for the admin pages (/#/inventory, /#/supplies, /#/scan), shared
// by all of them and remembered on this device until it's rejected, so it's
// typed once per device rather than once per tab.

const KEY_STORAGE = "lmb-admin-key";
// Where the key lived before the pages shared one: the scanner kept its own,
// and the other pages only kept theirs until the tab closed.
const OLD_SCAN_KEY = "lmb-scan-key";

export function readAdminKey(): string {
  try {
    const key =
      localStorage.getItem(KEY_STORAGE) ||
      localStorage.getItem(OLD_SCAN_KEY) ||
      sessionStorage.getItem(KEY_STORAGE) ||
      "";
    if (key) saveAdminKey(key);
    return key;
  } catch {
    return "";
  }
}

export function saveAdminKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key);
    localStorage.removeItem(OLD_SCAN_KEY);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {}
}

export function forgetAdminKey(): void {
  try {
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(OLD_SCAN_KEY);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {}
}
