/**
 * Native bridge for the embedded snowline-rally page.
 *
 * The HTML in rawfile is used unmodified. All device adaptation happens here:
 * - Accelerometer data is streamed into the page as standard `devicemotion`
 *   events (tilt steering on phones/tablets).
 * - screen.orientation.lock/unlock calls from the page are mapped to the
 *   app window preferred orientation (landscape while racing on touch).
 *
 * A module-level singleton is shared between the host page and the ability so
 * the ability lifecycle (foreground/background) can park the sensor while the
 * app is not visible. Methods invoked from JS must stay in asyncMethodList so
 * they execute on the main thread (sync proxy methods run on a proxy thread,
 * where sensor.on/runJavaScript are not allowed).
 */
import { sensor } from '@kit.SensorServiceKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x5252;
const TAG: string = 'RallyBridge';
const MIN_SEND_INTERVAL_MS: number = 15;

export class RallyBridge {
  private controller: webview.WebviewController | null = null;
  private context: common.Context | null = null;
  private motionOn: boolean = false;
  private motionWanted: boolean = false;
  private lastSendMs: number = 0;
  private appVisible: boolean = true;
  private foregroundListener: (() => void) | null = null;

  private onAcc = (data: sensor.AccelerometerResponse): void => {
    const ctrl: webview.WebviewController | null = this.controller;
    if (ctrl === null) {
      return;
    }
    const now: number = Date.now();
    if (now - this.lastSendMs < MIN_SEND_INTERVAL_MS) {
      return;
    }
    this.lastSendMs = now;
    const js: string = 'window.__rrMotion&&window.__rrMotion(' +
      data.x.toFixed(4) + ',' + data.y.toFixed(4) + ',' + data.z.toFixed(4) + ');';
    try {
      ctrl.runJavaScript(js).catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'runJavaScript rejected: %{public}s', err.message);
      });
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'runJavaScript failed: %{public}s', JSON.stringify(err));
    }
  };

  attach(controller: webview.WebviewController, context: common.Context): void {
    this.controller = controller;
    this.context = context;
  }

  /** Called from JS when the page starts listening to devicemotion. */
  startMotion(): void {
    this.motionWanted = true;
    this.applyMotion();
  }

  /** Called from JS when the page stops listening to devicemotion. */
  stopMotion(): void {
    this.motionWanted = false;
    this.applyMotion();
  }

  /** Ability onForeground: resume the sensor if the page still wants it. */
  onAppForeground(): void {
    this.appVisible = true;
    this.applyMotion();
    const listener: (() => void) | null = this.foregroundListener;
    if (listener !== null) {
      listener();
    }
  }

  /** Ability onBackground: park the sensor to avoid battery drain. */
  onAppBackground(): void {
    this.appVisible = false;
    this.stopSensor();
  }

  /** Whether the host ability is currently visible to the user. */
  isAppVisible(): boolean {
    return this.appVisible;
  }

  /**
   * Listener fired from onAppForeground after appVisible is updated. The host
   * page uses it to run deferred work, e.g. reloading after the system
   * reclaimed the hidden renderer.
   */
  setOnAppForeground(listener: (() => void) | null): void {
    this.foregroundListener = listener;
  }

  setOrientation(mode: string): void {
    const ctx: common.Context | null = this.context;
    if (ctx === null) {
      return;
    }
    let orientation: window.Orientation = window.Orientation.AUTO_ROTATION_RESTRICTED;
    if (mode === 'landscape') {
      orientation = window.Orientation.AUTO_ROTATION_LANDSCAPE;
    } else if (mode === 'portrait') {
      orientation = window.Orientation.AUTO_ROTATION_PORTRAIT;
    }
    window.getLastWindow(ctx).then((win: window.Window) => {
      win.setPreferredOrientation(orientation).catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'setPreferredOrientation failed: %{public}s', err.message);
      });
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'orientation change failed: %{public}s', err.message);
    });
  }

  dispose(): void {
    this.motionWanted = false;
    this.stopSensor();
    this.foregroundListener = null;
    this.controller = null;
    this.context = null;
  }

  private applyMotion(): void {
    if (this.motionWanted && !this.motionOn) {
      this.startSensor();
    } else if (!this.motionWanted && this.motionOn) {
      this.stopSensor();
    }
  }

  private startSensor(): void {
    if (this.motionOn) {
      return;
    }
    try {
      sensor.on(sensor.SensorId.ACCELEROMETER, this.onAcc, { interval: 'game' });
      this.motionOn = true;
      hilog.info(DOMAIN, TAG, 'accelerometer subscribed (game tier)');
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'sensor.on failed: %{public}s', JSON.stringify(err));
    }
  }

  private stopSensor(): void {
    if (!this.motionOn) {
      return;
    }
    try {
      sensor.off(sensor.SensorId.ACCELEROMETER);
      this.motionOn = false;
      hilog.info(DOMAIN, TAG, 'accelerometer unsubscribed');
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'sensor.off failed: %{public}s', JSON.stringify(err));
    }
  }
}

export const rallyBridge: RallyBridge = new RallyBridge();
