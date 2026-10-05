/**
 * rules.js 的离线单元测试（不依赖 SillyTavern、不依赖浏览器）。
 *
 * 运行：node test/rules.test.mjs
 *
 * rules.js 是 ES module，但扩展目录里没有 package.json（避免 ST 安装扩展时触发 npm install），
 * 所以这里把源码按 data: URL 载入，绕开 Node 对 .js 后缀的 CommonJS 判定。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'rules.js'), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);

const {
    MATCH_TYPES,
    TAG_TEMPLATES,
    createRule,
    createDefaultRules,
    normalizeRules,
    wildcardToRegExp,
    testRule,
    findMatchingRule,
    validateRule,
    resolveReasoningUpdate,
    describeRule,
    exportRules,
    importRules,
} = mod;

/** 与 rules.js 相同的拼接构造：防止字面量在写入/传输时被吞掉尖括号 */
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const THINK_OPEN = LT + 'think' + GT;
const THINK_CLOSE = LT + '/' + 'think' + GT;

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

console.log('rules.js');

/* ---------- 匹配 ---------- */

test('包含匹配：忽略大小写', () => {
    const rule = createRule({ matchType: MATCH_TYPES.CONTAINS, pattern: 'deepseek' });
    assert.equal(testRule(rule, 'My DeepSeek V3.1'), true);
    assert.equal(testRule(rule, 'qwen3'), false);
});

test('完全相同匹配：大小写不敏感、不做子串', () => {
    const rule = createRule({ matchType: MATCH_TYPES.EXACT, pattern: 'DeepSeek V3' });
    assert.equal(testRule(rule, 'deepseek v3'), true);
    assert.equal(testRule(rule, 'DeepSeek V3.1'), false);
});

test('通配符：* 任意长度、? 单个字符，且整串匹配', () => {
    assert.equal(wildcardToRegExp('DeepSeek*').test('DeepSeek V3'), true);
    assert.equal(wildcardToRegExp('DeepSeek*').test('My DeepSeek V3'), false);
    assert.equal(wildcardToRegExp('*D?ep*').test('xxDeepyy'), true);
    const rule = createRule({ matchType: MATCH_TYPES.WILDCARD, pattern: '*DeepSeek*' });
    assert.equal(testRule(rule, 'My DeepSeek V3.1'), true);
});

test('通配符：正则元字符按字面量处理', () => {
    const rule = createRule({ matchType: MATCH_TYPES.WILDCARD, pattern: 'a+b(c)' });
    assert.equal(testRule(rule, 'a+b(c)'), true);
    assert.equal(testRule(rule, 'aabcc'), false);
});

test('正则匹配：普通与非法表达式', () => {
    const ok = createRule({ matchType: MATCH_TYPES.REGEX, pattern: '^(Claude|GPT)' });
    assert.equal(testRule(ok, 'Claude 4.5'), true);
    assert.equal(testRule(ok, 'My Claude'), false);

    const broken = createRule({ matchType: MATCH_TYPES.REGEX, pattern: '([unclosed' });
    assert.doesNotThrow(() => testRule(broken, 'anything'));
    assert.equal(testRule(broken, 'anything'), false);
});

test('停用规则 / 空匹配内容 / 空预设名 一律不命中', () => {
    assert.equal(testRule(createRule({ enabled: false, pattern: 'x' }), 'x'), false);
    assert.equal(testRule(createRule({ pattern: '' }), 'anything'), false);
    assert.equal(testRule(createRule({ pattern: 'x' }), ''), false);
});

test('findMatchingRule：自上而下，第一条命中优先', () => {
    const rules = [
        createRule({ matchType: MATCH_TYPES.WILDCARD, pattern: 'DeepSeek*', prefix: 'A' }),
        createRule({ matchType: MATCH_TYPES.CONTAINS, pattern: 'DeepSeek', prefix: 'B' }),
    ];
    assert.equal(findMatchingRule(rules, 'DeepSeek V3').prefix, 'A');
    assert.equal(findMatchingRule(rules, 'My DeepSeek')?.prefix, 'B');
    assert.equal(findMatchingRule(rules, 'Qwen'), null);
});

test('findMatchingRule：跳过停用规则', () => {
    const rules = [
        createRule({ enabled: false, pattern: 'DeepSeek' }),
        createRule({ pattern: 'DeepSeek', prefix: 'B' }),
    ];
    assert.equal(findMatchingRule(rules, 'DeepSeek V3').prefix, 'B');
});

/* ---------- 校验 ---------- */

test('validateRule：空匹配内容给出提醒', () => {
    const problems = validateRule(createRule({ pattern: '' }));
    assert.equal(problems.some(p => p.level === 'warn' && p.message.includes('永远不会生效')), true);
});

test('validateRule：非法正则报错', () => {
    const problems = validateRule(createRule({ matchType: MATCH_TYPES.REGEX, pattern: '([', prefix: 'a', suffix: 'b' }));
    assert.equal(problems.some(p => p.level === 'error'), true);
});

test('validateRule：开启自动解析但前后缀留空给出提醒', () => {
    const problems = validateRule(createRule({ pattern: 'x', autoParse: true, prefix: 'a', suffix: '' }));
    assert.equal(problems.some(p => p.level === 'warn' && p.message.includes('自动解析')), true);
    assert.equal(validateRule(createRule({ pattern: 'x', autoParse: false, prefix: '', suffix: '' })).length, 0);
});

/* ---------- 目标值计算 ---------- */

test('resolveReasoningUpdate：留空的字段沿用当前值', () => {
    const current = { auto_parse: true, prefix: '<old>', suffix: '</old>', separator: '\n' };
    const update = resolveReasoningUpdate(createRule({ prefix: THINK_OPEN, suffix: '', separator: '' }), current);
    assert.equal(update.prefix, THINK_OPEN);
    assert.equal(update.suffix, '</old>');
    assert.equal(update.separator, '\n');
    assert.equal(update.auto_parse, true);
    assert.equal(update.changed, true);
});

test('resolveReasoningUpdate：目标值与当前一致时 changed=false', () => {
    const current = { auto_parse: true, prefix: ' a', suffix: ' b', separator: '' };
    const update = resolveReasoningUpdate(createRule({ autoParse: true, prefix: ' a', suffix: ' b' }), current);
    assert.equal(update.changed, false);
});

test('resolveReasoningUpdate：可以只切换自动解析开关', () => {
    const current = { auto_parse: true, prefix: ' a', suffix: ' b', separator: '' };
    const update = resolveReasoningUpdate(createRule({ autoParse: false, prefix: '', suffix: '' }), current);
    assert.equal(update.auto_parse, false);
    assert.equal(update.prefix, ' a');
    assert.equal(update.changed, true);
});

/* ---------- 序列化 ---------- */

test('normalizeRules：丢弃垃圾数据并补齐字段', () => {
    const rules = normalizeRules([null, 'x', 42, { pattern: 'DeepSeek' }]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].pattern, 'DeepSeek');
    assert.equal(typeof rules[0].id, 'string');
    assert.equal(rules[0].enabled, true);
    assert.equal(rules[0].autoParse, true);
    assert.deepEqual(normalizeRules('nope'), []);
});

test('normalizeRules：非法的 matchType 回退到「包含」', () => {
    assert.equal(normalizeRules([{ matchType: 'bogus' }])[0].matchType, MATCH_TYPES.CONTAINS);
});

test('exportRules / importRules：往返一致', () => {
    const rules = [createRule({ matchType: MATCH_TYPES.WILDCARD, pattern: '*Qwen*', prefix: '<a>', suffix: '</a>', separator: '\n' })];
    const restored = importRules(exportRules(rules));
    assert.equal(restored.length, 1);
    assert.deepEqual(
        { ...restored[0], id: rules[0].id },
        rules[0],
    );
});

test('importRules：也接受裸数组', () => {
    const rules = importRules(JSON.stringify([{ pattern: 'GLM' }]));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].pattern, 'GLM');
});

test('importRules：空内容 / 非 JSON / 缺 rules 都会抛错', () => {
    assert.throws(() => importRules(''), /内容为空/);
    assert.throws(() => importRules('{oops'), /不是合法的 JSON/);
    assert.throws(() => importRules('{"version":1}'), /rules/);
});

test('describeRule：包含匹配方式、开关与前后缀', () => {
    const text = describeRule(createRule({ matchType: MATCH_TYPES.CONTAINS, pattern: 'DeepSeek', autoParse: true, prefix: ' ', suffix: THINK_CLOSE }));
    assert.match(text, /包含/);
    assert.match(text, /DeepSeek/);
    assert.match(text, /自动解析开/);
    assert.match(text, /后缀/);
});

/* ---------- 内置数据 ---------- */

test('默认规则：只有一条、默认停用，且前后缀是完整的 <think> / </think>', () => {
    const rules = createDefaultRules();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enabled, false);
    assert.equal(rules[0].prefix, THINK_OPEN);
    assert.equal(rules[0].suffix, THINK_CLOSE);
    assert.equal(testRule(rules[0], 'DeepSeek V3'), false);
});

test('标签模板：Think XML 的前后缀可用，且 id 唯一', () => {
    const think = TAG_TEMPLATES.find(t => t.id === 'think-xml');
    assert.equal(think.prefix, THINK_OPEN);
    assert.equal(think.suffix, THINK_CLOSE);
    assert.equal(new Set(TAG_TEMPLATES.map(t => t.id)).size, TAG_TEMPLATES.length);
});

test('回归：标签常量的码点必须是完整尖括号标签（防被特殊 token 吞掉）', () => {
    const think = TAG_TEMPLATES.find(t => t.id === 'think-xml');
    const dsv31 = TAG_TEMPLATES.find(t => t.id === 'think-xml-dsv31');
    // < t h i n k >
    assert.deepEqual([...think.prefix].map(c => c.codePointAt(0)), [60, 116, 104, 105, 110, 107, 62]);
    // < / t h i n k >
    assert.deepEqual([...think.suffix].map(c => c.codePointAt(0)), [60, 47, 116, 104, 105, 110, 107, 62]);
    assert.equal(dsv31.prefix, THINK_OPEN);
    assert.equal(dsv31.suffix, `<｜end▁of▁thinking｜>`);
    for (const template of TAG_TEMPLATES) {
        if (template.id === 'custom') {
            continue; // 「自定义」模板本来就不预填
        }
        assert.ok(template.prefix !== '' && template.suffix !== '', `模板 ${template.id} 的前后缀都不应为空`);
    }
});

/* ---------- 汇总 ---------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const { name, error } of failures) {
        console.error(`- ${name}\n  ${error.stack ?? error.message}`);
    }
    process.exit(1);
}
