# Input injector for X11 (Linux Mint Cinnamon and other X11 desktops).
# Uses the XTEST extension through ctypes, so it needs nothing beyond python3 and libXtst, which every
# X11 desktop already has. Reads one command per line on stdin:
#   M x y          move pointer to absolute root-window pixel x,y
#   B btn 1|0      press/release button (1 left, 2 middle, 3 right, 8 back, 9 forward)
#   W dx dy        scroll dx/dy notches (dy > 0 = down, dx > 0 = right)
#   K evdev 1|0    press/release a physical key (evdev code; X keycode = evdev + 8)
#   S ms           pause (used to script a drag-and-drop while the app is busy running it)
import ctypes, sys, time
from ctypes import c_void_p, c_int, c_uint, c_ulong, c_char_p

try:
    X = ctypes.CDLL('libX11.so.6')
    T = ctypes.CDLL('libXtst.so.6')
except OSError as e:
    print('ERR missing X11 libraries: %s' % e, flush=True)
    sys.exit(2)

X.XOpenDisplay.restype = c_void_p
X.XOpenDisplay.argtypes = [c_char_p]
X.XFlush.argtypes = [c_void_p]
T.XTestQueryExtension.argtypes = [c_void_p, ctypes.POINTER(c_int), ctypes.POINTER(c_int), ctypes.POINTER(c_int), ctypes.POINTER(c_int)]
T.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
T.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
T.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]

d = X.XOpenDisplay(None)
if not d:
    print('ERR cannot open the X display (is this a Wayland session? Log in with the default X11 session)', flush=True)
    sys.exit(3)
a, b, c_, e_ = c_int(), c_int(), c_int(), c_int()
if not T.XTestQueryExtension(d, ctypes.byref(a), ctypes.byref(b), ctypes.byref(c_), ctypes.byref(e_)):
    print('ERR the X server has no XTEST extension', flush=True)
    sys.exit(4)

def click(button, n):
    for _ in range(n):
        T.XTestFakeButtonEvent(d, button, 1, 0)
        T.XTestFakeButtonEvent(d, button, 0, 0)

print('READY', flush=True)
while True:
    line = sys.stdin.readline()
    if not line:
        break
    p = line.split()
    if not p:
        continue
    try:
        cmd = p[0]
        if cmd == 'M':
            T.XTestFakeMotionEvent(d, -1, int(p[1]), int(p[2]), 0)
        elif cmd == 'B':
            T.XTestFakeButtonEvent(d, int(p[1]), 1 if p[2] == '1' else 0, 0)
        elif cmd == 'W':
            dx, dy = int(p[1]), int(p[2])
            if dy: click(5 if dy > 0 else 4, min(abs(dy), 20))
            if dx: click(7 if dx > 0 else 6, min(abs(dx), 20))
        elif cmd == 'K':
            T.XTestFakeKeyEvent(d, int(p[1]) + 8, 1 if p[2] == '1' else 0, 0)
        elif cmd == 'S':
            X.XFlush(d)
            time.sleep(min(int(p[1]), 5000) / 1000.0)
        X.XFlush(d)
    except Exception as ex:
        print('ERR %s' % ex, flush=True)
