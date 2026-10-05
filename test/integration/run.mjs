/**
 * index.js 的集成测试：用 jsdom + jQuery 搭出 SillyTavern 的最小桩环境，
 * 真实加载扩展代码，模拟预设切换事件与设置面板操作，断言最终写入推理设置的值。
 *
 * 运行（首次需要装依赖）：
 *   cd test/integration
 *   pnpm install        # 或 npm install
 *   node run.mjs
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import jqueryFactory from 'jquery';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(HERE, '..', '..');
const FOLDER_NAME = path.basename(EXTENSION_ROOT);
const HARNESS = path.join(os.tmpdir(), 'raps-integration-harness');
const DEST_DIR = path.join(HARNESS, 'scripts', 'extensions', 'third-party', FOLDER_NAME);

/* ---------------- 在临时目录里重建「伪造的 ST 目录树」 ----------------
 * 目录结构必须与真实 ST 一致，扩展里的相对 import 才能解析：
 *   <HARNESS>/script.js
 *   <HARNESS>/scripts/extensions.js
 *   <HARNESS>/scripts/power-user.js
 *   <HARNESS>/scripts/preset-manager.js
 *   <HARNESS>/scripts/extensions/third-party/<扩展名>/index.js
 */

await fs.rm(HARNESS, { recursive: true, force: true });
await fs.cp(path.join(HERE, 'mock'), HARNESS, { recursive: true });
await fs.mkdir(DEST_DIR, { recursive: true });
// 动态收集扩展根目录的产物，避免以后新增文件时漏拷
const extensionFiles = (await fs.readdir(EXTENSION_ROOT, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(js|html|css|json)$/.test(entry.name) && entry.name !== 'package.json')
    .map(entry => entry.name);
for (const file of extensionFiles) {
    await fs.copyFile(path.join(EXTENSION_ROOT, file), path.join(DEST_DIR, file));
}

/* ---------------- DOM 桩（含 ST 的推理设置控件） ---------------- */

const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="extensions_settings2"></div>
    <select id="settings_preset_openai"></select>
    <input id="reasoning_auto_parse" type="checkbox">
    <textarea id="reasoning_prefix"></textarea>
    <textarea id="reasoning_suffix"></textarea>
    <textarea id="reasoning_separator"></textarea>
    <div id="chat"></div>
</body></html>`, { url: 'http://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
} catch {
    // 忽略：某些 Node 版本 navigator 只读，扩展里已做 try/catch
}
globalThis.confirm = () => true;

const toasts = [];
globalThis.toastr = {
    info: (message, title) => toasts.push({ level: 'info', message, title }),
    error: (message, title) => toasts.push({ level: 'error', message, title }),
};

const $ = jqueryFactory(dom.window);
globalThis.$ = $;
globalThis.jQuery = $;

/* ---------------- 加载被测试的扩展 ---------------- */

await import(pathToFileURL(path.join(DEST_DIR, 'index.js')).href);
await new Promise(resolve => setTimeout(resolve, 60));

const { event_types, eventSource, counters, __setMainApi } = await import(pathToFileURL(path.join(HARNESS, 'script.js')).href);
const { power_user } = await import(pathToFileURL(path.join(HARNESS, 'scripts', 'power-user.js')).href);
const { presetState } = await import(pathToFileURL(path.join(HARNESS, 'scripts', 'preset-manager.js')).href);
const { extension_settings, renderCalls } = await import(pathToFileURL(path.join(HARNESS, 'scripts', 'extensions.js')).href);
const { oai_settings, openaiState } = await import(pathToFileURL(path.join(HARNESS, 'scripts', 'openai.js')).href);

/** 与扩展源码相同的拼接构造：防止字面量在写入/传输时被吞掉尖括号 */
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const THINK_OPEN = LT + 'think' + GT;
const THINK_CLOSE = LT + '/' + 'think' + GT;

/* ---------------- 小工具 ---------------- */

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        const result = fn();
        if (result instanceof Promise) {
            throw new Error('测试函数必须是同步的');
        }
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  FAIL ${name}\n       ${error.stack ?? error.message}`);
    }
}

const SETTINGS_KEY = 'reasoningAutoParsePreset';
const settings = () => extension_settings[SETTINGS_KEY];
const status = () => $('#raps_status').text();
const rows = () => $('#raps_rules .raps-rule');
const rowOf = index => rows().eq(index);
const fieldOf = (index, field) => rowOf(index).find(`[data-field="${field}"]`);

/** 修改某条规则的输入框并触发 ST 侧同样的事件 */
function setField(index, field, value, eventName = 'input') {
    const $field = fieldOf(index, field);
    assert.ok($field.length > 0, `找不到规则 ${index} 的字段 ${field}`);
    if ($field.attr('type') === 'checkbox') {
        $field.prop('checked', value);
    } else {
        $field.val(value);
    }
    $field.trigger(eventName);
}

function switchPreset(name) {
    presetState.selected = name;
    eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
}

console.log('index.js 集成测试（jsdom + jQuery + ST 桩）\n');

/* ---------------- 1. 面板装配 ---------------- */

test('扩展从自身 URL 推出 third-party/<文件夹名> 并渲染 settings.html', () => {
    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0].extensionName, `third-party/${FOLDER_NAME}`);
    assert.equal(renderCalls[0].templateId, 'settings');
    assert.equal($('#extensions_settings2 #raps_settings').length, 1);
});

test('首次运行写入默认设置：启用、自动解析开、自动识别开、含一条停用的示例规则', () => {
    assert.ok(settings());
    assert.equal(settings().enabled, true);
    assert.equal(settings().autoParse, true);
    assert.equal(settings().autodetect, true);
    assert.equal(settings().rules.length, 1);
    assert.equal(settings().rules[0].enabled, false);
});

test('面板渲染出示例规则行，并绑定全部设置事件', () => {
    assert.equal(rows().length, 1);
    assert.equal($('#raps_enabled').length, 1);
    assert.equal($('#raps_auto_parse').length, 1);
    assert.equal($('#raps_autodetect').length, 1);
    for (const type of [event_types.OAI_PRESET_CHANGED_AFTER, event_types.CHAT_CHANGED, event_types.MAIN_API_CHANGED, event_types.SETTINGS_LOADED_AFTER, event_types.APP_READY]) {
        assert.equal(eventSource.listenerCount(type), 1, `${type} 未绑定`);
    }
});

test('启动时示例规则停用 + 无其它规则 ⇒ 不改动 ST 的推理设置', () => {
    assert.equal(power_user.reasoning.prefix, '<default-prefix>');
    assert.equal(power_user.reasoning.suffix, '<default-suffix>');
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.match(status(), /没有规则命中/);
});

/* ---------------- 2. 新增规则 + 切预设自动套用 ---------------- */

test('点「＋」新增一条空规则并展开编辑区', () => {
    $('#raps_add_rule').trigger('click');
    assert.equal(settings().rules.length, 2);
    const rule = settings().rules[1];
    assert.equal(rule.pattern, '');
    assert.equal(rule.prefix, '');
    assert.equal(rowOf(1).find('.raps-rule-editor').prop('hidden'), false);
    // 手动补上前后缀（相当于用户自己填）
    setField(1, 'prefix', THINK_OPEN);
    setField(1, 'suffix', THINK_CLOSE);
    assert.equal(settings().rules[1].prefix, THINK_OPEN);
    assert.equal(settings().rules[1].suffix, THINK_CLOSE);
});

test('切换预设命中规则 ⇒ 写入 power_user.reasoning 与 ST 界面控件', () => {
    setField(1, 'pattern', 'DeepSeek');
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.prefix, THINK_OPEN);
    assert.equal(power_user.reasoning.suffix, THINK_CLOSE);
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.equal(power_user.reasoning.separator, '\n');
    assert.equal($('#reasoning_prefix').val(), THINK_OPEN);
    assert.equal($('#reasoning_suffix').val(), THINK_CLOSE);
    assert.equal($('#reasoning_auto_parse').prop('checked'), true);
    assert.match(status(), /已按预设「DeepSeek V3\.1」更新/);
    assert.equal(toasts.length, 0, '默认不弹窗');
});

test('规则命中但目标值一致时不重复写入', () => {
    const before = counters.save;
    switchPreset('DeepSeek V3.1');
    assert.match(status(), /已经是目标状态/);
    assert.equal(counters.save, before);
});

test('切到不匹配的预设 ⇒ 保持当前值不变', () => {
    switchPreset('Qwen3 30B');
    assert.equal(power_user.reasoning.prefix, THINK_OPEN);
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.match(status(), /没有规则命中/);
});

/* ---------------- 3. 匹配方式 ---------------- */

test('通配符匹配：*Qwen* 命中「Qwen3 30B」，不命中「MyLlama」', () => {
    setField(1, 'matchType', 'wildcard', 'change');
    setField(1, 'pattern', '*Qwen*');
    switchPreset('Qwen3 30B');
    assert.equal(power_user.reasoning.prefix, THINK_OPEN);
    switchPreset('MyLlama 8B');
    assert.match(status(), /没有规则命中/);
});

test('正则匹配：^(Claude|GPT) 命中 Claude，不命中 My Claude', () => {
    setField(1, 'matchType', 'regex', 'change');
    setField(1, 'pattern', '^(Claude|GPT)');
    setField(1, 'prefix', '<claude>');
    switchPreset('Claude 4.5');
    assert.equal(power_user.reasoning.prefix, '<claude>');
    assert.match(status(), /已按预设「Claude 4\.5」更新/);
    switchPreset('My Claude Proxy');
    assert.equal(power_user.reasoning.prefix, '<claude>');
    assert.match(status(), /没有规则命中/);

    // 还原成「包含 DeepSeek + 前缀  thinking」，保持后续用例的前提
    setField(1, 'prefix', THINK_OPEN);
    setField(1, 'matchType', 'contains', 'change');
    setField(1, 'pattern', 'DeepSeek');
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.prefix, THINK_OPEN);
});

test('非法正则在界面上报错，且不抛异常、不命中', () => {
    setField(1, 'matchType', 'regex', 'change');
    setField(1, 'pattern', '([unclosed');
    switchPreset('anything');
    assert.match(rowOf(1).find('.raps-rule-warn').text(), /正则表达式无效/);
    assert.equal(rowOf(1).hasClass('raps-rule-bad'), true);
    assert.match(status(), /没有规则命中/);
});

test('停用规则后不再命中', () => {
    setField(1, 'matchType', 'contains', 'change');
    setField(1, 'pattern', 'DeepSeek');
    setField(1, 'enabled', false);
    switchPreset('DeepSeek V3.1');
    assert.match(status(), /没有规则命中/);
    assert.equal(rowOf(1).hasClass('raps-rule-disabled'), true);
    setField(1, 'enabled', true);
});

/* ---------------- 4. 留空语义与 fallback ---------------- */

test('规则里留空的字段沿用当前值（只改后缀也能生效）', () => {
    setField(1, 'prefix', '');
    setField(1, 'suffix', '<END>');
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.prefix, THINK_OPEN);
    assert.equal(power_user.reasoning.suffix, '<END>');
});

test('只切自动解析开关：关掉时保留已有前后缀', () => {
    setField(1, 'suffix', '');
    setField(1, 'prefix', '');
    setField(1, 'autoParse', false);
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.auto_parse, false);
    assert.equal(power_user.reasoning.prefix, THINK_OPEN);
    assert.equal(power_user.reasoning.suffix, '<END>');
});

test('都没命中时保持当前设置不变（不再有 fallback 选项）', () => {
    setField(1, 'autoParse', true);
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.auto_parse, true);
    switchPreset('NoMatchPreset');
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.equal(power_user.reasoning.prefix, THINK_OPEN, '不命中时不改动前缀');
    assert.match(status(), /前缀\/后缀保持不动/);
});

/* ---------------- 5. 主 API 与总开关 ---------------- */

test('主 API 不是聊天补全时跳过，且状态栏说明原因', () => {
    const prefixBefore = power_user.reasoning.prefix;
    setField(1, 'pattern', 'DeepSeek');
    __setMainApi('textgenerationwebui');
    switchPreset('DeepSeek V3.1');
    assert.match(status(), /不是聊天补全/);
    assert.equal(power_user.reasoning.prefix, prefixBefore);
    __setMainApi('openai');
});

test('总开关关闭后不再改动设置，重新打开会立刻同步一次', () => {
    const prefixBefore = power_user.reasoning.prefix;
    $('#raps_enabled').prop('checked', false).trigger('input');
    switchPreset('DeepSeek V3.1');
    assert.match(status(), /扩展已关闭/);
    assert.equal(power_user.reasoning.prefix, prefixBefore);

    setField(1, 'pattern', 'DeepSeek');
    setField(1, 'suffix', '</ds>');
    setField(1, 'prefix', '<ds>');
    $('#raps_enabled').prop('checked', true).trigger('input');
    assert.equal(power_user.reasoning.prefix, '<ds>');
    assert.equal(power_user.reasoning.suffix, '</ds>');
});

/* ---------------- 6. 单条套用 / 排序 / 复制 / 删除 ---------------- */

test('「立即套用这条规则」无视匹配直接生效', () => {
    switchPreset('NoMatchHere');
    rowOf(1).find('.raps-action[data-action="apply"]').trigger('click');
    assert.equal(power_user.reasoning.prefix, '<ds>');
    assert.equal(power_user.reasoning.auto_parse, true);
});

test('上移 / 下移改变规则顺序，并影响「先匹配先赢」', () => {
    $('#raps_add_rule').trigger('click'); // 第 3 条
    setField(2, 'pattern', 'DeepSeek');
    setField(2, 'prefix', '<second>');
    const ids = settings().rules.map(rule => rule.id);

    rowOf(2).find('.raps-action[data-action="up"]').trigger('click');
    assert.deepEqual(settings().rules.map(rule => rule.id), [ids[0], ids[2], ids[1]]);

    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.prefix, '<second>');

    rowOf(1).find('.raps-action[data-action="down"]').trigger('click');
    assert.deepEqual(settings().rules.map(rule => rule.id), [ids[0], ids[1], ids[2]]);
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.prefix, '<ds>');
});

test('复制规则得到新 id 且字段一致', () => {
    const source = settings().rules[1];
    rowOf(1).find('.raps-action[data-action="duplicate"]').trigger('click');
    assert.equal(settings().rules.length, 4);
    const copy = settings().rules[2];
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.pattern, source.pattern);
    assert.equal(copy.prefix, source.prefix);
});

test('删除规则后行数与数据同步', () => {
    const before = settings().rules.length;
    rowOf(2).find('.raps-action[data-action="delete"]').trigger('click');
    assert.equal(settings().rules.length, before - 1);
    assert.equal(rows().length, before - 1);
});

/* ---------------- 7. 手动规则（无导入导出，规则来自自动生成或手填） ---------------- */

test('手动把规则改成正则匹配也能生效', () => {
    setField(1, 'matchType', 'regex', 'change');
    setField(1, 'pattern', '^GLM-.*$');
    setField(1, 'prefix', '<glm>');
    setField(1, 'suffix', '</glm>');
    switchPreset('GLM-4.6');
    assert.equal(power_user.reasoning.prefix, '<glm>');
    assert.equal(power_user.reasoning.suffix, '</glm>');
    // 还原，避免影响后续用例
    setField(1, 'matchType', 'contains', 'change');
    setField(1, 'pattern', 'DeepSeek');
    setField(1, 'prefix', '');
    setField(1, 'suffix', '');
});

/* ---------------- 8. 设置加载后重建 ---------------- */

test('设置真正加载完成后（SETTINGS_LOADED_AFTER）会按已保存设置重建面板', () => {
    // 模拟 ST 载入用户设置：把规则换成一条命中 DeepSeek 的规则
    extension_settings[SETTINGS_KEY] = {
        enabled: true,
        autoParse: true,
        autodetect: true,
        rules: [{ id: 'r1', enabled: true, matchType: 'contains', pattern: 'DeepSeek', autoParse: true, prefix: '<loaded>', suffix: '</loaded>', separator: '\n', note: '' }],
    };
    presetState.selected = 'DeepSeek V3.1';
    eventSource.emit(event_types.SETTINGS_LOADED_AFTER);
    assert.equal(rows().length, 1);
    assert.equal($('#raps_enabled').prop('checked'), true);
    assert.equal($('#raps_autodetect').prop('checked'), true);
    assert.equal(power_user.reasoning.prefix, '<loaded>');
});

test('事件处理后不抛异常并保持面板可用', () => {
    for (const type of [event_types.CHAT_CHANGED, event_types.MAIN_API_CHANGED, event_types.APP_READY]) {
        assert.doesNotThrow(() => eventSource.emit(type));
    }
    assert.equal($('#raps_settings').length, 1);
});

/* ---------------- 9. 自动识别（读当前预设的提示词） ---------------- */

/** 换预设 = 换预设名 + 换提示词（可带 extensions 等额外字段），并触发 ST 的预设切换事件 */
function setCurrentPreset(name, prompts, extra = {}) {
    presetState.selected = name;
    oai_settings.preset_settings_openai = name;
    openaiState.preset = { prompts, ...extra };
    eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
}

/** 重置扩展设置并按 ST 载入设置的方式重建面板 */
function resetExtensionSettings(overrides = {}) {
    extension_settings[SETTINGS_KEY] = {
        enabled: true,
        autoParse: true,
        autodetect: true,
        extraText: '',
        rules: [],
        lastApplied: null,
        lastDetected: null,
        ...overrides,
    };
    eventSource.emit(event_types.SETTINGS_LOADED_AFTER);
}

test('自动识别：预设写明 wrapped in `<thought></thought>` tag → 自动套用', () => {
    resetExtensionSettings();
    setCurrentPreset('DeepSeek V3.1', [
        { identifier: 'main', name: 'Main Prompt', content: 'Do reasoning steps wrapped in `<thought></thought>` tag.' },
        { identifier: 'npc', name: 'NPCs', content: '<npc>{{char}}</npc>\n<player>{{user}}</player>' },
    ]);
    assert.equal(power_user.reasoning.prefix, '<thought>');
    assert.equal(power_user.reasoning.suffix, '</thought>');
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.equal($('#reasoning_prefix').val(), '<thought>');
    assert.match(status(), /从思维链条目识别/);
});

test('报告面板列出候选，并提示忽略了多少非思维链条目标签', () => {
    const report = $('#raps_detect_report').text();
    assert.match(report, /thought/);
    assert.match(report, /已采用/);
    assert.match(report, /只读思维链条目/);
    assert.match(report, /忽略/);
});

test('手动规则优先于自动识别', () => {
    resetExtensionSettings({
        rules: [{
            id: 'r-manual', enabled: true, matchType: 'exact', pattern: 'DeepSeek V3.1',
            autoParse: true, prefix: '<manual>', suffix: '</manual>', separator: '', note: '',
        }],
    });
    setCurrentPreset('DeepSeek V3.1', [
        { identifier: 'main', name: 'Main Prompt', content: 'Do reasoning steps wrapped in `<thought></thought>` tag.' },
    ]);
    assert.equal(power_user.reasoning.prefix, '<manual>');
    assert.equal(power_user.reasoning.suffix, '</manual>');
    assert.match(status(), /命中规则|已按预设/);
});

test('自动识别：预设里只有结构性标签时保持原值不动', () => {
    resetExtensionSettings();
    power_user.reasoning.prefix = '<sentinel-prefix>';
    power_user.reasoning.suffix = '<sentinel-suffix>';
    setCurrentPreset('Neko v1.3', [
        { identifier: 'hist', name: 'Chat History', content: '<CHAT_HISTORY>{{history}}</CHAT_HISTORY>' },
        { identifier: 'chars', name: 'CHARACTERS', content: '<CHARACTERS><details>age</details></CHARACTERS>' },
    ]);
    assert.equal(power_user.reasoning.prefix, '<sentinel-prefix>');
    assert.equal(power_user.reasoning.suffix, '<sentinel-suffix>');
    assert.match(status(), /也没在思维链条目里找到/);
});

test('关闭自动识别后，即使预设里能识别出标签也不动设置', () => {
    resetExtensionSettings({ autodetect: false });
    power_user.reasoning.prefix = '<sentinel-prefix>';
    assert.equal($('#raps_autodetect').prop('checked'), false);
    setCurrentPreset('DeepSeek V3.1', [
        { identifier: 'main', name: 'Main Prompt', content: 'Do reasoning steps wrapped in `<thought></thought>` tag.' },
    ]);
    assert.equal(power_user.reasoning.prefix, '<sentinel-prefix>');
    assert.match(status(), /自动识别已关闭/);
});

test('重新打开自动识别开关会立刻套用识别结果', () => {
    power_user.reasoning.prefix = '<sentinel-prefix>';
    $('#raps_autodetect').prop('checked', true).trigger('input');
    assert.equal(power_user.reasoning.prefix, '<thought>');
    assert.equal(power_user.reasoning.suffix, '</thought>');
});

test('「立即应用」会按当前预设重新套用识别结果', () => {
    power_user.reasoning.prefix = '<changed-manually>';
    $('#raps_apply_now').trigger('click');
    assert.equal(power_user.reasoning.prefix, '<thought>');
});

test('自动识别不会采用普通成对标签（非思维链条目一律不动）', () => {
    resetExtensionSettings();
    power_user.reasoning.prefix = '<sentinel-prefix>';
    setCurrentPreset('Eva v1', [{ identifier: 'x', name: 'X', content: '<extra_info>note</extra_info>' }]);
    assert.equal(power_user.reasoning.prefix, '<sentinel-prefix>');
    assert.match(status(), /也没在思维链条目里找到/);
});

test('补充文本（手写在设置里）也参与识别', () => {
    resetExtensionSettings({ extraText: '把思考写在 <inner_voice></inner_voice> 之间，正文另起一行。' });
    setCurrentPreset('Some Preset', [{ identifier: 'main', name: 'Main', content: 'Write the reply.' }]);
    assert.equal(power_user.reasoning.prefix, '<inner_voice>');
    assert.equal(power_user.reasoning.suffix, '</inner_voice>');
});

test('预设内容读取失败时不抛异常，退化为不改动设置', () => {
    resetExtensionSettings();
    const original = openaiState.preset;
    // 模拟 ST 内部结构异常
    openaiState.preset = null;
    assert.doesNotThrow(() => eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER));
    openaiState.preset = original;
});

/* ---------------- 10. 优先读「思维链条目」 ---------------- */

test('自动识别：优先读思维链条目，忽略变量名与格式外壳', () => {
    resetExtensionSettings();
    oai_settings.prompt_order = [{
        character_id: 100001,
        order: [{ identifier: 'acg', enabled: true }, { identifier: 'mode', enabled: true }],
    }];
    setCurrentPreset('咩咩预设 0.9.0', [
        {
            identifier: 'acg',
            name: '🎭acg角色心理模型(需搭配世界书)',
            content: '{{setvar::acg_think_format::\n<acg_think_format>\n请严格按照以下 XML 格式输出：\n<acg_think>...</acg_think>\n</acg_think_format>\n}}',
        },
        {
            identifier: 'mode',
            name: '🧠思维链-故事模式(多选一)',
            content: '{{setvar::story_think_format::\n<think>\n本回合推理\n</think>\n}}',
        },
    ]);
    assert.equal(power_user.reasoning.prefix, '<think>');
    assert.equal(power_user.reasoning.suffix, '</think>');
    assert.doesNotMatch(power_user.reasoning.prefix, /format|\{\{/);
    assert.match(status(), /从思维链条目识别/);
    const report = $('#raps_detect_report').text();
    assert.match(report, /思维链条目/);
    assert.doesNotMatch(report, /setvar/);
});

test('没有思维链条目就不动设置（不会因为格式外壳改东西）', () => {
    resetExtensionSettings();
    oai_settings.prompt_order = undefined;
    power_user.reasoning.prefix = '<sentinel-prefix>';
    setCurrentPreset('只有外壳的预设', [
        {
            identifier: 'acg',
            name: '🎭acg角色心理模型',
            content: '{{setvar::acg_think_format::\n<acg_think_format>\n<acg_think>...</acg_think>\n</acg_think_format>\n}}',
        },
    ]);
    assert.equal(power_user.reasoning.prefix, '<sentinel-prefix>');
    assert.doesNotMatch(power_user.reasoning.prefix, /format|\{\{/);
});

test('报告面板的「采用」按索引套用指定候选，并把它固定成规则', () => {
    resetExtensionSettings();
    setCurrentPreset('多候选预设', [
        { identifier: 'a', name: '🧠思维链-主块', content: '<think>\n推理一\n</think>' },
        { identifier: 'b', name: '🧠思维链-备选块', content: '<thinking>\n推理二\n</thinking>' },
    ]);
    const autoApplied = power_user.reasoning.prefix;
    assert.ok(autoApplied === '<think>' || autoApplied === '<thinking>', `自动采用了 ${autoApplied}`);

    const otherIndex = autoApplied === '<think>' ? 1 : 0;
    const $button = $(`#raps_detect_report .raps-adopt[data-index="${otherIndex}"]`);
    assert.equal($button.length, 1, '应能找到另一条候选的「采用」按钮');
    $button.trigger('click');

    assert.notEqual(power_user.reasoning.prefix, autoApplied);
    assert.ok(power_user.reasoning.prefix === '<think>' || power_user.reasoning.prefix === '<thinking>');
    assert.match(status(), /已采用并记住/);
    assert.equal($('#reasoning_prefix').val(), power_user.reasoning.prefix);

    const pinned = settings().rules.find(rule => rule.matchType === 'exact' && rule.pattern === '多候选预设');
    assert.ok(pinned, '应写入一条按预设名精确匹配的规则');
    assert.equal(pinned.prefix, power_user.reasoning.prefix);
    assert.equal(pinned.enabled, true);
});

test('不再有任何弹窗提醒（toasts 始终为空）', () => {
    resetExtensionSettings();
    const baseline = toasts.length;
    setCurrentPreset('提醒测试预设', [
        { identifier: 'c', name: '🧠思维链-主块', content: '<story_driver>推理</story_driver>' },
    ]);
    $('#raps_apply_now').trigger('click');
    $('#raps_auto_parse').prop('checked', false).trigger('input');
    $('#raps_auto_parse').prop('checked', true).trigger('input');
    assert.equal(toasts.length, baseline);
});

test('手动固定关闭后，切预设不会再把它打开（直到手动改回）', () => {
    resetExtensionSettings();
    setCurrentPreset('开关测试预设', [
        { identifier: 'c', name: '🧠思维链-主块', content: '<story_driver>推理</story_driver>' },
    ]);
    assert.equal(power_user.reasoning.prefix, '<story_driver>', '前后缀跟随预设更新');
    assert.equal(power_user.reasoning.auto_parse, true, '无冲突默认自动开');

    $('#raps_auto_parse').prop('checked', false).trigger('input');
    assert.equal(power_user.reasoning.auto_parse, false);
    assert.equal(settings().autoParseOff.includes('开关测试预设'), true);

    setCurrentPreset('另一个普通预设', [{ identifier: 'x', name: 'Main', content: 'no think tag here' }]);
    assert.equal(power_user.reasoning.auto_parse, true, '其它预设仍自动开');

    setCurrentPreset('开关测试预设', [
        { identifier: 'c', name: '🧠思维链-主块', content: '<story_driver>推理</story_driver>' },
    ]);
    assert.equal(power_user.reasoning.auto_parse, false, '手动固定的预设不应被自动打开');

    $('#raps_auto_parse').prop('checked', true).trigger('input');
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.equal(settings().autoParseOff.includes('开关测试预设'), false);
});

/* ---------------- 11. 预设自带思维链美化/隐藏正则 → 暂停自动解析 ---------------- */

const COT_PROMPTS = [{ identifier: 'cot', name: '🧠思维链-主块', content: '<脑内会议>本回合推理</脑内会议>' }];
const BEAUTIFY_EXTRA = {
    extensions: {
        regex_scripts: [{
            scriptName: '01-小左',
            placement: [2],
            findRegex: '<thinking_left>\\s*([\\s\\S]*?)\\s*<\\/thinking_left>',
            replaceString: '<details style="color:#5b9bd5">$1</details>',
        }],
    },
};

test('预设自带思维链美化正则 → 自动关闭自动解析并说明原因', () => {
    resetExtensionSettings();
    setCurrentPreset('智脑-Z', COT_PROMPTS, BEAUTIFY_EXTRA);
    assert.equal(power_user.reasoning.prefix, '<脑内会议>', '前后缀仍照常设置');
    assert.equal(power_user.reasoning.auto_parse, false, '应自动关闭自动解析');
    assert.equal($('#raps_auto_parse').prop('checked'), false, '面板开关应显示为关');
    assert.match(status(), /已自动关闭自动解析/);
    assert.match($('#raps_detect_report').text(), /01-小左/);
});

test('手动固定为开启后，该预设不再被自动关闭', () => {
    $('#raps_auto_parse').prop('checked', true).trigger('input');
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.equal(settings().autoParseKeep.includes('智脑-Z'), true);
    assert.match(status(), /固定为开启自动解析/);

    // 再切回同一个预设：仍保持开启
    setCurrentPreset('智脑-Z', COT_PROMPTS, BEAUTIFY_EXTRA);
    assert.equal(power_user.reasoning.auto_parse, true);
});

test('没有美化正则的预设 ⇒ 自动开启自动解析', () => {
    resetExtensionSettings();
    setCurrentPreset('普通预设', COT_PROMPTS);
    assert.equal(power_user.reasoning.prefix, '<脑内会议>');
    assert.equal(power_user.reasoning.auto_parse, true);
    assert.equal($('#raps_auto_parse').prop('checked'), true);
});

test('手动固定为关闭后：该预设保持关闭，换别的预设仍自动开启', () => {
    resetExtensionSettings();
    setCurrentPreset('要关解析的预设', COT_PROMPTS);
    assert.equal(power_user.reasoning.auto_parse, true);

    $('#raps_auto_parse').prop('checked', false).trigger('input');
    assert.equal(power_user.reasoning.auto_parse, false);
    assert.equal(settings().autoParseOff.includes('要关解析的预设'), true);
    assert.match(status(), /固定为关闭自动解析/);

    // 切走再切回来：手动设置被记住
    setCurrentPreset('另一个普通预设', COT_PROMPTS);
    assert.equal(power_user.reasoning.auto_parse, true, '其它预设仍自动开启');
    setCurrentPreset('要关解析的预设', COT_PROMPTS);
    assert.equal(power_user.reasoning.auto_parse, false, '手动关闭的预设被记住');
    assert.equal($('#raps_auto_parse').prop('checked'), false);

    // 再手动开回来，off 记录被清掉
    $('#raps_auto_parse').prop('checked', true).trigger('input');
    assert.equal(settings().autoParseOff.includes('要关解析的预设'), false);
    assert.equal(settings().autoParseKeep.includes('要关解析的预设'), true);
});

test('没识别出标签的预设：前后缀不动，但自动解析开关照常同步', () => {
    resetExtensionSettings();
    setCurrentPreset('无思维链的预设', [{ identifier: 'a', name: 'Main', content: 'Write the reply.' }]);
    assert.equal(power_user.reasoning.prefix, '<脑内会议>', '前后缀保持不动');
    assert.equal(power_user.reasoning.auto_parse, true, '无冲突 ⇒ 自动开启');
    assert.match(status(), /前缀\/后缀保持不动；自动解析开/);
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const { name, error } of failures) {
        console.error(`\n- ${name}\n  ${error.stack ?? error.message}`);
    }
    process.exit(1);
}
