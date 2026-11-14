/**
 * Development only. IWER (the browser XR emulator) starts with controllers; the
 * competition build must work with hands alone, so in emulation we switch IWER
 * to hand tracking before any session starts. On a real headset
 * `window.IWER_DEVICE` does not exist and this does nothing.
 */
type IwerDevice = { primaryInputMode: 'controller' | 'hand' };

export function preferEmulatedHands(): boolean {
  const device = (window as unknown as { IWER_DEVICE?: IwerDevice }).IWER_DEVICE;
  if (!device) return false;
  device.primaryInputMode = 'hand';
  return true;
}
