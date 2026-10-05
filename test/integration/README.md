# 集成测试（jsdom + jQuery）

这里用 jsdom 搭出 SillyTavern 的最小桩环境，**真实加载扩展的 `index.js`**，
模拟「切换聊天补全预设」「设置加载」「切换主 API」等事件，以及设置面板上的
新增 / 编辑 / 排序 / 复制 / 删除 / 导入导出操作，断言最终写入的
`power_user.reasoning.*` 与 ST 界面控件的值。

## 运行

```bash
cd test/integration
pnpm install     # 或 npm install
node run.mjs
```

首次运行需要联网装 `jsdom` 与 `jquery@3`（ST 本身用的是 jQuery 3.x）。
需要 Node 20 或更高版本（jsdom 30 的要求）。

## 结构

| 路径 | 作用 |
| --- | --- |
| `run.mjs` | 测试主体；会把下面的 mock 与扩展产物复制到临时目录，拼出与真实 ST 一致的相对路径结构 |
| `mock/script.js` | 桩：`eventSource` / `event_types` / `main_api` / `saveSettingsDebounced` |
| `mock/scripts/extensions.js` | 桩：`extension_settings` / `renderExtensionTemplateAsync`（读真实 settings.html） |
| `mock/scripts/power-user.js` | 桩：`power_user.reasoning` |
| `mock/scripts/preset-manager.js` | 桩：`getPresetManager('openai').getSelectedPresetName()` |

这些 mock **只是测试替身**，ST 运行时不会加载它们；`mock/` 里的目录层级刻意与
`public/` 下的真实层级对齐，这样 `index.js` 里 `../../../extensions.js`
这样的相对导入才能被解析到。

## 与单元测试的分工

- `test/rules.test.mjs`：`rules.js` 的纯逻辑（匹配、校验、导入导出），零依赖，`node test/rules.test.mjs`
- 本目录：`index.js` 的接线与 DOM 行为
