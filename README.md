# Auto-Parse Prefix by Preset（按预设自动设置自动解析的前后缀）

一个 SillyTavern 第三方扩展：**切换「聊天补全预设」时，自动改写「AI 响应格式 → 推理」里
「自动解析（Auto-Parse）」的前缀 / 后缀（以及分隔符、开关）。**

解决的问题：不同模型的思考块标签不一样（`&lt;think&gt;…&lt;/think&gt;`、`&lt;thinking&gt;…&lt;/thinking&gt;`、
`&lt;reasoning&gt;…&lt;/reasoning&gt;` …，很多预设还会用自定义标签），而 ST 的自动解析前后缀是**全局唯一**的一组设置。
以前每换一个模型都要手改一遍，现在可以按预设名自动切换，也可以让扩展**直接读当前预设的提示词自动推断**。

---

## 功能

前后缀有三个来源，优先级从高到低：**手动规则表 → 自动识别 → 兜底策略**。

**规则表（显式、优先级最高）**

- 每条规则 = 匹配方式 + 匹配内容 + 自动解析开关 + 前缀/后缀/分隔符 + 备注
- 匹配方式：包含 / 完全相同 / 通配符（`*` `?`）/ 正则表达式，均忽略大小写
- 规则自上而下匹配，**第一条命中的生效**；可用 ↑ ↓ 调整顺序
- 规则里留空的 **前缀 / 后缀 / 分隔符** 表示「不修改」，只套用填写了的内容
- 规则的导入 / 导出（JSON）、立即应用、单条规则立即套用
- 常见标签模板一键预填（Think XML / Thinking XML / Reasoning XML / Analysis XML / Thought XML）

**自动识别（读当前预设的提示词自己判断）**

- 切换预设时读取**当前聊天补全预设的提示词全文**，找出里面的成对标签，
  例如预设里写了「reasoning steps wrapped in `<thought></thought>` tag」或
  「把思考过程写在 <inner_voice></inner_voice> 之间」，就会自动把
  `<thought>` / `</thought>`（或对应标签）设成自动解析的前后缀
- **优先只读「思维链条目」**：条目名/标识符含 `思维链 / 思维 / 思考 / 推理 / 内心 /
  CoT / think / reason …` 的提示词算思维链条目；这类条目里只要有候选，就只在其中挑。
  这样上百条的大型预设（格式外壳、状态栏、世界书条目一大堆）不会跑偏
- 排除三类干扰：
  - **STscript 宏**：`{{setvar::x::}}` / `{{getvar::x}}` 这类不是模型输出的标签
  - **`_format` 格式外壳**：`<acg_think_format>` 这种只是预设用来包裹格式示例的名字，重罚
  - **结构性标签黑名单**：`<npc>` `<CONTEXT>` `<INSTRUCTIONS>` `<CHAT_HISTORY>` `<user>` `<wlog>` …
- **不跨条目配对**：开标记与闭合标记必须在同一条目内且闭合在后，避免把
  A 条目的 `【输出推理过程】` 和 B 条目的 `</acg_think>` 硬凑成一对
- 打分证据：**是否来自思维链条目** + **标签名是否与思维链相关** +
  **同一行是否写明包裹方式** + **开闭成对还是只出现单边** + 条目是否在当前 prompt_order 里启用
- 两种模式：**安全**（默认，思维链条目里的成对标签直接用；其它条目要有关键词或包裹说明）/
  **宽松**（任意成对标签都采用）
- **识别不出来就不动你现有的设置**，宁可不改也不改错
- 面板报告会列出候选（含来源条目、是否思维链条目、是否启用、依据原文），每条都能
  **「采用这组」** 一键切过去，或 **「固化为规则」** 再手动微调
- 预设之外的格式说明（例如写在正则脚本里的标签）可以粘进 **补充文本** 一起识别

**兜底**

- 都没有命中时：保持当前设置不变，或关闭自动解析

**触发时机**：切换聊天补全预设、切换聊天、切换主 API、加载设置、ST 启动完成后

## 安装

1. 把整个文件夹复制到 ST 的用户数据目录下的 `extensions/` 里：

   ```
   <SillyTavern>/data/<你的用户名>/extensions/reasoning-autoparse-preset/
   ├── manifest.json
   ├── index.js                  # 事件接线 + 设置面板
   ├── rules.js                  # 规则匹配/校验/导入导出（零依赖纯逻辑）
   ├── detect.js                 # 从预设文本推断思维链标签（零依赖纯逻辑）
   ├── settings.html
   ├── style.css
   └── test/
       ├── rules.test.mjs        # 规则逻辑单测
       ├── detect.test.mjs       # 识别逻辑单测
       └── integration/          # jsdom 集成测试（mock + run.mjs，不参与 ST 运行）
   ```

   单用户默认安装就是 `<SillyTavern>/data/default-user/extensions/`。
   文件夹名可以随便改（扩展会从自身 URL 推断目录名）。

2. 刷新 ST 页面（或重启），打开 **扩展（Extensions）** 面板，展开
   **「自动解析前后缀 · 跟随聊天补全预设」**。

3. 确认 ST 的 **AI 响应格式 → 推理** 区域里 **Auto-Parse（自动解析）** 是开启状态。
   本扩展只负责改前缀/后缀和开关值，不会替你打开 ST 的推理功能。

> 也可以把仓库推到 GitHub，用 ST 的 **扩展 → 安装扩展（Install extension）→ 填 Git URL** 安装。

## 使用

### 方式一：啥都不配，交给自动识别（推荐先试这个）

1. 保持 **「读当前预设的提示词，自动推断思维链前后缀」** 勾选（默认开启）。
2. 去 **聊天补全预设** 下拉里正常切换预设。
3. 面板状态栏会告诉你结果：
   - `已按预设「X」自动识别：前缀 "…"，后缀 "…"` —— 识别成功并已写入 ST 的自动解析设置
   - `…也没有从预设里识别出思维链标签，保持当前设置不变` —— 预设里没写成对标签，需要走方式二
4. 报告区会列出候选（标签、前后缀、配对方式、得分、来自哪条提示词、依据原文）。
   确认无误可以点 **「固化为规则」**，把它变成一条显式规则再微调。

### 方式二：手写规则表（更可控）

1. 在 **预设下拉** 里选一个模板（比如 `Think XML`），点 **＋ 新增规则**。
2. 填 **匹配内容**，例如：
   - 包含：`DeepSeek`（预设名里出现 DeepSeek 就命中）
   - 通配符：`*Qwen*`
   - 正则：`^(Claude|GPT)`
3. 按你的模型实际输出的标签改 **前缀 / 后缀**（模板只是预填，不一定对得上）。
4. 勾选 **启用**，然后切一下预设，即可看到「推理」区域的前缀 / 后缀被改写。

规则一旦命中，就**不会再**走自动识别 —— 显式规则永远优先。

**匹配的是「聊天补全预设」的名字**，也就是 ST 顶部「预设」下拉里显示的文本
（`#settings_preset_openai`）。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 状态栏显示「当前主 API 不是聊天补全，已跳过」 | 本扩展只按聊天补全预设工作；请把主 API 切到「聊天补全」 |
| 自动识别不出标签 | 预设提示词里既没有思维链关键词，也没写「把思考包在 X 里」这类说明。把相关说明粘进 **补充文本**，或直接手写规则 |
| 识别出的标签不对 | 先看识别报告：如果正确的标签就在候选里，直接点它的 **「采用这组」**；不在候选里就点 **「固化为规则」** 手写。预设里有多块思维链时（如 `<think>` 与 `<story_driver>` 并存）本来就存在多个合理答案，扩展会挑得分最高的那个 |
| 识别报了「格式外壳」或变量名 | 已在 1.2.0 修掉：`{{setvar::…}}` / `{{getvar::…}}` 宏与 `<xxx_format>` 外壳都不会再被采用。若还遇到，把该预设发我 |
| 规则没命中 | 检查预设名拼写；匹配内容留空或规则停用都会导致不命中；可先用「包含 + 关键词」最宽松地试 |
| 前后缀改了但模型思考块没被解析 | ST 的自动解析要求**前缀和后缀都非空**；且 ST 用的是 `startsWith` 字面量匹配，标签必须和模型输出完全一致 |
| 「推理模板」下拉名字没跟着变 | 正常。ST 只保存一个模板名，实际参与解析的是 `power_user.reasoning.prefix/suffix`；下拉显示旧模板名不影响解析。 |
| 想看详细日志 | 浏览器控制台过滤 `[AutoParsePreset]` |

## 与 ST 原生能力的关系

ST 原生的「推理模板（Reasoning Formatting）」下拉，在你**手动选择模板时**会套用模板里的
前后缀 —— 但它和「聊天补全预设」没有任何绑定。本扩展补的正是这一环：
**预设 → 前后缀** 的自动映射，外加**直接读预设提示词做推断**。

## 实现要点（给想改代码的人）

- 写入的目标：`power_user.reasoning.auto_parse / prefix / suffix / separator`
  （见 `public/scripts/reasoning.js`）
- 自动识别的数据源：`getChatCompletionPreset()`（`public/scripts/openai.js`），
  即当前聊天补全预设的完整正文（含 `prompts` / `prompt_order` 等）
- 同时更新界面控件 `#reasoning_auto_parse / #reasoning_prefix / #reasoning_suffix / #reasoning_separator`，
  并 `saveSettingsDebounced()` 持久化
- 监听事件：`OAI_PRESET_CHANGED_AFTER`、`CHAT_CHANGED`、`MAIN_API_CHANGED`、
  `SETTINGS_LOADED_AFTER`、`APP_READY`
- `rules.js` / `detect.js` 都是零依赖纯逻辑，可离线测试：

  ```bash
  node test/rules.test.mjs     # 23 项：匹配/校验/导入导出/模板常量
  node test/detect.test.mjs    # 32 项：标签推断、评分、思维链条目优先、文本收集
  cd test/integration && pnpm install && node run.mjs   # 43 项：事件接线 + 面板交互 + 自动识别
  ```

- 扩展自身的设置存在 `extension_settings.reasoningAutoParsePreset`
  （`autodetect` / `detectMode` / `extraText` / `rules` / `lastDetected`）

## 验证情况

- 对照 SillyTavern `release` 分支源码核对：`public/scripts/reasoning.js`（设置字段与控件 id）、
  `public/scripts/events.js`（事件名）、`public/scripts/preset-manager.js`
  （`getPresetManager().getSelectedPresetName()`）、`public/scripts/openai.js`
  （`oai_settings` / `getChatCompletionPreset()`）、`public/script.js`（`main_api` /
  `saveSettingsDebounced` 导出）、`public/scripts/users.js`（用户扩展目录）。
- **用真实聊天补全预设验证过识别器**（6 份，标签名以外的措辞保持原样）：
  - 写了「reasoning steps strictly using the shown thought template wrapped in `<thought></thought>` tag」
    的预设 → 正确识别出 `<thought>` / `</thought>`
  - 写了「reason using `<think>` tags」的预设 → 正确识别出 `<think>` / `</think>`
  - 只有 `<CONTEXT>` `<NPCs>` `<INSTRUCTIONS>` `<CHAT_HISTORY>` 等结构性标签的 3 份预设
    → 全部正确判为「无」，不改动设置
  - **咩咩预设 ver 0.9.0**（177 条提示词、用 STscript 变量拼装格式、多选一模式一大堆）：
    识别出 `<think>` / `</think>`（来自 `🧷卡原生思维链-*` 条目），
    不再把 `<acg_think_format>` 这种格式外壳或 `{{setvar::…}}` 变量名当标签，
    也不再跨条目乱配对
- 离线测试全绿：`rules.js` 23 项 + `detect.js` 32 项 + `index.js` 43 项集成测试
  （jsdom + jQuery 3，用桩模拟 ST 的事件、预设内容与推理设置控件）。
- 集成测试覆盖：启动不改动设置、切预设自动套用、不命中保持、通配符/正则/非法正则、
  规则停用、留空字段语义、fallback、主 API 守卫、总开关、单条套用、上下移/复制/删除、
  导入导出、模板预填、恢复默认、`SETTINGS_LOADED_AFTER` 重建，以及自动识别的
  命中/不命中/模式切换/规则优先/固化为规则/补充文本/预设结构异常/
  **思维链条目优先 / 排除格式外壳 / 报告里手动「采用这组」**。
- 未在真实 ST 实例中人工点过界面；如果你装上后发现面板或触发时机有问题，
  把浏览器控制台里 `[AutoParsePreset]` 的日志发我。

## 已知限制

- 只跟随**聊天补全预设**；文本补全（Text Completion）预设不参与匹配
- 自动识别只读**当前预设的提示词文本**（`prompts` 等）：如果某个预设的思维链格式只写在
  ST 的**正则脚本**或世界书里，识别不到 —— 把那句说明粘进面板的 **补充文本** 即可
- 自动识别需要预设里出现**成对标签**，或至少出现思维链相关的开标签；
  只有「用自然语言描述思考过程」而没有标签的预设，识别不出（这类预设本来也没法用自动解析）
- **多块思维链的预设会有多个合理答案**（例如同时有 `<think>` 和 `<story_driver>`）。
  扩展会挑得分最高的那个，但报告里列出了全部候选，点 **「采用这组」** 即可换成你要的那组
- 安全模式下「只出现开标记」的标签只在报告里显示、不自动套用（闭合标签靠推断，风险偏高），
  想让它套用请切到宽松模式或固化成规则后手动补全
- 「分隔符」留空会被当成「不修改」，无法用它把分隔符清空
- 正则在预设名上测试（大小写不敏感），不支持跨字段匹配
