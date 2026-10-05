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

test('首次运行写入默认设置：启用、通知开、fallback=keep、含一条停用的示例规则', () => {
    assert.ok(settings());
    assert.equal(settings().enabled, true);
    assert.equal(settings().notify, true);
    assert.equal(settings().fallback, 'keep');
    assert.equal(settings().rules.length, 1);
    assert.equal(settings().rules[0].enabled, false);
});

test('面板渲染出示例规则行，并绑定全部设置事件', () => {
    assert.equal(rows().length, 1);
    for (const type of [event_types.OAI_PRESET_CHANGED_AFTER, event_types.CHAT_CHANGED, event_types.MAIN_API_CHANGED, event_types.SETTINGS_LOADED_AFTER, event_types.APP_READY]) {
        assert.equal(eventSource.listenerCount(type), 1, `${type} 未绑定`);
    }
});

test('启动时示例规则停用 + 无其它规则 ⇒ 不改动 ST 的推理设置', () => {
    assert.equal(power_user.reasoning.prefix, '<default-prefix>');
    assert.equal(power_user.reasoning.suffix, '<default-suffix>');
    assert.equal(power_user.reasoning.auto_parse, false);
    assert.match(status(), /没有规则命中/);
});

/* ---------------- 2. 新增规则 + 切预设自动套用 ---------------- */

test('点「＋ 新增规则」按所选模板预填前后缀，并展开编辑区', () => {
    $('#raps_tpl_select').val('think-xml');
    $('#raps_add_rule').trigger('click');
    assert.equal(settings().rules.length, 2);
    const rule = settings().rules[1];
    assert.equal(rule.prefix, THINK_OPEN);
    assert.equal(rule.suffix, THINK_CLOSE);
    assert.equal(rule.separator, '\n');
    assert.equal(rowOf(1).find('.raps-rule-editor').prop('hidden'), false);
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
    assert.equal(toasts.at(-1).title, 'Auto-Parse');
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

test('fallback=disable：没有规则命中时关闭自动解析', () => {
    setField(1, 'autoParse', true);
    switchPreset('DeepSeek V3.1');
    assert.equal(power_user.reasoning.auto_parse, true);
    switchPreset('NoMatchPreset');
    assert.equal(power_user.reasoning.auto_parse, true, 'fallback=keep 时不应改动');

    $('#raps_fallback').val('disable').trigger('change');
    assert.equal(settings().fallback, 'disable');
    assert.equal(power_user.reasoning.auto_parse, false);
    assert.match(status(), /已按设置关闭自动解析/);
    $('#raps_fallback').val('keep').trigger('change');
    assert.equal(settings().fallback, 'keep');
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

/* ---------------- 7. 导入导出 ---------------- */

test('导出到文本框并写入合法 JSON，导入可往返', () => {
    $('#raps_export').trigger('click');
    const text = $('#raps_io_text').val();
    assert.ok(text.includes('"rules"'));
    const parsed = JSON.parse(text);
    assert.equal(parsed.rules.length, settings().rules.length);

    parsed.rules[1].pattern = 'GLM-4.6';
    parsed.rules[1].prefix = '<glm>';
    $('#raps_io_text').val(JSON.stringify(parsed));
    $('#raps_import').trigger('click');

    assert.equal(settings().rules.length, parsed.rules.length);
    assert.match(status(), /已导入/);
    switchPreset('GLM-4.6');
    assert.equal(power_user.reasoning.prefix, '<glm>');
});

test('导入非法 JSON 时给出错误提示且不破坏现有规则', () => {
    const before = settings().rules.map(rule => rule.id);
    $('#raps_io_text').val('{not json');
    $('#raps_import').trigger('click');
    assert.match(status(), /导入失败/);
    assert.deepEqual(settings().rules.map(rule => rule.id), before);
    assert.equal(toasts.at(-1).level, 'error');
});

/* ---------------- 8. 模板快捷填充 / 恢复默认 ---------------- */

test('标签模板下拉可覆盖某条规则的前后缀', () => {
    $('#raps_tpl_select').val('analysis-xml');
    $('#raps_add_rule').trigger('click');
    const index = settings().rules.length - 1;
    assert.equal(fieldOf(index, 'prefix').val(), '<analysis>');

    rowOf(index).find('.raps-tpl-fill').val('thought-xml').trigger('change');
    assert.equal(settings().rules[index].prefix, '<thought>');
    assert.equal(fieldOf(index, 'prefix').val(), '<thought>');
    assert.equal(fieldOf(index, 'suffix').val(), '</thought>');
});

test('恢复默认：清空规则、复位开关并重绘面板', () => {
    $('#raps_reset').trigger('click');
    assert.equal(settings().rules.length, 1);
    assert.equal(settings().rules[0].enabled, false);
    assert.equal(rows().length, 1);
    assert.equal($('#raps_enabled').prop('checked'), true);
});

test('设置真正加载完成后（SETTINGS_LOADED_AFTER）会按已保存设置重建面板', () => {
    // 模拟 ST 载入用户设置：把规则换成一条命中 DeepSeek 的规则
    extension_settings[SETTINGS_KEY] = {
        enabled: true,
        notify: false,
        fallback: 'keep',
        rules: [{ id: 'r1', enabled: true, matchType: 'contains', pattern: 'DeepSeek', autoParse: true, prefix: '<loaded>', suffix: '</loaded>', separator: '\n', note: '' }],
    };
    presetState.selected = 'DeepSeek V3.1';
    eventSource.emit(event_types.SETTINGS_LOADED_AFTER);
    assert.equal(rows().length, 1);
    assert.equal($('#raps_notify').prop('checked'), false);
    assert.equal(power_user.reasoning.prefix, '<loaded>');
});

test('事件处理后不抛异常并保持面板可用', () => {
    for (const type of [event_types.CHAT_CHANGED, event_types.MAIN_API_CHANGED, event_types.APP_READY]) {
        assert.doesNotThrow(() => eventSource.emit(type));
    }
    assert.equal($('#raps_settings').length, 1);
});

/* ---------------- 9. 自动识别（读当前预设的提示词） ---------------- */

/** 换预设 = 换预设名 + 换提示词，并触发 ST 的预设切换事件 */
function setCurrentPreset(name, prompts) {
    presetState.selected = name;
    oai_settings.preset_settings_openai = name;
    openaiState.preset = { prompts };
    eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
}

/** 重置扩展设置并按 ST 载入设置的方式重建面板 */
function resetExtensionSettings(overrides = {}) {
    extension_settings[SETTINGS_KEY] = {
        enabled: true,
        notify: false,
        fallback: 'keep',
        autodetect: true,
        detectMode: 'safe',
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
    assert.match(status(), /自动识别/);
});

test('自动识别：候选与依据显示在报告面板里', () => {
    const report = $('#raps_detect_report').text();
    assert.match(report, /thought/);
    assert.match(report, /已采用/);
    assert.match(report, /wrapped in/);
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
    assert.match(status(), /也没有从预设里识别出/);
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

test('「重新识别」按钮会重新套用识别结果', () => {
    power_user.reasoning.prefix = '<changed-manually>';
    $('#raps_detect_now').trigger('click');
    assert.equal(power_user.reasoning.prefix, '<thought>');
});

test('「固化为规则」按预设名写出一条精确匹配规则', () => {
    const before = settings().rules.length;
    $('#raps_detect_to_rule').trigger('click');
    const rules = settings().rules;
    assert.equal(rules.length, before + 1);
    const rule = rules[rules.length - 1];
    assert.equal(rule.matchType, 'exact');
    assert.equal(rule.pattern, 'DeepSeek V3.1');
    assert.equal(rule.prefix, '<thought>');
    assert.equal(rule.suffix, '</thought>');
    assert.match(rule.note, /自动识别/);
    assert.equal(rows().length, before + 1);
});

test('识别模式：安全模式不采用普通成对标签，宽松模式才采用', () => {
    resetExtensionSettings({ detectMode: 'aggressive' });
    setCurrentPreset('Eva v1', [{ identifier: 'x', name: 'X', content: '<extra_info>note</extra_info>' }]);
    assert.equal(power_user.reasoning.prefix, '<extra_info>');

    resetExtensionSettings({ detectMode: 'safe' });
    power_user.reasoning.prefix = '<sentinel-prefix>';
    setCurrentPreset('Eva v1', [{ identifier: 'x', name: 'X', content: '<extra_info>note</extra_info>' }]);
    assert.equal(power_user.reasoning.prefix, '<sentinel-prefix>');
    assert.match(status(), /也没有从预设里识别出/);
});

test('模式下拉切换会重新识别', () => {
    $('#raps_detect_mode').val('aggressive').trigger('change');
    assert.equal(settings().detectMode, 'aggressive');
    assert.equal(power_user.reasoning.prefix, '<extra_info>');
    $('#raps_detect_mode').val('safe').trigger('change');
    assert.equal(settings().detectMode, 'safe');
});

test('补充文本里的格式说明也参与识别', () => {
    resetExtensionSettings({ extraText: '把思考写在 <inner_voice></inner_voice> 之间，正文另起一行。' });
    setCurrentPreset('Some Preset', [{ identifier: 'main', name: 'Main', content: 'Write the reply.' }]);
    assert.equal(power_user.reasoning.prefix, '<inner_voice>');
    assert.equal(power_user.reasoning.suffix, '</inner_voice>');
});

test('补充文本框改动会保存进设置', () => {
    $('#raps_extra_text').val('思考用 <zzz></zzz> 包裹').trigger('input');
    assert.equal(settings().extraText, '思考用 <zzz></zzz> 包裹');
});

test('预设内容读取失败时不抛异常，退化为不改动设置', () => {
    resetExtensionSettings();
    const original = openaiState.preset;
    // 模拟 ST 内部结构异常
    openaiState.preset = null;
    assert.doesNotThrow(() => eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER));
    openaiState.preset = original;
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const { name, error } of failures) {
        console.error(`\n- ${name}\n  ${error.stack ?? error.message}`);
    }
    process.exit(1);
}
