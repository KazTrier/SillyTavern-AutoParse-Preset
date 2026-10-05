/**
 * detect.js 的离线单元测试（不依赖 SillyTavern、不依赖浏览器）。
 *
 * 运行：node test/detect.test.mjs
 *
 * 其中的用例形态来自对真实聊天补全预设的观察（标签名与措辞为等价改写）：
 *   - 明确写「wrapped in `<thought></thought>` tag」+ 大量结构性标签
 *   - 「reason using '<think>' tags」并给出示例
 *   - 只有结构性标签（<CHAT_HISTORY>/<CHARACTERS>/<details>），没有思维链标签
 *   - 中文说明「把思考过程写在 <inner_voice></inner_voice> 之间」
 *   - 中文/全角括号、【思考】、[[thinking]] 等自定义形式
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'detect.js'), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);

const {
    collectPresetTexts,
    detectReasoningTags,
    isApplicable,
    describeCandidate,
    TAG_STYLES,
    STRUCTURAL_TAG_BLOCKLIST,
} = mod;

/** 拼接构造特殊标签字面量，避免写入/传输时被吞掉尖括号 */
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const THINK_OPEN = LT + 'think' + GT;

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

const chunksOf = (...texts) => texts.map((text, index) => ({ source: `prompt${index}`, text }));
/** 允许传入单个字符串、字符串数组或不定参数 */
const bestOf = (texts, mode = 'safe') => {
    const list = Array.isArray(texts) ? texts : [texts];
    return detectReasoningTags(chunksOf(...list), { mode }).best;
};

console.log('detect.js');

/* ---------------- 关键词标签 ---------------- */

test('英文说明「wrapped in `<thought></thought>` tag」→ 选中 <thought>', () => {
    const best = bestOf([
        'At the start of your response, do reasoning steps strictly using the shown thought template wrapped in `<thought></thought>` tag and with [brackets] replaced by content.',
        '<npc>{{char}}</npc>\n<player>{{user}}</player>\n<INSTRUCTIONS>stay in character</INSTRUCTIONS>',
    ]);
    assert.ok(best, '应当识别出标签');
    assert.equal(best.prefix, '<thought>');
    assert.equal(best.suffix, '</thought>');
    assert.equal(best.keyword, true);
    assert.equal(best.instruction, true);
    assert.equal(best.pairing, 'symmetric');
});

test('「reason using \'<think>\' tags」→ 选中 <think>', () => {
    const best = bestOf([
        "At the beginning of each reply, reason using '<think>' tags, no drafting. 200 words max.",
        '<think>\nstep 1\n</think>\n<CONTEXT>{{scenario}}</CONTEXT>',
    ]);
    assert.equal(best?.prefix, '<think>');
    assert.equal(best?.suffix, '</think>');
});

test('思维链条目里：关键词标签优先于出现次数更多的结构性标签', () => {
    const res = detectReasoningTags([{
        source: 'cot',
        name: '🧠思维链-主块',
        text: '<latest_message>hi</latest_message>'.repeat(9) + '\n<CONTEXT>a</CONTEXT>\n<Reasoning>think here</Reasoning>',
    }], { mode: 'safe' });
    assert.equal(res.pool, 'cot-primary');
    assert.equal(res.best?.tagName, 'Reasoning');
});

/* ---------------- 必须判为「无」的情况 ---------------- */

test('只有结构性标签 → safe 模式返回 null，不改动设置', () => {
    const result = detectReasoningTags(chunksOf(
        '<CHAT_HISTORY>{{history}}</CHAT_HISTORY>',
        '<CHARACTERS><details>age</details></CHARACTERS>',
        '<objective>stay in character</objective>',
    ), { mode: 'safe' });
    assert.equal(result.best, null);
    assert.equal(result.pool, 'empty');
    assert.equal(result.candidates.length, 0, 'safe 模式不展示非思维链条目的候选');
    assert.ok(result.ignoredCandidates.length > 0, '被忽略的候选仍应可查（报告里会提示数量）');
});

test('结构性标签即使成对出现也不会被 safe 模式采用', () => {
    const best = bestOf('Always output everything inside <INSTRUCTIONS></INSTRUCTIONS> tags.');
    assert.equal(best, null);
});

test('空文本 / 空数组 → 返回 null 而不是抛异常', () => {
    assert.equal(detectReasoningTags([], { mode: 'safe' }).best, null);
    assert.equal(detectReasoningTags(chunksOf('', '   '), { mode: 'safe' }).best, null);
    assert.equal(detectReasoningTags(null, { mode: 'safe' }).best, null);
});

/* ---------------- 自定义标签（无关键词，靠「包裹说明」） ---------------- */

test('自定义标签 + 中文包裹说明 → safe 模式也能识别', () => {
    const best = bestOf('请把所有思考过程写在 <inner_voice></inner_voice> 之间，正文另起一行。');
    assert.equal(best?.prefix, '<inner_voice>');
    assert.equal(best?.suffix, '</inner_voice>');
    // 「内心/inner」不再算思维链关键词（NPC 内心话是给玩家看的正文），靠「包裹说明」识别
    assert.equal(best?.keyword, false);
    assert.equal(best?.instruction, true);
});

test('完全自定义的名字也能靠「包裹说明」识别', () => {
    const best = bestOf('Always put your reasoning inside <zp9_block></zp9_block> before writing the answer.');
    assert.equal(best?.prefix, '<zp9_block>');
    assert.equal(best?.suffix, '</zp9_block>');
    assert.equal(best?.keyword, false);
    assert.equal(best?.instruction, true);
    assert.equal(isApplicable(best, 'safe'), true);
});

test('自定义标签 + 中文括号形式【思考】/【/思考】', () => {
    const best = bestOf('把推理内容放在【思考】【/思考】里，不要写进正文。');
    assert.equal(best?.prefix, '【思考】');
    assert.equal(best?.suffix, '【/思考】');
});

test('[[thinking]] / [[/thinking]] 形式', () => {
    const best = bestOf('Wrap the chain of thought in [[thinking]] ... [[/thinking]] tags.');
    assert.equal(best?.prefix, '[[thinking]]');
    assert.equal(best?.suffix, '[[/thinking]]');
});

test('（think）/(/think) 形式', () => {
    const best = bestOf('Thinking goes inside (think) ... (/think).');
    assert.equal(best?.prefix, '(think)');
    assert.equal(best?.suffix, '(/think)');
});

/* ---------------- 单边出现 ---------------- */

test('只出现开标记 <thinking> → 合成闭合标签，safe 模式仅报告不套用', () => {
    const result = detectReasoningTags(chunksOf('开始时请用 <thinking> 标签记录思考。'), { mode: 'safe' });
    const candidate = result.candidates.find(item => item.tagName === 'thinking');
    assert.ok(candidate);
    assert.equal(candidate.pairing, 'synthesized');
    assert.equal(candidate.suffix, '</thinking>');
    assert.equal(result.best, null, 'safe 模式不应套用推断出来的闭合标签');
    assert.equal(detectReasoningTags(chunksOf('开始时请用 <thinking> 标签记录思考。'), { mode: 'aggressive' }).best?.suffix, '</thinking>');
});

test('开标记 + DeepSeek V3.1 风格的结束标记 → 按关键词配对，safe 模式可用', () => {
    const endMarker = LT + '｜end▁of▁thinking｜' + GT;
    const best = bestOf(`Reason inside ${THINK_OPEN} and finish with ${endMarker} before the reply.`);
    assert.equal(best?.prefix, THINK_OPEN);
    assert.equal(best?.suffix, endMarker);
    assert.equal(best?.pairing, 'keyword');
    assert.equal(isApplicable(best, 'safe'), true);
});

/* ---------------- 模式与打分 ---------------- */

test('aggressive 模式会采用任何成对标签，safe 不会', () => {
    const texts = ['<extra_info>note</extra_info>'];
    assert.equal(bestOf(texts, 'safe'), null);
    assert.equal(bestOf(texts, 'aggressive')?.tagName, 'extra_info');
});

test('黑名单标签即使是 aggressive 候选也带 blocklisted 标记', () => {
    const result = detectReasoningTags(chunksOf('<CHAT_HISTORY>a</CHAT_HISTORY>'), { mode: 'aggressive' });
    assert.equal(result.candidates[0].blocklisted, true);
    assert.equal(isApplicable(result.candidates[0], 'aggressive'), false);
});

test('候选按得分排序，关键词标签排在前面', () => {
    const result = detectReasoningTags(chunksOf(
        '<alpha>1</alpha>\n<beta>2</beta>\n<thought>x</thought>\nThink inside <thought></thought> tags.',
    ), { mode: 'safe' });
    assert.equal(result.candidates[0].tagName, 'thought');
});

test('候选数量受 limit 限制', () => {
    const text = ['aa', 'bb', 'cc', 'dd', 'ee'].map(name => `<${name}>x</${name}>`).join('\n');
    assert.equal(detectReasoningTags(chunksOf(text), { mode: 'aggressive', limit: 3 }).candidates.length, 3);
});

/* ---------------- collectPresetTexts ---------------- */

test('collectPresetTexts：收录提示词名字与正文，并带上来源', () => {
    const chunks = collectPresetTexts({
        prompts: [
            { identifier: 'main', name: 'Main Prompt', content: 'wrap in <thought></thought>' },
            { identifier: 'npc', name: 'NPCs', content: '' },
        ],
    });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].source, 'main (Main Prompt)');
    assert.match(chunks[0].text, /Main Prompt/);
    assert.match(chunks[0].text, /<thought>/);
});

test('collectPresetTexts：跳过代理地址、API Key 与其它预设级噪声', () => {
    const chunks = collectPresetTexts({
        reverse_proxy: 'https://user:pass@example.com/v1',
        api_key: 'sk-secret-value',
        proxy_password: 'hunter2',
        assistant_prefill: '<thinking>ok',
        prompts: [],
    });
    const joined = chunks.map(chunk => chunk.text).join('\n');
    assert.doesNotMatch(joined, /sk-secret-value|hunter2|user:pass/);
    assert.match(joined, /<thinking>ok/);
    assert.ok(chunks.some(chunk => chunk.source === 'assistant_prefill'));
});

test('collectPresetTexts：遵守字符上限', () => {
    const chunks = collectPresetTexts({ prompts: [{ identifier: 'a', name: 'A', content: 'x'.repeat(5000) }] }, { limit: 100 });
    assert.ok(chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) <= 100);
});

test('collectPresetTexts：容忍畸形输入', () => {
    assert.deepEqual(collectPresetTexts(null), []);
    assert.deepEqual(collectPresetTexts({ prompts: 'nope' }), []);
    assert.deepEqual(collectPresetTexts({ prompts: [null, 42, {}] }), []);
});

/* ---------------- 端到端：预设对象 → 识别结果 ---------------- */

const likeRealPreset = {
    temperature: 1,
    reverse_proxy: 'https://proxy.local/v1',
    prompts: [
        {
            identifier: 'main',
            name: 'Main Prompt',
            content: 'Write {{char}}\'s next reply. At the start of your response, do reasoning steps strictly using the shown thought template wrapped in `<thought></thought>` tag.',
        },
        { identifier: 'npc', name: 'NPCs', content: '<npc>{{char}}</npc>\n<player>{{user}}</player>' },
        { identifier: 'instructions', name: 'INSTRUCTIONS', content: '<INSTRUCTIONS>\nBe realistic.\n</INSTRUCTIONS>' },
        { identifier: 'history', name: 'Chat History', content: '<CHAT_HISTORY>{{history}}</CHAT_HISTORY>' },
    ],
};

test('预设对象端到端：识别出 <thought></thought>，忽略 <npc>/<INSTRUCTIONS>', () => {
    const result = detectReasoningTags(collectPresetTexts(likeRealPreset), { mode: 'safe' });
    assert.equal(result.best?.prefix, '<thought>');
    assert.equal(result.best?.suffix, '</thought>');
    assert.ok(result.best.sources.includes('main (Main Prompt)'));
    assert.match(result.best.evidence, /thought/);
});

test('预设对象端到端：没有思维链标签时返回 null', () => {
    const preset = {
        prompts: [
            { identifier: 'main', name: 'Main', content: 'Write the reply.' },
            { identifier: 'ctx', name: 'CONTEXT', content: '<CONTEXT>{{scenario}}</CONTEXT>' },
            { identifier: 'hist', name: 'CHAT_HISTORY', content: '<CHAT_HISTORY>{{history}}</CHAT_HISTORY>' },
        ],
    };
    assert.equal(detectReasoningTags(collectPresetTexts(preset), { mode: 'safe' }).best, null);
});

/* ---------------- 描述与常量 ---------------- */

test('describeCandidate 描述包含前后缀、配对方式与得分', () => {
    const best = bestOf('Think inside `<thought></thought>` tags.');
    const text = describeCandidate(best);
    assert.match(text, /<thought>/);
    assert.match(text, /开闭成对/);
    assert.match(text, /得分/);
});

test('常量表结构正常', () => {
    assert.ok(TAG_STYLES.length >= 8);
    assert.ok(TAG_STYLES.every(style => style.left && style.right));
    assert.ok(STRUCTURAL_TAG_BLOCKLIST.includes('chat_history'));
    assert.equal(describeCandidate(null), '无候选');
});

/* ---------------- 真实大型预设的形态（咩咩预设 ver 0.9.0 的等价改写） ---------------- */

const chunkyLike = {
    prompt_order: [{
        character_id: 100001,
        order: [
            { identifier: 'divider', enabled: true },
            { identifier: 'init', enabled: true },
            { identifier: 'acg', enabled: true },
            { identifier: 'mode', enabled: false },
            { identifier: 'card-prefill', enabled: false },
        ],
    }],
    prompts: [
        { identifier: 'divider', name: '1️⃣思维链', content: '' },
        { identifier: 'init', name: '🧠初始化', content: '{{addvar::story_think_ini::\n[初始化]: 输出推理过程\n}}' },
        {
            identifier: 'acg',
            name: '🎭acg角色心理模型(需搭配世界书)',
            content: '{{setvar::acg角色心理模型_思维链::\n<acg_think_format>\n请严格按照以下 XML 格式输出：\n<acg_think>\nNPC名称:属性\n</acg_think>\n</acg_think_format>\n}}\n\n{{setvar::acg_think_format::\n<acg_think>...</acg_think>。\n}}',
        },
        { identifier: 'mode', name: '🧠思维链-故事模式(多选一)', content: '{{setvar::story_think_format::\n<story_driver>...</story_driver>\n}}' },
        {
            identifier: 'card-prefill',
            name: '🧷卡原生思维链-预填充',
            content: '</story_driver><|no-trans|>\n</thinking><|no-trans|>\n</think><|no-trans|>\n<think>\nthink is over...\n</think>',
        },
    ],
};

const enabledIdsOf = (preset) => new Set(
    (preset.prompt_order?.[0]?.order ?? []).filter(item => item.enabled).map(item => String(item.identifier)),
);

test('咩咩形态：只读思维链条目，压原生思维链的预填充被排除，选中 <story_driver>', () => {
    const res = detectReasoningTags(collectPresetTexts(chunkyLike, { enabledIds: enabledIdsOf(chunkyLike) }), { mode: 'safe' });
    assert.ok(res.best, '应当识别出标签');
    assert.equal(res.best.prefix, '<story_driver>');
    assert.equal(res.best.suffix, '</story_driver>');
    assert.equal(res.best.cotEntry, true);
    assert.equal(res.candidates.some(c => c.tagName === 'think'), false, '压制型预填充里的 <think> 不应出现');
});

test('反思维链条目整个排除：卡原生思维链-预填充里的 </think> 不会被误用', () => {
    const chunks = [
        {
            source: 'killer',
            name: '🧷卡原生思维链-预填充',
            text: '</story_driver><|no-trans|>\n</thinking><|no-trans|>\n</think><|no-trans|>\n<think>\nthink is over...\n</think>',
        },
        { source: 'real', name: '🧠思维链-故事模式', text: '{{setvar::story_think_format::\n把思考写在 <story_driver></story_driver> 里\n}}' },
    ];
    const res = detectReasoningTags(chunks, { mode: 'safe' });
    assert.equal(res.best?.tagName, 'story_driver');
    assert.equal(res.candidates.some(c => c.tagName === 'think'), false);
    assert.equal(res.candidates.some(c => c.tagName === 'thinking'), false);
});

test('收尾型条目（闭合标记多于开标记）即使名字含思维链也被排除', () => {
    const chunks = [
        { source: 'closer', name: '思维链-收尾预填充', text: '</thinking>\n</think>\n</reasoning>' },
        { source: 'giver', name: '思维链-格式', text: '把思考写在 <inner_voice></inner_voice> 里' },
    ];
    const res = detectReasoningTags(chunks, { mode: 'safe' });
    assert.equal(res.best?.tagName, 'inner_voice');
    for (const name of ['thinking', 'think', 'reasoning']) {
        assert.equal(res.candidates.some(c => c.tagName === name), false, `${name} 不应作为候选`);
    }
});

test('pool 反映来源级别：cot-primary / cot-secondary / instruction / empty', () => {
    const primary = detectReasoningTags([{ source: 'a', name: '🧠思维链', text: '<story_driver>…</story_driver>' }], { mode: 'safe' });
    assert.equal(primary.pool, 'cot-primary');
    assert.equal(primary.best?.tagName, 'story_driver');
    assert.equal(primary.tier, 4);

    const secondary = detectReasoningTags([{ source: 'b', name: '📍常规创作思维', text: '<electric>…</electric>' }], { mode: 'safe' });
    assert.equal(secondary.pool, 'cot-secondary');
    assert.equal(secondary.best?.tagName, 'electric');

    const instructed = detectReasoningTags([{ source: 'c', name: '主提示词', text: '把思考写在 <inner_voice></inner_voice> 里' }], { mode: 'safe' });
    assert.equal(instructed.pool, 'instruction');
    assert.equal(instructed.best?.tagName, 'inner_voice');

    const none = detectReasoningTags([{ source: 'd', name: '主提示词', text: '<npc>a</npc>' }], { mode: 'safe' });
    assert.equal(none.pool, 'empty');
    assert.equal(none.best, null);
});

test('名称级思维链条目优先于仅靠内容说明的条目', () => {
    const chunks = [
        { source: 'instr', name: '主提示词', text: '把思考写在 <inner_voice></inner_voice> 里' },
        { source: 'cot', name: '🧠思维链-主块', text: '<story_driver>…</story_driver>' },
    ];
    const res = detectReasoningTags(chunks, { mode: 'safe' });
    assert.equal(res.pool, 'cot-primary');
    assert.equal(res.best?.tagName, 'story_driver');
    assert.equal(res.candidates.some(c => c.tagName === 'inner_voice'), false);
});

test('咩咩形态：STscript 宏（{{setvar::x::}} / {{getvar::x}}）绝不作为候选', () => {
    const res = detectReasoningTags(collectPresetTexts(chunkyLike, { enabledIds: enabledIdsOf(chunkyLike) }), { mode: 'aggressive' });
    assert.ok(res.candidates.length > 0);
    for (const candidate of res.candidates) {
        assert.doesNotMatch(candidate.prefix, /\{\{|::/, `候选出现宏: ${candidate.prefix}`);
        assert.doesNotMatch(candidate.tagName, /::/);
    }
});

test('咩咩形态：`_format` 外壳标签得分低于真正的块，且不算思维链条目', () => {
    const res = detectReasoningTags(collectPresetTexts(chunkyLike, { enabledIds: enabledIdsOf(chunkyLike) }), { mode: 'aggressive' });
    const shell = res.candidates.find(c => c.tagName === 'acg_think_format');
    const block = res.candidates.find(c => c.tagName === 'acg_think');
    assert.ok(shell, '外壳标签仍应作为候选出现（供参考）');
    assert.ok(block);
    assert.ok(shell.score < block.score, `外壳 ${shell.score} 应低于块 ${block.score}`);
    assert.equal(shell.cotEntry, false);
});

test('思维链条目里的干净成对标签在 safe 模式可直接采用', () => {
    const chunks = [
        { source: 'acg', text: '<acg_think_format>\n<acg_think>...</acg_think>\n</acg_think_format>', name: '🎭acg角色心理模型' },
        { source: 'cot', text: '{{setvar::story_think_format::\n<story_driver>...</story_driver>\n}}', name: '🧠思维链-故事模式' },
    ];
    const res = detectReasoningTags(chunks, { mode: 'safe' });
    assert.equal(res.cotCandidateCount > 0, true);
    assert.equal(res.best?.tagName, 'story_driver');
    assert.equal(res.best?.cotEntry, true);
});

test('开标记与闭合标记不在同一条目时不配对（防跨条目瞎凑）', () => {
    const chunks = [
        { source: 'a', text: '请把思考写在 <tagthink> 里', name: 'entryA' },
        { source: 'b', text: '结束标记是 <|end_thinking|>', name: 'entryB' },
    ];
    const res = detectReasoningTags(chunks, { mode: 'safe' });
    assert.equal(res.candidates.some(c => c.pairing === 'keyword'), false);
    assert.equal(res.candidates.some(c => c.suffix === '<|end_thinking|>'), false);
    assert.equal(res.best, null);
});

test('collectPresetTexts：带 enabledIds 时标记启用状态，不带时为 undefined', () => {
    const withIds = collectPresetTexts(chunkyLike, { enabledIds: enabledIdsOf(chunkyLike) });
    const byIdentifier = new Map(withIds.map(chunk => [chunk.identifier, chunk]));
    assert.equal(byIdentifier.get('acg').enabled, true);
    assert.equal(byIdentifier.get('mode').enabled, false);
    assert.equal(byIdentifier.get('acg').name, '🎭acg角色心理模型(需搭配世界书)');

    const withoutIds = collectPresetTexts(chunkyLike);
    assert.equal(withoutIds.find(chunk => chunk.identifier === 'acg').enabled, undefined);
});

test('思维链条目里的标签即使未启用也能被选中（多选一模式常常刚切过）', () => {
    const res = detectReasoningTags(collectPresetTexts(chunkyLike), { mode: 'safe' });
    assert.ok(res.best);
    assert.equal(res.best.cotEntry, true);
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const { name, error } of failures) {
        console.error(`- ${name}\n  ${error.stack ?? error.message}`);
    }
    process.exit(1);
}
