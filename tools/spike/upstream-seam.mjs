// Spike: proves the input-substitution seam in spec #2 §2.2/§2.5 against the real
// upstream `Game`, with zero edits to game source. Every line below is evidence for
// a claim the spec makes; re-run it after any re-vendor.
//
//   node tools/spike/upstream-seam.mjs [path/to/game.js]
//
// Defaults to ./src/game/vendor/game.js. Before vendoring, point it at a clone:
//   git clone https://github.com/UriZ/missile-attack-aracde-web /tmp/ma && \
//   git -C /tmp/ma checkout 458c3fb && node tools/spike/upstream-seam.mjs /tmp/ma/src/game.js
//
// Expected output (verified against 458c3fb):
//   launchers               7 sam,heatseeker,truck,vulkan,drone_pad,laser,bike
//   human press suppressed  true 0
//   fly fire                1 sam
//   weapon after key '4'    vulkan
//   vulkan held 20 frames   firing=true bullets=4   (delta over the sam interceptor)
//   vulkan released         true
//   human fire restored     true
//   dead launcher ignored   true

import { makeCanvas } from '../../tests/helpers/dom-stub.js';

const target = process.argv[2] ?? new URL('../../src/game/vendor/game.js', import.meta.url).pathname;
const { Game } = await import(target);

const g = new Game(makeCanvas());
g.start();
const count = (group) => g.entities.getGroup(group).length;
const say = (label, ...v) => console.log(label.padEnd(23), ...v);

say('launchers', g.launchers.length, g.launchers.map((l) => l.type).join(','));

// --- the seam: patch the Input instance, never the game source ---
const input = g.input;
const origUpdate = input.update.bind(input);
const v = { flyMode: false, x: 1280, y: 720, down: false, pressed: false, keys: new Set() };
input.update = () => {
  origUpdate();                       // MUST run first: it rebuilds _keysJustPressedFrame
  if (!v.flyMode) return;
  input.mouseX = v.x; input.mouseY = v.y;
  input.mouseDown = v.down;
  input.mouseJustPressed = v.pressed; v.pressed = false;
  input.rightMouseJustPressed = false;
  input.arrowLeft = false; input.arrowRight = false;
  input._keysJustPressedFrame = new Set(v.keys); v.keys.clear();
};

// fly mode suppresses a real human press entirely
v.flyMode = true;
input._mousePressed = true; input.mouseX = 900; input.mouseY = 300;
g.update(1 / 60);
say('human press suppressed', count('player_missiles') === 0, count('player_missiles'));

// a fly action fires through the unmodified _handleFireInput path
v.x = 1500; v.y = 300; v.pressed = true;
g.update(1 / 60);
say('fly fire', count('player_missiles'), g.selectedLauncher.type);

// weapon switch is String(index + 1)
v.keys.add('4'); g.update(1 / 60);
say("weapon after key '4'", g.selectedLauncher.type);

// vulkan is continuous: driven by mouseDown, not by a discrete click
const before = count('player_missiles');
v.down = true; for (let i = 0; i < 20; i++) g.update(1 / 60);
say('vulkan held 20 frames', `firing=${g._vulkanWasFiring}`, `bullets=${count('player_missiles') - before}`);
v.down = false; g.update(1 / 60);
say('vulkan released', g._vulkanWasFiring === false);

// human control returns intact
v.keys.add('2'); g.update(1 / 60);
v.flyMode = false;
const b2 = count('player_missiles');
input._mousePressed = true; input.mouseX = 700; input.mouseY = 300;
g.update(1 / 60);
say('human fire restored', count('player_missiles') > b2);

// _selectLauncher silently no-ops on a dead launcher -> applyAction needs its own check
v.flyMode = true;
g.launchers[0].alive = false;
const prev = g.selectedLauncher.type;
v.keys.add('1'); g.update(1 / 60);
say('dead launcher ignored', g.selectedLauncher.type === prev);
