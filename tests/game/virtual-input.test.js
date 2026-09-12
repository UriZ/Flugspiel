// T11–T16 — spec #2 §6.2. Runs against the real upstream `Input` under the DOM stub,
// so an upstream rename of the private field it writes fails loudly (T16).

import { makeCanvas } from '../helpers/dom-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Input } from '../../src/game/vendor/engine/input.js';
import { Renderer } from '../../src/game/vendor/engine/renderer.js';
import { VirtualInput } from '../../src/game/virtual-input.js';
import { humanInput } from '../helpers/human-input.js';

/** The bridge's patch, in isolation from FlyBridge. */
function rig() {
  const canvas = makeCanvas();
  const input = new Input(canvas, new Renderer(canvas));
  const virtual = new VirtualInput();
  const mode = { fly: false };
  const orig = input.update.bind(input);
  input.update = () => {
    orig();
    if (mode.fly) virtual.writeTo(input);
  };
  return { input, virtual, mode };
}

test('T11 human mode: the patch is transparent', () => {
  const { input } = rig();
  humanInput(input, { keys: ['ArrowLeft', '7'] });
  input.update();
  assert.equal(input.mouseX, 900);
  assert.equal(input.mouseY, 300);
  assert.equal(input.mouseDown, true);
  assert.equal(input.mouseJustPressed, true);
  assert.equal(input.arrowLeft, true);
  assert.equal(input.wasKeyPressed('7'), true);
});

test('T12 fly mode overwrites every human-written field', () => {
  const { input, virtual, mode } = rig();
  mode.fly = true;
  virtual.aim(1536, 288);
  humanInput(input, { keys: ['ArrowLeft', '7'] });
  input.update();
  assert.equal(input.mouseX, 1536);
  assert.equal(input.mouseY, 288);
  assert.equal(input.mouseDown, false);
  assert.equal(input.mouseJustPressed, false);
  assert.equal(input.arrowLeft, false);
  assert.equal(input.arrowRight, false);
  assert.equal(input.rightMouseJustPressed, false);
  assert.equal(input.wasKeyPressed('7'), false);
});

test('T13 leaving fly mode while held does not leave the button stuck', () => {
  const { input, virtual, mode } = rig();
  mode.fly = true;
  virtual.pressButton();
  input.update();
  assert.equal(input.mouseDown, true);

  // setMode('human') equivalent
  mode.fly = false;
  virtual.reset();
  virtual.releaseInto(input);
  assert.equal(input.mouseDown, false);
  input.update();
  assert.equal(input.mouseDown, false);
});

test('T14 click() sets mouseJustPressed for exactly one frame', () => {
  const { input, virtual, mode } = rig();
  mode.fly = true;
  virtual.click();
  input.update();
  assert.equal(input.mouseJustPressed, true);
  input.update();
  assert.equal(input.mouseJustPressed, false);
});

test('T15 two clicks between frames produce one press', () => {
  const { input, virtual, mode } = rig();
  mode.fly = true;
  virtual.click();
  virtual.click();
  let presses = 0;
  for (let i = 0; i < 3; i++) {
    input.update();
    if (input.mouseJustPressed) presses++;
  }
  assert.equal(presses, 1);
});

test('T16 pressKey drives the real wasKeyPressed for one frame', () => {
  const { input, virtual, mode } = rig();
  mode.fly = true;
  virtual.pressKey('4');
  input.update();
  // Pins the one upstream private we depend on: Input._keysJustPressedFrame.
  assert.equal(input.wasKeyPressed('4'), true);
  input.update();
  assert.equal(input.wasKeyPressed('4'), false);
});
