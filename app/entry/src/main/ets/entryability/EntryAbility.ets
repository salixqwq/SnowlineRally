/**
 * Immersive host ability for the rally game.
 *
 * Phones/tablets: status and navigation bars are hidden so the WebView fills
 * the physical screen (the game draws its own chrome and handles both
 * orientations). 2in1: the same calls are applied defensively; the window
 * manager ignores what does not apply to windowed desktop mode.
 */
import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { rallyBridge } from '../bridge/RallyBridge';

const DOMAIN = 0x0000;
const TAG = 'RallyEntry';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'Ability onCreate, uri: %{public}s, reason: %{public}d',
      want.uri ?? '', launchParam.launchReason);
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, TAG, 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'Ability onWindowStageCreate');
    try {
      const win: window.Window = windowStage.getMainWindowSync();
      const noBars: Array<'status' | 'navigation'> = [];
      win.setWindowSystemBarEnable(noBars).catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'setWindowSystemBarEnable failed: %{public}s', err.message);
      });
      win.setWindowKeepScreenOn(true).catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'setWindowKeepScreenOn failed: %{public}s', err.message);
      });
    } catch (err) {
      hilog.warn(DOMAIN, TAG, 'window setup skipped: %{public}s', JSON.stringify(err));
    }

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'Succeeded in loading the content.');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'Ability onForeground');
    rallyBridge.onAppForeground();
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'Ability onBackground');
    rallyBridge.onAppBackground();
  }
}
