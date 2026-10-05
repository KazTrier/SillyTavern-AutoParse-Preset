/**
 * Auto-Parse Prefix by Preset
 *
 * 按「聊天补全预设（Chat Completion Preset）」自动设置 SillyTavern
 * 「AI 响应格式 → 推理（Reasoning）→ 自动解析（Auto-Parse）」的前缀 / 后缀。
 *
 * 前后缀的来源，优先级从高到低：
 *   1. 手动规则表：按预设名匹配（包含 / 完全相同 / 通配符 / 正则）
 *   2. 自动识别：直接读当前预设的提示词，推断思维链标签（detect.js）
 *   3. 兜底策略：保持当前设置不变，或关闭自动解析
 *
 * 安装位置：<ST>/data/<user>/extensions/<任意文件夹名>/
 * 依赖的 ST 内部字段（对应 public/scripts/reasoning.js）：
 *   power_user.reasoning.auto_parse / prefix / suffix / separator
 *   界面控件 #reasoning_auto_parse / #reasoning_prefix / #reasoning_suffix / #reasoning_separator
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, main_api, saveSettingsDebounced } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getPresetManager } from '../../../preset-manager.js';
import { getChatCompletionPreset, oai_settings } from '../../../openai.js';
import { collectPresetTexts, describeCandidate, detectReasoningTags } from './detect.js';
import {
    MATCH_TYPES,
    MATCH_TYPE_LIST,
    TAG_TEMPLATES,
    createDefaultRules,
    createRule,
    describeRule,
    exportRules,
    findMatchingRule,
    importRules,
    normalizeRules,
    resolveReasoningUpdate,
    validateRule,
} from './rules.js';

const LOG = '[AutoParsePreset]';
const SETTINGS_KEY = 'reasoningAutoParsePreset';

/** 从扩展自身的 URL 推断安装目录名，这样用户改名文件夹也不会导致 settings.html 找不到 */
const MODULE_PATH = new URL(import.meta.url).pathname;
const PATH_PARTS = MODULE_PATH.split('/').filter(Boolean);
const EXTENSION_FOLDER = decodeURIComponent(PATH_PARTS[PATH_PARTS.length - 2] ?? 'reasoning-autoparse-preset');
const EXTENSION_NAME = `third-party/${EXTENSION_FOLDER}`;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    notify: false,
    fallback: 'keep',
    autodetect: true,
    detectMode: 'safe',
    extraText: '',
});

/* ------------------------------------------------------------------ *
 * 设置读写
 * ------------------------------------------------------------------ */

function getSettings() {
    let settings = extension_settings[SETTINGS_KEY];
    if (!settings || typeof settings !== 'object') {
        settings = { ...DEFAULT_SETTINGS, rules: createDefaultRules(), lastApplied: null };
        extension_settings[SETTINGS_KEY] = settings;
    }
    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = DEFAULT_SETTINGS.enabled;
    }
    if (typeof settings.notify !== 'boolean') {
        settings.notify = DEFAULT_SETTINGS.notify;
    }
    if (settings.fallback !== 'disable') {
        settings.fallback = 'keep';
    }
    if (typeof settings.autodetect !== 'boolean') {
        settings.autodetect = DEFAULT_SETTINGS.autodetect;
    }
    if (settings.detectMode !== 'aggressive') {
        settings.detectMode = 'safe';
    }
    if (typeof settings.extraText !== 'string') {
        settings.extraText = '';
    }
    settings.rules = normalizeRules(settings.rules);
    return settings;
}

function findRuleById(id) {
    return getSettings().rules.find(rule => rule.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * 与 ST 的推理设置交互
 * ------------------------------------------------------------------ */

/** 当前聊天补全预设名 */
function getCurrentPresetName() {
    try {
        const name = getPresetManager('openai')?.getSelectedPresetName?.();
        if (name) {
            return String(name);
        }
    } catch (error) {
        console.debug(LOG, '读取预设管理器失败，回退到下拉框取值', error);
    }
    return String($('#settings_preset_openai').val() ?? '');
}

/**
 * 把计算结果写入 ST 的推理设置（同时更新界面控件，保持面板显示一致）。
 * @param {{auto_parse?: boolean, prefix?: string, suffix?: string, separator?: string}} update
 */
function applyToPowerUser(update) {
    if (!power_user?.reasoning) {
        console.warn(LOG, 'power_user.reasoning 不存在，无法应用');
        return;
    }

    if (typeof update.auto_parse === 'boolean') {
        power_user.reasoning.auto_parse = update.auto_parse;
        $('#reasoning_auto_parse').prop('checked', update.auto_parse).trigger('input');
    }
    if (typeof update.prefix === 'string') {
        power_user.reasoning.prefix = update.prefix;
        $('#reasoning_prefix').val(update.prefix).trigger('input');
    }
    if (typeof update.suffix === 'string') {
        power_user.reasoning.suffix = update.suffix;
        $('#reasoning_suffix').val(update.suffix).trigger('input');
    }
    if (typeof update.separator === 'string') {
        power_user.reasoning.separator = update.separator;
        $('#reasoning_separator').val(update.separator).trigger('input');
    }

    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function setStatus(text) {
    const $status = $('#raps_status');
    if ($status.length) {
        $status.text(text);
    }
}

/**
 * 按当前预设重新套用规则。
 * @param {string} reason 触发来源，仅用于日志与状态显示
 */
function syncNow(reason = 'manual') {
    const settings = getSettings();
    const presetName = getCurrentPresetName() || '（未知）';

    if (!settings.enabled) {
        setStatus(`扩展已关闭。当前聊天补全预设：${presetName}`);
        return;
    }

    if (main_api !== 'openai') {
        setStatus(`当前主 API 是「${main_api}」，不是聊天补全，已跳过。当前预设：${presetName}`);
        return;
    }

    // 无论是否命中规则都跑一次识别：面板要展示候选，用户也可能想把它固化成规则
    const detection = runDetection();

    const rule = findMatchingRule(settings.rules, presetName);

    if (!rule && settings.autodetect && detection.best) {
        const current = {
            auto_parse: !!power_user.reasoning?.auto_parse,
            prefix: power_user.reasoning?.prefix ?? '',
            suffix: power_user.reasoning?.suffix ?? '',
            separator: power_user.reasoning?.separator ?? '',
        };
        const update = resolveReasoningUpdate({
            autoParse: true,
            prefix: detection.best.prefix,
            suffix: detection.best.suffix,
        }, current);
        if (!update.changed) {
            setStatus(`预设「${presetName}」的识别结果已经是当前设置，无需改动（${detection.best.tagName}）。`);
            return;
        }
        applyDetected(detection.best, presetName, reason);
        return;
    }

    if (!rule) {
        if (settings.fallback === 'disable' && power_user?.reasoning?.auto_parse) {
            applyToPowerUser({ auto_parse: false });
            setStatus(`没有规则命中预设「${presetName}」，也没识别出思维链标签，已按设置关闭自动解析。`);
            console.debug(LOG, 'fallback disable', reason, presetName);
            return;
        }
        const tail = settings.autodetect
            ? '也没在思维链条目里找到成对标签，保持当前设置不变。'
            : '，且自动识别已关闭，保持当前设置不变。';
        setStatus(`没有规则命中预设「${presetName}」，${tail}`);
        return;
    }

    const current = {
        auto_parse: !!power_user.reasoning?.auto_parse,
        prefix: power_user.reasoning?.prefix ?? '',
        suffix: power_user.reasoning?.suffix ?? '',
        separator: power_user.reasoning?.separator ?? '',
    };

    const update = resolveReasoningUpdate(rule, current);
    if (!update.changed) {
        setStatus(`预设「${presetName}」命中规则，但已经是目标状态，无需改动。`);
        return;
    }

    applyToPowerUser(update);

    settings.lastApplied = { preset: presetName, ruleId: rule.id, at: new Date().toISOString(), reason };
    saveSettingsDebounced();

    setStatus(`已按预设「${presetName}」更新：前缀 ${JSON.stringify(update.prefix)}，后缀 ${JSON.stringify(update.suffix)}，自动解析${update.auto_parse ? '开' : '关'}。`);
    console.debug(LOG, 'applied', { reason, presetName, update });

    if (shouldNotify(reason, `${update.prefix}\u0000${update.suffix}\u0000${update.auto_parse}`)) {
        toastr.info(`自动解析前后缀已按预设「${presetName}」更新`, 'Auto-Parse');
    }
}

/** 立即套用某条规则（面板里的「套用」按钮） */
function applySingleRule(rule) {
    const current = {
        auto_parse: !!power_user.reasoning?.auto_parse,
        prefix: power_user.reasoning?.prefix ?? '',
        suffix: power_user.reasoning?.suffix ?? '',
        separator: power_user.reasoning?.separator ?? '',
    };
    const update = resolveReasoningUpdate(rule, current);
    applyToPowerUser(update);
    setStatus(`已手动套用规则：${describeRule(rule)}`);
    if (getSettings().notify && typeof toastr !== 'undefined') {
        toastr.info('已手动套用该规则', 'Auto-Parse');
    }
}

/* ------------------------------------------------------------------ *
 * 自动识别：读当前预设的提示词，推断思维链标签
 * ------------------------------------------------------------------ */

/** 最近一次识别结果（报告面板的「采用」按钮要用） */
let lastDetection = null;

/**
 * 当前 prompt_order 里启用的提示词 identifier。
 * ST 里 prompt_order 按 character_id 区分（100000 = 默认，100001 = 首个角色）。
 * @returns {Set<string>|null}
 */
function getEnabledPromptIds() {
    try {
        const order = oai_settings?.prompt_order;
        if (!Array.isArray(order) || order.length === 0) {
            return null;
        }
        const entry = order.find(item => item?.character_id === 100000) ?? order[order.length - 1];
        const ids = (entry?.order ?? []).filter(item => item.enabled).map(item => String(item.identifier));
        return ids.length > 0 ? new Set(ids) : null;
    } catch (error) {
        console.debug(LOG, '读取 prompt_order 失败，忽略启用状态', error);
        return null;
    }
}

/** 收集当前预设里所有可扫描的文本（含条目名与启用状态，供识别时判定优先级） */
function getPresetCorpus() {
    const chunks = [];
    let presetName = '';
    try {
        presetName = String(oai_settings?.preset_settings_openai ?? $('#settings_preset_openai').val() ?? '');
        if (presetName !== '') {
            chunks.push({ source: '预设名', text: presetName, name: presetName, identifier: presetName });
        }
        chunks.push(...collectPresetTexts(getChatCompletionPreset(), { enabledIds: getEnabledPromptIds() }));
    } catch (error) {
        console.debug(LOG, '读取当前预设内容失败，仅用补充文本识别', error);
    }
    const extra = String(getSettings().extraText ?? '');
    if (extra.trim() !== '') {
        chunks.push({ source: '补充文本', text: extra, name: '补充文本', identifier: '补充文本' });
    }
    return { presetName, chunks };
}

/** 跑一次识别，刷新报告面板，并把结果记进设置 */
function runDetection() {
    const { presetName, chunks } = getPresetCorpus();
    const mode = getSettings().detectMode === 'aggressive' ? 'aggressive' : 'safe';
    const result = { ...detectReasoningTags(chunks, { mode }), presetName, mode, chunkCount: chunks.length };
    lastDetection = result;

    const summarize = (candidate) => candidate ? {
        prefix: candidate.prefix,
        suffix: candidate.suffix,
        tagName: candidate.tagName,
        pairing: candidate.pairing,
        score: candidate.score,
        cotEntry: !!candidate.cotEntry,
        sources: candidate.sources,
        evidence: String(candidate.evidence ?? '').slice(0, 200),
    } : null;

    const settings = getSettings();
    settings.lastDetected = {
        preset: presetName,
        at: new Date().toISOString(),
        mode,
        chunkCount: chunks.length,
        cotCandidateCount: result.cotCandidateCount ?? 0,
        best: summarize(result.best),
        candidates: result.candidates.slice(0, 5).map(summarize),
    };

    renderDetectReport(result);
    return result;
}

/**
 * 这些触发来源是程序自动跑的，不弹窗（否则切聊天/加载设置时会刷屏）。
 * 只有用户主动点按钮（manual-detect / manual-adopt / manual）才提醒。
 */
const QUIET_REASONS = new Set([
    'startup', 'settings_loaded_after', 'app_ready', 'toggle', 'fallback',
    'autodetect-toggle', 'detect-mode', 'chat_id_changed', 'oai_preset_changed_after',
    'main_api_changed',
]);

/** 判断这次要不要弹窗：开关打开 + 非自动触发 + 和上次提醒过的结果不同 */
function shouldNotify(reason, signature) {
    const settings = getSettings();
    if (!settings.notify || typeof toastr === 'undefined') {
        return false;
    }
    if (QUIET_REASONS.has(String(reason))) {
        return false;
    }
    if (settings.lastNotified === signature) {
        return false;
    }
    settings.lastNotified = signature;
    return true;
}

/**
 * 把「预设名 → 前后缀」固定成一条精确匹配规则；已存在同名规则就地更新。
 * 用户手动点「采用这组」时调用，这样以后再切回这个预设结果稳定。
 */
function pinRuleForPreset(presetName, candidate) {
    const settings = getSettings();
    const name = String(presetName);
    const existing = settings.rules.find(rule =>
        rule.matchType === MATCH_TYPES.EXACT && String(rule.pattern).toLowerCase() === name.toLowerCase());

    if (existing) {
        existing.enabled = true;
        existing.autoParse = true;
        existing.prefix = candidate.prefix;
        existing.suffix = candidate.suffix;
        existing.note = `手动采用：${candidate.tagName}`;
        saveSettingsDebounced();
        renderRules();
        return existing;
    }

    const rule = createRule({
        matchType: MATCH_TYPES.EXACT,
        pattern: name,
        autoParse: true,
        prefix: candidate.prefix,
        suffix: candidate.suffix,
        note: `手动采用：${candidate.tagName}`,
    });
    settings.rules.push(rule);
    saveSettingsDebounced();
    renderRules();
    return rule;
}

/** 把识别结果套用到 ST 的推理设置 */
function applyDetected(candidate, presetName, reason) {
    applyToPowerUser({ auto_parse: true, prefix: candidate.prefix, suffix: candidate.suffix });

    const settings = getSettings();
    const signature = `${candidate.prefix}\u0000${candidate.suffix}\u0000true`;
    settings.lastApplied = {
        preset: presetName,
        source: reason === 'manual-adopt' ? 'manual' : 'detected',
        tag: candidate.tagName,
        at: new Date().toISOString(),
        reason,
        signature,
    };
    saveSettingsDebounced();

    if (reason === 'manual-adopt') {
        pinRuleForPreset(presetName, candidate);
        setStatus(`已采用并记住：预设「${presetName}」→ 前缀 ${JSON.stringify(candidate.prefix)}，后缀 ${JSON.stringify(candidate.suffix)}（已写入规则表，以后切回这个预设都用它）`);
    } else {
        setStatus(`已按预设「${presetName}」从思维链条目识别：前缀 ${JSON.stringify(candidate.prefix)}，后缀 ${JSON.stringify(candidate.suffix)}（${describeCandidate(candidate)}）`);
    }
    console.debug(LOG, 'detected & applied', { reason, presetName, tag: candidate.tagName, score: candidate.score });

    if (shouldNotify(reason, signature)) {
        toastr.info(`自动解析前后缀已更新：${candidate.prefix} … ${candidate.suffix}`, 'Auto-Parse');
    }
}

/** 报告面板：列出候选，便于用户确认或固化成规则 */
function renderDetectReport(result) {
    const $report = $('#raps_detect_report');
    if (!$report.length) {
        return;
    }
    $report.empty();

    if (!result) {
        $report.append($('<div class="raps-dim"></div>').text('尚未识别。'));
        return;
    }

    $report.append($('<div class="raps-dim"></div>').text(
        `预设「${result.presetName || '未知'}」｜模式：${result.mode === 'aggressive' ? '宽松（任意标签）' : '安全（只读思维链条目）'}`,
    ));

    if (result.candidates.length === 0) {
        $report.append($('<div></div>').text(
            result.mode === 'aggressive'
                ? '预设里没有找到成对标签。'
                : '预设里没有「思维链条目」（条目名含 思维链/思考/推理/CoT/think…），或其中没有成对标签 —— 不会改动你的设置。',
        ));
        return;
    }

    result.candidates.slice(0, 5).forEach((candidate, index) => {
        const adopted = result.best === candidate;
        const $row = $('<div class="raps-cand"></div>');

        const $head = $('<div class="raps-cand-head"></div>').appendTo($row);
        $('<span class="raps-cand-title"></span>').text(
            `${adopted ? '★ ' : ''}${candidate.tagName}${candidate.disabledOnly ? '［未启用］' : ''}`,
        ).appendTo($head);
        $('<span class="raps-cand-tags"></span>').text(
            `${JSON.stringify(candidate.prefix)} … ${JSON.stringify(candidate.suffix)}`,
        ).appendTo($head);
        $('<div class="menu_button raps-adopt"></div>')
            .attr('data-index', index)
            .attr('title', '写入 ST 的自动解析设置，并记住这个预设用它')
            .text(adopted ? '已采用' : '采用')
            .appendTo($head);

        $row.append($('<div class="raps-cand-sub"></div>').text(
            `${candidate.score} 分｜${candidate.pairing === 'symmetric' ? '开闭成对' : (candidate.pairing === 'keyword' ? '关键词配对' : '仅见开标记')}｜来源：${(candidate.sources ?? []).join('、') || '—'}`,
        ));
        $report.append($row);
    });

    if (result.ignoredCount > 0) {
        $report.append($('<div class="raps-dim"></div>').text(
            `另有 ${result.ignoredCount} 个非思维链条目的标签已忽略（切「宽松」模式可查看）`,
        ));
    }
}

/** 报告面板里的「采用这组」：对指定候选直接套用 */
function onAdoptCandidate(index) {
    const candidate = lastDetection?.candidates?.[index];
    if (!candidate) {
        setStatus('这条候选已失效，请点「重新识别」。');
        return;
    }
    const presetName = lastDetection.presetName || getCurrentPresetName() || '（未知）';
    applyDetected(candidate, presetName, 'manual-adopt');
}

/** 「重新识别」按钮 */
function onDetectNow() {
    const result = runDetection();
    const settings = getSettings();
    if (!settings.autodetect) {
        setStatus('已重新识别（自动识别当前关闭，只显示结果，不套用）。');
        return;
    }
    if (result.best) {
        applyDetected(result.best, result.presetName || getCurrentPresetName() || '（未知）', 'manual-detect');
    } else {
        setStatus(`未从预设「${result.presetName || '未知'}」识别出思维链标签，保持当前设置不变。`);
    }
}

/** 「固化为规则」按钮：把识别结果写成一条按预设名精确匹配的规则 */
function onDetectToRule() {
    const detected = getSettings().lastDetected;
    const best = detected?.best;
    if (!best) {
        setStatus('还没有可固化的识别结果，请先点「重新识别」。');
        return;
    }
    const presetName = detected.preset || getCurrentPresetName();
    if (!presetName) {
        setStatus('无法确定当前预设名，固化失败。');
        return;
    }
    const rule = createRule({
        matchType: MATCH_TYPES.EXACT,
        pattern: presetName,
        autoParse: true,
        prefix: best.prefix,
        suffix: best.suffix,
        note: `由自动识别生成（${best.tagName}，得分 ${best.score}）`,
    });
    getSettings().rules.push(rule);
    saveSettingsDebounced();
    renderRules();
    expandRule(rule.id);
    setStatus(`已固化为规则（预设名 = ${presetName}），可展开直接修改。`);
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

function buildField(label, $input) {
    return $('<div class="raps-field"></div>')
        .append($('<span></span>').text(label))
        .append($input);
}

function buildRuleElement(rule) {
    const $rule = $('<div class="raps-rule"></div>').attr('data-id', rule.id);

    const $head = $('<div class="raps-rule-head"></div>').appendTo($rule);
    $('<input type="checkbox" class="raps-rule-enabled" data-field="enabled" title="启用这条规则">')
        .prop('checked', rule.enabled)
        .appendTo($head);
    $('<span class="raps-rule-summary"></span>').appendTo($head);

    const $actions = $('<div class="raps-rule-actions"></div>').appendTo($head);
    $('<div class="menu_button raps-action" data-action="edit" title="展开 / 收起编辑">✎</div>').appendTo($actions);
    $('<div class="menu_button raps-action" data-action="up" title="上移">↑</div>').appendTo($actions);
    $('<div class="menu_button raps-action" data-action="down" title="下移">↓</div>').appendTo($actions);
    $('<div class="menu_button raps-action" data-action="duplicate" title="复制">⧉</div>').appendTo($actions);
    $('<div class="menu_button raps-action" data-action="delete" title="删除">✕</div>').appendTo($actions);

    const $editor = $('<div class="raps-rule-editor" hidden></div>').appendTo($rule);

    // 标签模板快捷填充
    const $tplSelect = $('<select class="text_pole raps-tpl-fill"></select>');
    TAG_TEMPLATES.forEach(template => $tplSelect.append($('<option></option>').val(template.id).text(template.label)));
    $editor.append(buildField('标签模板', $tplSelect));

    // 匹配方式
    const $matchSelect = $('<select class="text_pole" data-field="matchType"></select>');
    MATCH_TYPE_LIST.forEach(type => $matchSelect.append($('<option></option>').val(type.value).text(type.label)));
    $matchSelect.val(rule.matchType);
    $editor.append(buildField('匹配方式', $matchSelect));

    $editor.append(buildField('匹配内容', $('<input type="text" class="text_pole" data-field="pattern">')
        .attr('placeholder', '例如 *DeepSeek* 或 ^(Claude|GPT)')
        .val(rule.pattern)));
    $editor.append(buildField('备注', $('<input type="text" class="text_pole" data-field="note">')
        .attr('placeholder', '可留空')
        .val(rule.note)));

    const $autoParse = $('<input type="checkbox" data-field="autoParse">').prop('checked', rule.autoParse);
    $editor.append(buildField('自动解析', $autoParse));
    $editor.append(buildField('前缀', $('<input type="text" class="text_pole" data-field="prefix">')
        .attr('placeholder', '留空＝不修改')
        .val(rule.prefix)));
    $editor.append(buildField('后缀', $('<input type="text" class="text_pole" data-field="suffix">')
        .attr('placeholder', '留空＝不修改')
        .val(rule.suffix)));
    $editor.append(buildField('分隔符', $('<input type="text" class="text_pole" data-field="separator">')
        .attr('placeholder', '留空＝不修改')
        .val(rule.separator)));

    $editor.append($('<div class="raps-rule-warn"></div>'));
    $editor.append($('<div class="menu_button raps-action" data-action="apply">立即套用这条规则</div>'));

    refreshRuleCard($rule, rule);
    return $rule;
}

function refreshRuleCard($rule, rule) {
    $rule.find('.raps-rule-summary').first().text(describeRule(rule));
    $rule.toggleClass('raps-rule-disabled', !rule.enabled);

    const problems = validateRule(rule);
    const $warn = $rule.find('.raps-rule-warn').empty();
    problems.forEach(problem => {
        $('<div></div>')
            .addClass(problem.level === 'error' ? 'raps-error' : '')
            .text((problem.level === 'error' ? '✖ ' : '⚠ ') + problem.message)
            .appendTo($warn);
    });
    $rule.toggleClass('raps-rule-bad', problems.some(problem => problem.level === 'error'));
}

function renderRules() {
    const $container = $('#raps_rules');
    if (!$container.length) {
        return;
    }
    $container.empty();
    for (const rule of getSettings().rules) {
        $container.append(buildRuleElement(rule));
    }
}

function expandRule(id) {
    const $rule = $(`#raps_rules .raps-rule[data-id="${id}"]`);
    $rule.find('.raps-rule-editor').prop('hidden', false);
    $rule.find('[data-field="pattern"]').trigger('focus');
}

function refreshStaticUi() {
    const settings = getSettings();
    $('#raps_enabled').prop('checked', settings.enabled);
    $('#raps_notify').prop('checked', settings.notify);
    $('#raps_fallback').val(settings.fallback);
    $('#raps_autodetect').prop('checked', settings.autodetect);
    $('#raps_detect_mode').val(settings.detectMode);
    $('#raps_extra_text').val(settings.extraText ?? '');
}

function onFieldChange(event) {
    const element = event.currentTarget;
    const $element = $(element);
    const $rule = $element.closest('.raps-rule');
    const rule = findRuleById($rule.attr('data-id'));
    if (!rule) {
        return;
    }
    const field = $element.attr('data-field');
    rule[field] = element.type === 'checkbox' ? $element.prop('checked') : $element.val();
    saveSettingsDebounced();
    refreshRuleCard($rule, rule);
}

function onTemplateFill(event) {
    const template = TAG_TEMPLATES.find(item => item.id === $(event.currentTarget).val());
    if (!template) {
        return;
    }
    const $rule = $(event.currentTarget).closest('.raps-rule');
    const rule = findRuleById($rule.attr('data-id'));
    if (!rule) {
        return;
    }
    rule.prefix = template.prefix;
    rule.suffix = template.suffix;
    rule.separator = template.separator;
    $rule.find('[data-field="prefix"]').val(rule.prefix);
    $rule.find('[data-field="suffix"]').val(rule.suffix);
    $rule.find('[data-field="separator"]').val(rule.separator);
    saveSettingsDebounced();
    refreshRuleCard($rule, rule);
}

function onActionClick(event) {
    const action = $(event.currentTarget).attr('data-action');
    const $rule = $(event.currentTarget).closest('.raps-rule');
    const id = $rule.attr('data-id');
    const settings = getSettings();
    const index = settings.rules.findIndex(item => item.id === id);
    if (index < 0) {
        return;
    }

    switch (action) {
        case 'edit': {
            const $editor = $rule.find('.raps-rule-editor');
            $editor.prop('hidden', !$editor.prop('hidden'));
            break;
        }
        case 'up': {
            if (index === 0) {
                break;
            }
            const [rule] = settings.rules.splice(index, 1);
            settings.rules.splice(index - 1, 0, rule);
            saveSettingsDebounced();
            renderRules();
            expandRule(id);
            break;
        }
        case 'down': {
            if (index >= settings.rules.length - 1) {
                break;
            }
            const [rule] = settings.rules.splice(index, 1);
            settings.rules.splice(index + 1, 0, rule);
            saveSettingsDebounced();
            renderRules();
            expandRule(id);
            break;
        }
        case 'duplicate': {
            const copy = createRule({ ...settings.rules[index], id: undefined });
            settings.rules.splice(index + 1, 0, copy);
            saveSettingsDebounced();
            renderRules();
            expandRule(copy.id);
            break;
        }
        case 'delete': {
            if (!confirm('删除这条规则？')) {
                break;
            }
            settings.rules.splice(index, 1);
            saveSettingsDebounced();
            renderRules();
            break;
        }
        case 'apply': {
            applySingleRule(settings.rules[index]);
            break;
        }
        default:
            break;
    }
}

function onAddRule() {
    const settings = getSettings();
    const template = TAG_TEMPLATES.find(item => item.id === $('#raps_tpl_select').val()) ?? TAG_TEMPLATES[0];
    const rule = createRule({
        matchType: MATCH_TYPES.CONTAINS,
        pattern: '',
        autoParse: true,
        prefix: template.prefix,
        suffix: template.suffix,
        separator: template.separator,
    });
    settings.rules.push(rule);
    saveSettingsDebounced();
    renderRules();
    expandRule(rule.id);
}

async function onExport() {
    const text = exportRules(getSettings().rules);
    $('#raps_io_text').val(text);
    try {
        await navigator.clipboard.writeText(text);
        setStatus('规则已导出到文本框，并复制到剪贴板。');
    } catch {
        setStatus('规则已导出到文本框（剪贴板不可用，请手动复制）。');
    }
}

function onImport() {
    try {
        const rules = importRules($('#raps_io_text').val());
        getSettings().rules = rules;
        saveSettingsDebounced();
        renderRules();
        setStatus(`已导入 ${rules.length} 条规则。`);
    } catch (error) {
        setStatus(`导入失败：${error.message}`);
        if (typeof toastr !== 'undefined') {
            toastr.error(error.message, 'Auto-Parse 规则导入失败');
        }
    }
}

function onReset() {
    if (!confirm('恢复默认设置？当前规则会被清空。')) {
        return;
    }
    extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, rules: createDefaultRules(), lastApplied: null };
    saveSettingsDebounced();
    refreshStaticUi();
    renderRules();
    setStatus('已恢复默认设置（示例规则默认关闭）。');
}

function bindStaticUi() {
    refreshStaticUi();

    $('#raps_enabled').on('input', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        syncNow('toggle');
    });
    $('#raps_notify').on('input', function () {
        getSettings().notify = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#raps_fallback').on('change', function () {
        getSettings().fallback = $(this).val() === 'disable' ? 'disable' : 'keep';
        saveSettingsDebounced();
        syncNow('fallback');
    });
    $('#raps_autodetect').on('input', function () {
        getSettings().autodetect = $(this).prop('checked');
        saveSettingsDebounced();
        syncNow('autodetect-toggle');
    });
    $('#raps_detect_mode').on('change', function () {
        getSettings().detectMode = $(this).val() === 'aggressive' ? 'aggressive' : 'safe';
        saveSettingsDebounced();
        syncNow('detect-mode');
    });
    $('#raps_detect_now').on('click', onDetectNow);
    $('#raps_detect_to_rule').on('click', onDetectToRule);
    $('#raps_detect_report').on('click', '.raps-adopt', function () {
        onAdoptCandidate(Number($(this).attr('data-index')));
    });
    $('#raps_extra_text').on('input', function () {
        getSettings().extraText = String($(this).val() ?? '');
        saveSettingsDebounced();
    });

    const $tpl = $('#raps_tpl_select').empty();
    TAG_TEMPLATES.forEach(template => $tpl.append($('<option></option>').val(template.id).text(template.label)));

    $('#raps_add_rule').on('click', onAddRule);
    $('#raps_apply_now').on('click', () => syncNow('manual'));
    $('#raps_export').on('click', () => { void onExport(); });
    $('#raps_import').on('click', onImport);
    $('#raps_reset').on('click', onReset);

    $('#raps_rules')
        .on('input change', '[data-field]', onFieldChange)
        .on('change', '.raps-tpl-fill', onTemplateFill)
        .on('click', '.raps-action', onActionClick);
}

/* ------------------------------------------------------------------ *
 * 事件接线与启动
 * ------------------------------------------------------------------ */

function registerEvents() {
    const events = [
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.CHAT_CHANGED,
        event_types.MAIN_API_CHANGED,
        event_types.SETTINGS_LOADED_AFTER,
        event_types.APP_READY,
    ];

    for (const type of events) {
        eventSource.on(type, () => {
            try {
                // 设置真正加载完之后，面板上的控件与规则列表需要按已保存的设置重建
                if (type === event_types.SETTINGS_LOADED_AFTER || type === event_types.APP_READY) {
                    if ($('#raps_settings').length) {
                        refreshStaticUi();
                        renderRules();
                    }
                }
                syncNow(type);
            } catch (error) {
                console.error(LOG, `处理事件 ${type} 时出错`, error);
            }
        });
    }
}

jQuery(async () => {
    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        // 重新加载扩展（ST 的 Reload 按钮）时避免插入第二个面板
        $('#raps_settings').remove();
        $('#extensions_settings2').append(html);
    } catch (error) {
        console.error(LOG, '设置面板渲染失败', error);
        return;
    }

    bindStaticUi();
    renderRules();
    registerEvents();
    syncNow('startup');

    console.debug(LOG, `loaded as "${EXTENSION_NAME}"`);
});
