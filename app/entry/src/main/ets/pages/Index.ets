/**
 * Host page for the unmodified single-file game
 * `resources/rawfile/snowline-rally.html` (three.js WebGL2 rally).
 *
 * Device adaptation for phone / tablet / 2in1 is done around the page:
 * - BRIDGE_JS is injected at document start: it marks the context secure and
 *   installs a devicemotion dispatcher fed by the native accelerometer
 *   (tilt steering), and bridges screen.orientation.lock/unlock to the
 *   native window so races can rotate to landscape on touch devices.
 * - Keyboard/mouse reach the page through the WebView (2in1), touch and
 *   on-screen controls work natively (phone/tablet).
 * - The HTML file itself is used as-is, byte for byte.
 */
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { rallyBridge, RallyBridge } from '../bridge/RallyBridge';

const DOMAIN: number = 0x5252;
const TAG: string = 'RallyPage';
const MAX_RENDER_CRASH_RECOVERY: number = 3;
/**
 * The system reclaims background render processes with SIGKILL
 * (KillRenderProcess). Recovery must never turn that into an endless
 * white-flashing reload loop, so a reload only gets a fresh crash budget
 * when the previous load survived at least this long.
 */
const STABLE_LOAD_MS: number = 60_000;

const BRIDGE_JS: string = `(function () {
  'use strict';
  var w = window;
  function callNative(fn) {
    try {
      var r = fn();
      if (r && typeof r.catch === 'function') {
        r.catch(function () {});
      }
    } catch (e) {}
  }
  // Tilt steering is gated on a secure context; the embedded page is a
  // trusted local asset inside the app, so mark it secure.
  try {
    Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  } catch (e) {}
  // Guarantee DeviceMotionEvent exists (the page checks it for tilt permission).
  if (typeof w.DeviceMotionEvent === 'undefined') {
    function DME() {}
    DME.requestPermission = function () { return Promise.resolve('granted'); };
    w.DeviceMotionEvent = DME;
  }
  // Native -> page motion entry. x/y/z: acceleration including gravity, m/s^2,
  // in the W3C device frame (same convention as @ohos.sensor).
  w.__rrMotion = function (x, y, z) {
    try {
      var ev = new Event('devicemotion');
      ev.accelerationIncludingGravity = { x: x, y: y, z: z };
      ev.acceleration = null;
      ev.rotationRate = null;
      ev.interval = 0.02;
      w.dispatchEvent(ev);
    } catch (e) {}
  };
  // Start/stop the native accelerometer while at least one devicemotion
  // listener is registered, so sensors are only active while tilt steering
  // is actually enabled.
  var motionCount = 0;
  var origAdd = w.addEventListener;
  var origRemove = w.removeEventListener;
  w.addEventListener = function (type, listener, options) {
    if (type === 'devicemotion') {
      if (motionCount === 0) {
        callNative(function () { return w.rrNative && w.rrNative.startMotion(); });
      }
      motionCount++;
    }
    return origAdd.call(w, type, listener, options);
  };
  w.removeEventListener = function (type, listener, options) {
    if (type === 'devicemotion') {
      if (motionCount > 0) {
        motionCount--;
      }
      if (motionCount === 0) {
        callNative(function () { return w.rrNative && w.rrNative.stopMotion(); });
      }
    }
    return origRemove.call(w, type, listener, options);
  };
  // Map screen.orientation.lock/unlock to the native window orientation.
  // Touch devices only, mirroring the web original; 2in1 stays free.
  try {
    if (w.screen && w.screen.orientation) {
      var coarse = !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches);
      w.screen.orientation.lock = function (o) {
        if (coarse && w.rrNative && w.rrNative.setOrientation) {
          callNative(function () { return w.rrNative.setOrientation(o === 'portrait' ? 'portrait' : 'landscape'); });
          return Promise.resolve();
        }
        return Promise.reject(new Error('orientation lock unsupported'));
      };
      w.screen.orientation.unlock = function () {
        if (coarse && w.rrNative && w.rrNative.setOrientation) {
          callNative(function () { return w.rrNative.setOrientation('auto'); });
        }
      };
    }
  } catch (e) {}
})();`;

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: RallyBridge = rallyBridge;
  private renderCrashCount: number = 0;
  private pendingReloadOnForeground: boolean = false;
  private reloadScheduled: boolean = false;
  private lastLoadMs: number = 0;

  aboutToAppear(): void {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx !== undefined) {
      this.bridge.attach(this.controller, ctx);
    } else {
      hilog.warn(DOMAIN, TAG, 'host context unavailable');
    }
    // Deferred renderer recovery: if the system reclaimed the renderer while
    // we were hidden, reload exactly once when the user comes back.
    this.bridge.setOnAppForeground(() => {
      if (this.pendingReloadOnForeground) {
        this.pendingReloadOnForeground = false;
        this.renderCrashCount = 0;
        this.reloadScheduled = false;
        hilog.info(DOMAIN, TAG, 'foreground after renderer reclaim, reloading once');
        this.reloadWeb();
      }
    });
  }

  aboutToDisappear(): void {
    this.bridge.dispose();
  }

  build() {
    Column() {
      Web({ src: $rawfile('snowline-rally.html'), controller: this.controller, renderMode: RenderMode.SYNC_RENDER })
        .domStorageAccess(true)
        .javaScriptOnDocumentStart([{ script: BRIDGE_JS, scriptRules: ['*'] }])
        .javaScriptProxy({
          object: this.bridge,
          name: 'rrNative',
          methodList: [],
          asyncMethodList: ['startMotion', 'stopMotion', 'setOrientation'],
          controller: this.controller
        })
        .onPageEnd(() => {
          this.lastLoadMs = Date.now();
          hilog.info(DOMAIN, TAG, 'rally page loaded');
        })
        .onErrorReceive((event) => {
          if (event) {
            hilog.error(DOMAIN, TAG, 'web error %{public}s %{public}s',
              event.request.getRequestUrl(), event.error.getErrorInfo());
          }
        })
        .onConsole((event) => {
          if (event) {
            hilog.info(DOMAIN, TAG, '[web] %{public}s', event.message.getMessage());
          }
          return false;
        })
        .onRenderExited((event) => {
          if (event) {
            hilog.error(DOMAIN, TAG, 'render exited: %{public}s', event.renderExitReason.toString());
            // A renderer crash wipes the JS context; park the sensor until the
            // reloaded page re-subscribes (its enableTilt flow).
            this.bridge.stopMotion();
            // Renderer reclaimed while our window is hidden is normal system
            // behaviour (KillRenderProcess). Reloading right now would just
            // respawn a hidden page and could loop; defer one reload to the
            // next foreground.
            if (!this.bridge.isAppVisible()) {
              this.pendingReloadOnForeground = true;
              hilog.info(DOMAIN, TAG, 'renderer gone while hidden, deferring reload to foreground');
              return;
            }
            // Visible crash: only give the recovery a fresh budget when the
            // previous load survived a meaningful amount of time, so rapid
            // kill/reload cycles stop instead of flashing forever.
            const livedMs: number = this.lastLoadMs > 0 ? Date.now() - this.lastLoadMs : 0;
            if (livedMs >= STABLE_LOAD_MS) {
              this.renderCrashCount = 0;
            }
            if (this.renderCrashCount < MAX_RENDER_CRASH_RECOVERY && !this.reloadScheduled) {
              this.renderCrashCount++;
              this.reloadScheduled = true;
              setTimeout(() => {
                this.reloadScheduled = false;
                this.reloadWeb();
              }, 500);
            } else {
              hilog.error(DOMAIN, TAG, 'recovery budget exhausted, leaving page as-is');
            }
          }
        })
        .onFullScreenExit(() => {
          // Leaving page fullscreen: restore free rotation.
          this.bridge.setOrientation('auto');
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }

  private reloadWeb(): void {
    try {
      this.controller.refresh();
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'refresh failed: %{public}s', JSON.stringify(err));
    }
  }
}
