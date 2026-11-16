# TODO

## HarmonyOS PC 浏览器白屏闪烁（待真机定位）

现象：鸿蒙 PC 默认浏览器打开时偶发白屏闪烁。

已做的缓解（本版）：
- `onResize` 增加尺寸/像素比判断，尺寸未变时不再调用 `renderer.setSize`
  （给 canvas.width 赋值会清空绘制缓冲，桌面浏览器会在窗口 chrome/滚动时反复触发 resize）。
- 切换赛道时先渲染一帧再隐藏 boot 层，避免暴露空画面。
- canvas 增加天空色 CSS 背景，任何空隙显示为天空而不是白。
- 增加 `webglcontextlost` 处理（preventDefault + toast）。

下一步定位：
1. 用 `snowline-rally.html?q=low` 打开（关闭后处理），若不再闪 → 问题在后处理/浮点 RT。
2. 若仍闪 → 记录 UA、GPU、是否全屏、是否缩放页面；
   再试 `?q=medium` 与关闭硬件加速对比。
3. 观察是否只在窗口 resize、切换全屏、或标签页切回时出现。

## 车模
- 车身主壳仍是一整块 loft；如需要，可拆成引擎盖/翼子板/车门/车顶/窗框独立网格。
- 座舱内饰为盒体近似，可继续细化（出风口、屏幕、挡杆防尘套、安全带）。
