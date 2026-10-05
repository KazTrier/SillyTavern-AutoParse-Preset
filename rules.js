/**
 * 纯逻辑模块：规则的数据结构、预设名匹配、校验、导入导出。
 *
 * 本文件不 import 任何 SillyTavern 模块，因此可以在浏览器之外直接测试
 * （见 test/rules.test.mjs，用 `node test/rules.test.mjs` 运行）。
 */

/** 匹配方式枚举 */
export const MATCH_TYPES = Object.freeze({
    CONTAINS: 'contains',
    EXACT: 'exact',
    WILDCARD: 'wildcard',
    REGEX: 'regex',
});

/** 匹配方式 -> 界面上显示的名字 */
export const MATCH_TYPE_LIST = Object.freeze([
    { value: MATCH_TYPES.CONTAINS, label: '包含' },
    { value: MATCH_TYPES.EXACT, label: '完全相同' },
    { value: MATCH_TYPES.WILDCARD, label: '通配符 (* ?)' },
    { value: MATCH_TYPES.REGEX, label: '正则表达式' },
]);

/**
 * `<think>` / `</think>` 这类字面量在部分模型与工具链里会被当成特殊 token 而改写
 * （本项目就踩过一次：写进文件的尖括号被吞掉，模板变成了 " thinking"），
 * 所以这里用拼接构造，保证落地到文件里的永远是完整标签。
 */
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const THINK_OPEN = LT + 'think' + GT;
const THINK_CLOSE = LT + '/' + 'think' + GT;

/** 常见推理块标签模板，用于「新增规则」时预填前缀 / 后缀 */
export const TAG_TEMPLATES = Object.freeze([
    { id: 'think-xml', label: 'Think XML（DeepSeek R1 / QwQ 等，最多见）', prefix: THINK_OPEN, suffix: THINK_CLOSE, separator: '\n' },
    { id: 'think-xml-dsv31', label: 'Think XML（DeepSeek V3.1+ 的结束标记）', prefix: THINK_OPEN, suffix: '<｜end▁of▁thinking｜>', separator: '\n' },
    { id: 'thinking-xml', label: 'Thinking XML', prefix: '<thinking>', suffix: '</thinking>', separator: '\n' },
    { id: 'reasoning-xml', label: 'Reasoning XML', prefix: '<reasoning>', suffix: '</reasoning>', separator: '\n' },
    { id: 'analysis-xml', label: 'Analysis XML', prefix: '<analysis>', suffix: '</analysis>', separator: '\n' },
    { id: 'thought-xml', label: 'Thought XML', prefix: '<thought>', suffix: '</thought>', separator: '\n' },
    { id: 'custom', label: '自定义（不预填前后缀）', prefix: '', suffix: '', separator: '' },
]);

let idCounter = 0;

/**
 * 生成一个规则 id。
 * @returns {string}
 */
export function createRuleId() {
    idCounter = (idCounter + 1) % 0xffff;
    return `raps_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * 补全一个规则对象，保证字段类型正确。
 * @param {object} [partial] 部分字段
 * @returns {{id: string, enabled: boolean, matchType: string, pattern: string, autoParse: boolean, prefix: string, suffix: string, separator: string, note: string}}
 */
export function createRule(partial = {}) {
    const source = partial && typeof partial === 'object' ? partial : {};
    const matchType = MATCH_TYPE_LIST.some(x => x.value === source.matchType) ? source.matchType : MATCH_TYPES.CONTAINS;
    return {
        id: typeof source.id === 'string' && source.id !== '' ? source.id : createRuleId(),
        enabled: source.enabled !== false,
        matchType: matchType,
        pattern: source.pattern === undefined || source.pattern === null ? '' : String(source.pattern),
        autoParse: source.autoParse !== false,
        prefix: source.prefix === undefined || source.prefix === null ? '' : String(source.prefix),
        suffix: source.suffix === undefined || source.suffix === null ? '' : String(source.suffix),
        separator: source.separator === undefined || source.separator === null ? '' : String(source.separator),
        note: source.note === undefined || source.note === null ? '' : String(source.note),
    };
}

/**
 * 首次使用时写入的示例规则（默认关闭，避免直接改动用户设置）。
 * @returns {object[]}
 */
export function createDefaultRules() {
    return [
        createRule({
            enabled: false,
            matchType: MATCH_TYPES.WILDCARD,
            pattern: '*DeepSeek*',
            autoParse: true,
            prefix: THINK_OPEN,
            suffix: THINK_CLOSE,
            separator: '\n',
            note: '示例：聊天补全预设名包含 DeepSeek 时，套用 Think XML 标签。启用前请按你的实际标签修改。',
        }),
    ];
}

/**
 * 清理从设置 / JSON 里读到的规则数组。
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeRules(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(item => item && typeof item === 'object').map(item => createRule(item));
}

/**
 * 转义正则元字符。
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 通配符 -> 正则（整串匹配，忽略大小写；* 任意长度，? 单个字符）。
 * @param {string} pattern
 * @returns {RegExp}
 */
export function wildcardToRegExp(pattern) {
    const escaped = escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 判断一条规则是否命中给定的预设名。正则非法、内容为空、规则停用时一律返回 false。
 * @param {object} rule
 * @param {string} presetName
 * @returns {boolean}
 */
export function testRule(rule, presetName) {
    if (!rule || rule.enabled === false) {
        return false;
    }
    const name = String(presetName ?? '');
    const pattern = String(rule.pattern ?? '');
    if (name === '' || pattern === '') {
        return false;
    }
    switch (rule.matchType) {
        case MATCH_TYPES.EXACT:
            return name.toLowerCase() === pattern.toLowerCase();
        case MATCH_TYPES.WILDCARD:
            try {
                return wildcardToRegExp(pattern).test(name);
            } catch {
                return false;
            }
        case MATCH_TYPES.REGEX:
            try {
                return new RegExp(pattern, 'i').test(name);
            } catch {
                return false;
            }
        case MATCH_TYPES.CONTAINS:
        default:
            return name.toLowerCase().includes(pattern.toLowerCase());
    }
}

/**
 * 自上而下找出第一条命中的规则（先匹配先赢）。
 * @param {object[]} rules
 * @param {string} presetName
 * @returns {object|null}
 */
export function findMatchingRule(rules, presetName) {
    for (const rule of Array.isArray(rules) ? rules : []) {
        if (testRule(rule, presetName)) {
            return rule;
        }
    }
    return null;
}

/**
 * 校验规则，返回问题列表。
 * @param {object} rule
 * @returns {{level: 'error'|'warn', message: string}[]}
 */
export function validateRule(rule) {
    const problems = [];
    const pattern = String(rule?.pattern ?? '');
    if (pattern === '') {
        problems.push({ level: 'warn', message: '没有填写匹配内容，这条规则永远不会生效。' });
    }
    if (rule?.matchType === MATCH_TYPES.REGEX && pattern !== '') {
        try {
            new RegExp(pattern, 'i');
        } catch (error) {
            problems.push({ level: 'error', message: `正则表达式无效：${error.message}` });
        }
    }
    if (rule?.autoParse && (String(rule?.prefix ?? '') === '' || String(rule?.suffix ?? '') === '')) {
        problems.push({ level: 'warn', message: '开启自动解析但前缀或后缀留空：留空表示沿用当前值，当前值也为空时 ST 不会解析推理块。' });
    }
    return problems;
}

/**
 * 计算规则要写入 ST 的目标值。
 * 规则里留空的 前缀/后缀/分隔符 表示「不修改」，沿用 current 的值。
 * @param {object} rule
 * @param {{auto_parse?: boolean, prefix?: string, suffix?: string, separator?: string}} [current]
 * @returns {{auto_parse: boolean, prefix: string, suffix: string, separator: string, changed: boolean}}
 */
export function resolveReasoningUpdate(rule, current = {}) {
    const currentAutoParse = !!current?.auto_parse;
    const currentPrefix = current?.prefix ?? '';
    const currentSuffix = current?.suffix ?? '';
    const currentSeparator = current?.separator ?? '';

    const next = {
        auto_parse: typeof rule?.autoParse === 'boolean' ? rule.autoParse : currentAutoParse,
        prefix: String(rule?.prefix ?? '') !== '' ? String(rule.prefix) : currentPrefix,
        suffix: String(rule?.suffix ?? '') !== '' ? String(rule.suffix) : currentSuffix,
        separator: String(rule?.separator ?? '') !== '' ? String(rule.separator) : currentSeparator,
    };

    next.changed = next.auto_parse !== currentAutoParse
        || next.prefix !== currentPrefix
        || next.suffix !== currentSuffix
        || next.separator !== currentSeparator;

    return next;
}

/**
 * 规则的一行文字摘要。
 * @param {object} rule
 * @returns {string}
 */
export function describeRule(rule) {
    const typeLabel = MATCH_TYPE_LIST.find(x => x.value === rule?.matchType)?.label ?? String(rule?.matchType ?? '');
    const pattern = String(rule?.pattern ?? '') === '' ? '（未设置匹配内容）' : `“${rule.pattern}”`;
    const parts = [`${typeLabel} ${pattern}`, `自动解析${rule?.autoParse ? '开' : '关'}`];
    if (String(rule?.prefix ?? '') !== '') {
        parts.push(`前缀 ${rule.prefix}`);
    }
    if (String(rule?.suffix ?? '') !== '') {
        parts.push(`后缀 ${rule.suffix}`);
    }
    if (rule?.note) {
        parts.push(String(rule.note));
    }
    return parts.join(' · ');
}

/**
 * 导出为可读 JSON 字符串。
 * @param {object[]} rules
 * @returns {string}
 */
export function exportRules(rules) {
    return JSON.stringify({ version: 1, rules: normalizeRules(rules) }, null, 2);
}

/**
 * 从 JSON 字符串导入规则。支持 `[...]` 或 `{ "rules": [...] }` 两种格式。
 * @param {string} text
 * @returns {object[]}
 * @throws {Error} 内容非法时抛出
 */
export function importRules(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') {
        throw new Error('文本框内容为空。');
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        throw new Error(`不是合法的 JSON：${error.message}`);
    }
    const list = Array.isArray(data) ? data : data?.rules;
    if (!Array.isArray(list)) {
        throw new Error('JSON 里找不到 rules 数组。');
    }
    return normalizeRules(list);
}
