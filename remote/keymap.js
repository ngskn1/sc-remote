// Physical key map: KeyboardEvent.code (what the controlling PC's browser reports)
// → Linux evdev code (X keycode = evdev + 8) and Windows set-1 scan code (+ E0 "extended" flag).
// Sending physical keys means the controlled PC applies its own keyboard layout, exactly like a real
// keyboard plugged into it (so ABNT2 keys such as Ç, ´ ~ and the /? key next to right Shift work).
//
//   code: [evdev, scan, extended, vk]   vk is only used for keys that have no plain scan code (Pause).
const KEYS = {
  Escape: [1, 0x01], F1: [59, 0x3b], F2: [60, 0x3c], F3: [61, 0x3d], F4: [62, 0x3e], F5: [63, 0x3f], F6: [64, 0x40],
  F7: [65, 0x41], F8: [66, 0x42], F9: [67, 0x43], F10: [68, 0x44], F11: [87, 0x57], F12: [88, 0x58],
  PrintScreen: [99, 0x37, 1], ScrollLock: [70, 0x46], Pause: [119, 0, 0, 0x13],

  Backquote: [41, 0x29], Digit1: [2, 0x02], Digit2: [3, 0x03], Digit3: [4, 0x04], Digit4: [5, 0x05], Digit5: [6, 0x06],
  Digit6: [7, 0x07], Digit7: [8, 0x08], Digit8: [9, 0x09], Digit9: [10, 0x0a], Digit0: [11, 0x0b],
  Minus: [12, 0x0c], Equal: [13, 0x0d], Backspace: [14, 0x0e],

  Tab: [15, 0x0f], KeyQ: [16, 0x10], KeyW: [17, 0x11], KeyE: [18, 0x12], KeyR: [19, 0x13], KeyT: [20, 0x14],
  KeyY: [21, 0x15], KeyU: [22, 0x16], KeyI: [23, 0x17], KeyO: [24, 0x18], KeyP: [25, 0x19],
  BracketLeft: [26, 0x1a], BracketRight: [27, 0x1b], Backslash: [43, 0x2b], Enter: [28, 0x1c],

  CapsLock: [58, 0x3a], KeyA: [30, 0x1e], KeyS: [31, 0x1f], KeyD: [32, 0x20], KeyF: [33, 0x21], KeyG: [34, 0x22],
  KeyH: [35, 0x23], KeyJ: [36, 0x24], KeyK: [37, 0x25], KeyL: [38, 0x26], Semicolon: [39, 0x27], Quote: [40, 0x28],

  ShiftLeft: [42, 0x2a], IntlBackslash: [86, 0x56], KeyZ: [44, 0x2c], KeyX: [45, 0x2d], KeyC: [46, 0x2e],
  KeyV: [47, 0x2f], KeyB: [48, 0x30], KeyN: [49, 0x31], KeyM: [50, 0x32], Comma: [51, 0x33], Period: [52, 0x34],
  Slash: [53, 0x35], IntlRo: [89, 0x73], ShiftRight: [54, 0x36],

  ControlLeft: [29, 0x1d], MetaLeft: [125, 0x5b, 1], AltLeft: [56, 0x38], Space: [57, 0x39],
  AltRight: [100, 0x38, 1], MetaRight: [126, 0x5c, 1], ContextMenu: [127, 0x5d, 1], ControlRight: [97, 0x1d, 1],

  Insert: [110, 0x52, 1], Home: [102, 0x47, 1], PageUp: [104, 0x49, 1],
  Delete: [111, 0x53, 1], End: [107, 0x4f, 1], PageDown: [109, 0x51, 1],
  ArrowUp: [103, 0x48, 1], ArrowLeft: [105, 0x4b, 1], ArrowDown: [108, 0x50, 1], ArrowRight: [106, 0x4d, 1],

  NumLock: [69, 0x45, 1], NumpadDivide: [98, 0x35, 1], NumpadMultiply: [55, 0x37], NumpadSubtract: [74, 0x4a],
  Numpad7: [71, 0x47], Numpad8: [72, 0x48], Numpad9: [73, 0x49], NumpadAdd: [78, 0x4e],
  Numpad4: [75, 0x4b], Numpad5: [76, 0x4c], Numpad6: [77, 0x4d],
  Numpad1: [79, 0x4f], Numpad2: [80, 0x50], Numpad3: [81, 0x51], NumpadEnter: [96, 0x1c, 1],
  Numpad0: [82, 0x52], NumpadDecimal: [83, 0x53], NumpadComma: [121, 0x7e], NumpadEqual: [117, 0x59],

  AudioVolumeMute: [113, 0x20, 1], AudioVolumeDown: [114, 0x2e, 1], AudioVolumeUp: [115, 0x30, 1],
  MediaPlayPause: [164, 0x22, 1], MediaStop: [166, 0x24, 1], MediaTrackNext: [163, 0x19, 1], MediaTrackPrevious: [165, 0x10, 1],
};

const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

function lookup(code) {
  const k = KEYS[code];
  if (!k) return null;
  return { evdev: k[0], scan: k[1], ext: !!k[2], vk: k[3] || 0 };
}

module.exports = { KEYS, MODIFIERS, lookup };
