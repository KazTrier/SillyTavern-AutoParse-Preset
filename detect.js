/**
 * 纯逻辑模块：从「预设文本」里推断思维链的前后缀标签。
 *
 * 设计目标（按真实预设的形态倒推）：
 *  - 预设通常会用一句话说明思维链格式，例如
 *      "reasoning steps strictly using the shown thought template wrapped in `<thought></thought>` tag"
 *      "把思考过程写在 <inner_voice></inner_voice> 之间"
 *      "reason using '<think>' tags"
 *    并/或在提示词里给出使用示例。
 *  - 同一份预设里往往还夹着大量**结构性标签**（<npc> <CONTEXT> <INSTRUCTIONS> <CHAT_HISTORY> …），
 *    它们不是思维链，必须排除。
 *  - 有的预设（如 Neko / chatseek 一类）根本没有思维链标签 —— 这时必须返回「无」，
 *    否则会把用户原有的前后缀改坏。
 *
 * 因此打分只依赖三类证据：
 *   1. 标签名本身是否与思维链相关（keyword）
 *   2. 出现该标签的那一行里，是否同时有「包裹/写在/inside/tag」这类措辞和思维链字样（instruction）
 *   3. 是开闭成对，还是只出现了单边（symmetric / keyword / synthesized）
 * 外加结构性标签黑名单。
 *
 * 本文件不 import 任何 SillyTavern 模块，可离线测试（见 test/detect.test.mjs）。
 */

/** 会被扫描的括号风格（顺序影响不大，排序时以得分优先） */
export const TAG_STYLES = Object.freeze([
    { left: '<|', right: '|>' },
    { left: '<<', right: '>>' },
    { left: '[[', right: ']]' },
    { left: '{{', right: '}}' },
    { left: '<', right: '>' },
    { left: '【', right: '】' },
    { left: '『', right: '』' },
    { left: '「', right: '」' },
    { left: '[', right: ']' },
    { left: '(', right: ')' },
    { left: '|', right: '|' },
]);

/**
 * 标签名里允许出现的字符：不能是任何分隔符，也不能有空白。
 * 允许全角竖线 ｜，因为 DeepSeek V3.1 的结束标记是 `<｜end▁of▁thinking｜>` 这种形式。
 */
const NAME_CHARS = '[^<>|【】『』「」\\[\\]{}()\\s]';

/** 标签名 / 附近文本里出现这些词，说明和思维链有关 */
const THINKING_PATTERN = /(think|thought|reason|analysis|analy[sz]e|chain[_\s-]?of[_\s-]?thought|\bcot\b|scratchpad|reflect|deliberat|inner|monologue|内心|思考|思维|推理|沉思|分析)/i;

/** 「把它包起来 / 写在里面」这类措辞 */
const WRAP_CUE_PATTERN = /(wrap|wrapped|tagged|\btags?\b|inside|between|surround|enclose|using|use\s+the|spans?\b|put\s|place\s|write\s|output\s|begin\s|start\s|format|格式|标签|包裹|写在|放在|括在|之间|之内|中间|用\s*[<【「『\[{(]|使用|输出|以.{0,6}(开头|结尾))/i;

/** 结构性 / 格式类标签，肯定不是思维链 */
export const STRUCTURAL_TAG_BLOCKLIST = Object.freeze([
    'instructions', 'instruction', 'context', 'history', 'chat_history', 'chathistory',
    'scenario', 'examples', 'example', 'npc', 'npcs', 'player', 'user', 'char',
    'character', 'characters', 'goal', 'objective', 'details', 'world', 'lore',
    'summary', 'description', 'personality', 'system', 'main', 'prompt', 'jailbreak',
    'nsfw', 'rules', 'guidelines', 'format', 'formatting', 'output', 'tags', 'tag',
    'latest_message', 'story_progression', 'realism', 'favoritism', 'character_growth',
]);

/** XML 风格才能安全地合成闭合标签 */
const SYNTHESIZABLE_STYLES = new Set(['<', '<|', '<<']);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 该名字看起来是「闭合标记」吗？
 * 覆盖 </x>、<|/x|>、<｜end▁of▁thinking｜>、<end_thinking> 等形式。
 * @param {string} name
 */
function isClosingName(name) {
    const value = String(name).trim();
    if (value === '') {
        return true;
    }
    if (/^[/|｜]/.test(value)) {
        return true;
    }
    if (/^(end|stop|close|finish)\b/i.test(value)) {
        return true;
    }
    if (/(^|[_\s-])(end|stop|close|finish)([_\s-]|$)/i.test(value)) {
        return true;
    }
    return false;
}

/**
 * 把预设对象里所有可能有用的字符串收集起来。
 * @param {object} preset getChatCompletionPreset() 的返回值
 * @param {{limit?: number}} [options]
 * @returns {{source: string, text: string}[]}
 */
export function collectPresetTexts(preset, { limit = 400000 } = {}) {
    const chunks = [];
    let budget = limit;

    const push = (source, text) => {
        const value = String(text ?? '');
        if (budget <= 0 || value.trim() === '') {
            return;
        }
        const clipped = value.length > budget ? value.slice(0, budget) : value;
        budget -= clipped.length;
        chunks.push({ source, text: clipped });
    };

    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    for (const prompt of prompts) {
        if (!prompt || typeof prompt !== 'object') {
            continue;
        }
        const identifier = String(prompt.identifier ?? 'prompt');
        const name = String(prompt.name ?? '');
        push(`${identifier}${name ? ` (${name})` : ''}`, `${name}\n${prompt.content ?? ''}`);
    }

    const SKIP_KEY = /(proxy|endpoint|api_?url|api_?key|secret|password|authorization|bearer)/i;
    const walk = (value, pathParts, depth) => {
        if (budget <= 0 || depth > 4 || !value || typeof value !== 'object') {
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            if (SKIP_KEY.test(key) || key === 'prompts') {
                continue;
            }
            if (typeof child === 'string') {
                if (/^https?:\/\//i.test(child)) {
                    continue;
                }
                push(pathParts.concat(key).join('.'), child);
            } else if (child && typeof child === 'object') {
                walk(child, pathParts.concat(key), depth + 1);
            }
        }
    };
    walk(preset, [], 0);

    return chunks;
}

/** 在一段文本里找出所有括号标记（去重，记录出现次数、来源与首次出现的整行） */
function tokenize(chunks) {
    const tokens = new Map();

    for (const chunk of chunks) {
        const text = String(chunk?.text ?? '');
        const lines = text.split('\n');
        if (text === '') {
            continue;
        }

        for (const style of TAG_STYLES) {
            const pattern = new RegExp(`${escapeRegExp(style.left)}(${NAME_CHARS}{1,32})${escapeRegExp(style.right)}`, 'g');
            for (const match of text.matchAll(pattern)) {
                const full = match[0];
                const name = match[1];
                if (name.trim() === '' || full.includes('\n')) {
                    continue;
                }
                const proposedKind = isClosingName(name) ? 'close' : 'open';

                let token = tokens.get(full);
                if (!token) {
                    token = {
                        text: full,
                        name,
                        style: style.left,
                        styleIndex: TAG_STYLES.indexOf(style),
                        kind: proposedKind,
                        count: 0,
                        sources: new Set(),
                        lines: [],
                    };
                    tokens.set(full, token);
                } else if (proposedKind === 'open') {
                    // 同一串文字既能被当成开标记又能被当成闭标记时，优先当开标记
                    token.kind = 'open';
                }

                token.count += 1;
                token.sources.add(String(chunk.source ?? ''));
                if (token.lines.length < 5) {
                    const line = lines.find(item => item.includes(full));
                    if (line) {
                        token.lines.push(line.trim().slice(0, 300));
                    }
                }
            }
        }
    }

    return [...tokens.values()];
}

/** 该标签名是否有过「单边出现的关键词闭合标记」可作为后缀 */
function findKeywordClose(openToken, tokens) {
    for (const token of tokens) {
        if (token.kind !== 'close') {
            continue;
        }
        if (token.name === openToken.name) {
            continue;
        }
        if (THINKING_PATTERN.test(token.name)) {
            return token;
        }
    }
    return null;
}

function symmetricCloseText(openToken) {
    return `${openToken.style}/${openToken.name}${TAG_STYLES[openToken.styleIndex].right}`;
}

function blocklisted(name) {
    return STRUCTURAL_TAG_BLOCKLIST.includes(String(name).trim().toLowerCase());
}

function instructionEvidence(token) {
    for (const line of token.lines) {
        if (WRAP_CUE_PATTERN.test(line) && THINKING_PATTERN.test(line)) {
            return line;
        }
    }
    return '';
}

function scoreCandidate(candidate) {
    let score = 0;
    if (candidate.keyword) {
        score += 100;
    }
    if (candidate.instruction) {
        score += 60;
    }
    score += Math.min(candidate.count, 6) * 2;
    if (candidate.pairing === 'symmetric') {
        score += 10;
    }
    if (candidate.pairing === 'synthesized') {
        score -= 40;
    }
    if (candidate.blocklisted) {
        score -= 80;
    }
    if (candidate.tagName.length > 16) {
        score -= 10;
    }
    return score;
}

/**
 * 判断候选在当前模式下是否可以用来改设置。
 * safe 模式宁可不动：只认关键词标签或「有明确包裹说明」的成对标签。
 */
export function isApplicable(candidate, mode = 'safe') {
    if (!candidate || candidate.blocklisted) {
        return false;
    }
    if (mode === 'aggressive') {
        return true;
    }
    if (candidate.pairing === 'symmetric' && (candidate.keyword || candidate.instruction)) {
        return true;
    }
    if (candidate.keyword && candidate.pairing === 'keyword') {
        return true;
    }
    return false;
}

/**
 * 从预设文本里推断思维链前后缀。
 * @param {{source: string, text: string}[]} chunks
 * @param {{mode?: 'safe'|'aggressive', limit?: number}} [options]
 * @returns {{candidates: object[], best: object|null}}
 */
export function detectReasoningTags(chunks, { mode = 'safe', limit = 10 } = {}) {
    const tokens = tokenize(Array.isArray(chunks) ? chunks : []);
    const byText = new Map(tokens.map(token => [token.text, token]));
    const candidates = [];
    const seen = new Set();

    for (const openToken of tokens) {
        if (openToken.kind !== 'open') {
            continue;
        }

        const keyword = THINKING_PATTERN.test(openToken.name);
        const instruction = instructionEvidence(openToken);
        const closeText = symmetricCloseText(openToken);
        const symmetricToken = byText.get(closeText);

        const add = (suffix, pairing) => {
            const key = `${openToken.text}\u0000${suffix}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            const candidate = {
                prefix: openToken.text,
                suffix,
                tagName: openToken.name,
                pairing,
                count: openToken.count,
                keyword,
                instruction: instruction !== '',
                blocklisted: blocklisted(openToken.name),
                sources: [...openToken.sources].filter(Boolean).slice(0, 3),
                evidence: instruction || openToken.lines[0] || '',
            };
            candidate.score = scoreCandidate(candidate);
            candidates.push(candidate);
        };

        if (symmetricToken) {
            add(symmetricToken.text, 'symmetric');
        } else if (keyword) {
            const keywordClose = findKeywordClose(openToken, tokens);
            if (keywordClose) {
                add(keywordClose.text, 'keyword');
            } else if (SYNTHESIZABLE_STYLES.has(openToken.style)) {
                add(closeText, 'synthesized');
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score || a.tagName.length - b.tagName.length || b.count - a.count);
    const best = candidates.find(candidate => isApplicable(candidate, mode)) ?? null;
    return { candidates: candidates.slice(0, limit), best };
}

/**
 * 一行文字描述识别结果，用于状态栏与报告面板。
 * @param {object} candidate
 */
export function describeCandidate(candidate) {
    if (!candidate) {
        return '无候选';
    }
    const pairingLabel = {
        symmetric: '开闭成对',
        keyword: '由关键词闭合标记配对',
        synthesized: '仅见开标记，闭合标签为推断值',
    }[candidate.pairing] ?? candidate.pairing;
    const flags = [
        candidate.keyword ? '标签名含思维链关键词' : null,
        candidate.instruction ? '预设里写明包裹方式' : null,
    ].filter(Boolean);
    return [
        `前缀 ${JSON.stringify(candidate.prefix)}`,
        `后缀 ${JSON.stringify(candidate.suffix)}`,
        pairingLabel,
        `出现 ${candidate.count} 次`,
        `得分 ${candidate.score}`,
        flags.length ? flags.join(' + ') : '无强证据',
    ].join(' ｜ ');
}
