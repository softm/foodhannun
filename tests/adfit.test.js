import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const runtime = fs.readFileSync(new URL("../assets/adfit.js", import.meta.url), "utf8");

function setup({clientWidth = 360, userAgent = "Browser/1", mobileUnit = "DAN-mobile1", desktopUnit = "DAN-desktop1"} = {}) {
  class Element {
    constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.hidden = true; this.clientWidth = clientWidth; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) {
      if (selector === "[data-adfit-host]") return this.host || null;
      if (selector === "iframe") return this.children.find(child => child.tagName === "IFRAME") || null;
      return null;
    }
  }
  const host = new Element();
  const zone = new Element("aside");
  zone.host = host;
  const head = new Element("head");
  const bodyClasses = new Set();
  const body = {classList: {add: value => bodyClasses.add(value), remove: value => bodyClasses.delete(value)}};
  const listeners = new Map();
  const document = {hidden: false, head, body, getElementById: id => id === "content-bottom-ad" ? zone : null, createElement: tagName => new Element(tagName)};
  class IntersectionObserver { constructor(callback) { this.callback = callback; } observe() { this.callback([{isIntersecting: true}]); } disconnect() {} }
  const scope = {
    document, navigator: {userAgent}, IntersectionObserver, Object,
    clearTimeout() {}, setTimeout() { return 1; }, addEventListener(type, callback) { listeners.set(type, callback); },
    FOODHANNUN_AD_CONFIG: {enabled: true, script: "https://example.test/adfit.js", placements: {
      mobile: {unit: mobileUnit, width: 320, height: 100}, desktop: {unit: desktopUnit, width: 728, height: 90}
    }}
  };
  scope.window = scope;
  scope.globalThis = scope;
  vm.runInContext(runtime, vm.createContext(scope));
  listeners.get("DOMContentLoaded")();
  return {zone, host, head, bodyClasses};
}

test("모바일에서는 전용 320x100 단위를 한 번 요청한다", () => {
  const state = setup();
  assert.equal(state.zone.hidden, false);
  assert.equal(state.host.children[0].dataset.adUnit, "DAN-mobile1");
  assert.equal(state.host.children[0].dataset.adWidth, "320");
  assert.equal(state.head.children.length, 1);
  assert.equal(state.bodyClasses.has("has-adfit-floating"), true);
});
test("넓은 화면에서는 전용 728x90 단위를 요청한다", () => {
  const state = setup({clientWidth: 900});
  assert.equal(state.host.children[0].dataset.adUnit, "DAN-desktop1");
  assert.equal(state.host.children[0].dataset.adWidth, "728");
});
test("네이티브 광고 WebView와 빈 광고 ID에서는 요청하지 않는다", () => {
  assert.equal(setup({userAgent: "Browser/1 AdMobNative/1"}).head.children.length, 0);
  const empty = setup({mobileUnit: ""});
  assert.equal(empty.zone.hidden, true);
  assert.equal(empty.head.children.length, 0);
  assert.equal(empty.bodyClasses.has("has-adfit-floating"), false);
});
