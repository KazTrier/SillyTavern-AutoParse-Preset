/**
 * 纯逻辑模块：从「预设文本」里推断思维链的前后缀标签。
 *
 * 设计目标（按真实预设的形态倒推，含踩过的坑）：
 *  - 预设通常用一句话说明思维链格式，例如
 *      "reasoning steps strictly using the shown thought template wrapped in `<thought></thought>` tag"
 *      "把思考过程写在 <inner_voice></inner_voice> 之间"
 *      "{{setvar::story_think_format:: <story_driver>...</story_driver> }}"
 *  - **优先读「思维链条目」**：很多大型预设（如咩咩预设）有上百条提示词，思维链格式写在
 *    名字带「思维链 / 思考 / 推理 / CoT」的条目里；其它条目里出现的标签（格式外壳、状态栏、
 *    变量名）都是干扰项。
 *  - **排除 STscript 宏**：`{{setvar::x::}}` / `{{getvar::x}}` 这类不是模型输出的标签。
 *  - **不跨条目配对**：开标记与闭合标记必须在**同一条目内、且闭合在后**，否则会把
 *    `【输出推理过程】` 和另一条目里的 `</acg_think>` 硬凑成一对（真实踩过的 bug）。
 *  - 同一份预设里往往还夹着大量**结构性标签**（<npc> <CONTEXT> <INSTRUCTIONS> <CHAT_HISTORY> …），
 *    它们不是思维链，必须排除。
 *  - 有的预设根本没有思维链标签 —— 这时必须返回「无」，宁可不改也不改错。
 *
 * 打分只依赖三类证据：
 *   1. 标签名本身是否与思维链相关（keyword）
 *   2. 出现该标签的那一行里，是否同时有「包裹/写在/inside/tag」这类措辞和思维链字样（instruction）
 *   3. 是开闭成对，还是只出现了单边（symmetric / keyword / synthesized）
 * 外加：是否来自思维链条目（cotEntry）、条目是否启用（enabled）、结构性标签黑名单。
 *
 * 本文件不 import 任何 SillyTavern 模块，可离线测试（见 test/detect.test.mjs）。
 */

/** 会被扫描的括号风格 */
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

/**
 * 条目名 / 标识符里出现这些词，说明这条提示词就是「思维链条目」。
 * 推断时这类条目里的标签优先，其它条目的标签只作为备选。
 * 注意只收强信号词：像「心理模型」「格式」这种会把无关条目录进来。
 */
export const COT_ENTRY_PATTERN = /(思维链|思维|思考|推理|内心|沉思|chain[_\s-]?of[_\s-]?thought|\bcot\b|think|thought|reason|scratchpad|reflect)/i;

/**
 * 「反思维链」条目：这类条目的用途是**压制/关闭**模型原生思维链，
 * 例如「卡原生思维链-预填充」里写的其实是 `</think>` `</thinking>` 这类**收尾标记**，
 * 它把原生思维链掐掉，绝不是本预设要用的思维链格式。这类条目整个排除。
 */
const ANTI_COT_ENTRY_PATTERN = /(卡原生|原生思维链|禁用|🈲|关闭思维|关闭思考|不输出思维|禁止输出|干掉|anti[_\s-]?think|no[_\s-]?think|think[_\s-]?(kill|off|disable))/i;

/**
 * 形如 `<acg_think_format>` / `<story_think_format>` 的标签只是预设用来**包裹格式示例的外壳**，
 * 不是模型真正输出的内容块（真实预设里很常见），推断时重罚。
 */
const FORMAT_SHELL_PATTERN = /(^|[_\s-])(format|fmt|格式|外壳)$/i;

/**
 * STscript / SillyTavern 宏 形式的 token，不是模型输出的标签。
 * 例如 `{{setvar::acg_think_format::}}`、`{{getvar::story_think_format}}`。
 */
const MACRO_NAME_PATTERN = /::|^(setvar|getvar|addvar|delvar|incvar|decvar|tempvar|input|pick|random|roll)\b/i;

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
    'story_scene', 'memory_log', 'status', 'affinity', 'wlog',
]);

/** XML 风格才能安全地合成闭合标签 */
const SYNTHESIZABLE_STYLES = new Set(['<', '<|', '<<']);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 该名字是「闭合 / 结束标记」吗？
 * 覆盖 `</x>`、`<|/x|>`、`<｜end▁of▁thinking｜>`、`<end_thinking>` 等形式。
 * @param {string} name
 */
function isTerminatorName(name) {
    const value = String(name).trim();
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

function isClosingName(name) {
    const value = String(name).trim();
    return value === '' || isTerminatorName(value);
}

/**
 * 把预设对象里所有可能有用的字符串收集起来。
 * @param {object} preset getChatCompletionPreset() 的返回值
 * @param {{limit?: number, enabledIds?: Set<string>|null}} [options]
 *        enabledIds：当前 prompt_order 里启用的条目 identifier，用于给候选加权
 * @returns {{source: string, text: string, name: string, identifier: string, enabled?: boolean}[]}
 */
export function collectPresetTexts(preset, { limit = 400000, enabledIds = null } = {}) {
    const chunks = [];
    let budget = limit;

    const lookupEnabled = (identifier) => {
        if (!enabledIds || typeof enabledIds.has !== 'function') {
            return undefined;
        }
        try {
            return enabledIds.has(String(identifier));
        } catch {
            return undefined;
        }
    };

    const push = (source, text, meta = {}) => {
        const value = String(text ?? '');
        if (budget <= 0 || value.trim() === '') {
            return;
        }
        const clipped = value.length > budget ? value.slice(0, budget) : value;
        budget -= clipped.length;
        chunks.push({
            source,
            text: clipped,
            name: String(meta.name ?? ''),
            identifier: String(meta.identifier ?? source),
            enabled: meta.enabled,
        });
    };

    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    for (const prompt of prompts) {
        if (!prompt || typeof prompt !== 'object') {
            continue;
        }
        const identifier = String(prompt.identifier ?? 'prompt');
        const name = String(prompt.name ?? '');
        push(`${identifier}${name ? ` (${name})` : ''}`, `${name}\n${prompt.content ?? ''}`, {
            name,
            identifier,
            enabled: lookupEnabled(identifier),
        });
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
                const path = pathParts.concat(key).join('.');
                push(path, child, { identifier: path, name: path });
            } else if (child && typeof child === 'object') {
                walk(child, pathParts.concat(key), depth + 1);
            }
        }
    };
    walk(preset, [], 0);

    return chunks;
}

/**
 * 找出所有括号标记，并记录它出现在哪些条目、以及在该条目内的首个偏移。
 * @param {{source?: string, text?: string, name?: string, identifier?: string, enabled?: boolean}[]} chunks
 */
function tokenize(chunks) {
    const tokens = new Map();
    const chunkMeta = chunks.map(chunk => {
        const name = String(chunk?.name ?? '');
        const identifier = String(chunk?.identifier ?? '');
        return {
            source: String(chunk?.source ?? ''),
            name,
            identifier,
            enabled: chunk?.enabled,
            cot: COT_ENTRY_PATTERN.test(name) || COT_ENTRY_PATTERN.test(identifier),
            antiByName: ANTI_COT_ENTRY_PATTERN.test(name) || ANTI_COT_ENTRY_PATTERN.test(identifier),
            opens: 0,
            closes: 0,
            anti: false,
        };
    });

    chunks.forEach((chunk, chunkIndex) => {
        const text = String(chunk?.text ?? '');
        if (text === '') {
            return;
        }
        const lines = text.split('\n');
        const meta = chunkMeta[chunkIndex];

        for (const style of TAG_STYLES) {
            const pattern = new RegExp(`${escapeRegExp(style.left)}(${NAME_CHARS}{1,32})${escapeRegExp(style.right)}`, 'g');
            for (const match of text.matchAll(pattern)) {
                const full = match[0];
                const name = match[1];
                if (name.trim() === '' || full.includes('\n')) {
                    continue;
                }
                // STscript 宏（{{setvar::x::}} 等）不是模型输出的标签
                if (MACRO_NAME_PATTERN.test(name)) {
                    continue;
                }

                const proposedKind = isClosingName(name) ? 'close' : 'open';
                if (proposedKind === 'close') {
                    meta.closes += 1;
                } else {
                    meta.opens += 1;
                }

                let token = tokens.get(full);
                if (!token) {
                    token = {
                        text: full,
                        name,
                        style: style.left,
                        styleIndex: TAG_STYLES.indexOf(style),
                        kind: proposedKind,
                        count: 0,
                        presences: new Map(),
                        lines: [],
                    };
                    tokens.set(full, token);
                } else if (proposedKind === 'open') {
                    // 同一串文字既能被当成开标记又能被当成闭标记时，优先当开标记
                    token.kind = 'open';
                }

                token.count += 1;
                if (!token.presences.has(chunkIndex)) {
                    token.presences.set(chunkIndex, match.index);
                }
                // 收集「包含该标签的行」，最多 5 条（带上**上一行**做上下文：
                // 预设常常上一行写「请严格按照以下格式输出：」，下一行才是标签）
                if (token.lines.length < 5) {
                    for (let i = 0; i < lines.length && token.lines.length < 5; i++) {
                        if (!lines[i].includes(full)) {
                            continue;
                        }
                        const context = `${i > 0 ? lines[i - 1] : ''} ${lines[i]}`.trim().slice(0, 400);
                        if (context !== '' && !token.lines.includes(context)) {
                            token.lines.push(context);
                        }
                    }
                }
            }
        }
    });

    // 「收尾型」条目：闭合标记明显多于开标记（≥2 个），典型就是压制原生思维链的预填充
    for (const meta of chunkMeta) {
        meta.anti = meta.antiByName || (meta.closes >= 2 && meta.closes > meta.opens);
    }

    return { tokens: [...tokens.values()], chunkMeta };
}

/** 该 token 是否只出现在「反思维链」条目里（是的话整个丢弃） */
function onlyInAntiChunks(token, chunkMeta) {
    const indexes = [...token.presences.keys()];
    return indexes.length > 0 && indexes.every(index => chunkMeta[index]?.anti);
}

/** 该 token 是否出现在「思维链条目」里（只看非反思维链的条目） */
function inCotChunk(token, chunkMeta) {
    return [...token.presences.keys()].some(index => chunkMeta[index]?.cot && !chunkMeta[index]?.anti);
}

/**
 * 为「只出现了开标记」的关键词标签找一个闭合标记。
 * 约束：必须在**同一条目**里、闭合标记在开标记**之后**、且括号风格兼容。
 */
function findKeywordClose(openToken, tokens, chunkMeta) {
    for (const token of tokens) {
        if (token.kind !== 'close' || token.name === openToken.name) {
            continue;
        }
        if (!THINKING_PATTERN.test(token.name) || onlyInAntiChunks(token, chunkMeta)) {
            continue;
        }
        if (token.style !== openToken.style && !isTerminatorName(token.name)) {
            continue;
        }
        for (const [chunkIndex, openOffset] of openToken.presences) {
            if (chunkMeta[chunkIndex]?.anti) {
                continue;
            }
            const closeOffset = token.presences.get(chunkIndex);
            if (closeOffset !== undefined && closeOffset > openOffset) {
                return token;
            }
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

/**
 * 从「该标签出现的行（含上一行）」里找「把思考包在 X 里」这类说明。
 * 判断措辞前必须剥掉**标签本身**与 **STscript 宏**：
 * 否则 `<acg_think_format>` 或 `{{setvar::acg_think_format::` 里的 `format` / `think`
 * 会被自己当成「格式 + 思维链说明」，造成误判（真实踩过）。
 */
function instructionEvidence(token) {
    for (const line of token.lines) {
        const prose = String(line)
            .replace(/\{\{[^}\n]{0,200}?\}\}/g, ' ')   // 完整宏，如 {{char}}
            .replace(/\{\{[^\n]*$/g, ' ')              // 行内未闭合的 {{，如 {{setvar::x::
            .replace(/<\|?[^<>\n]{1,40}\|?>/g, ' ')
            .replace(/[【「『\[{][^【「『\]}\n]{1,40}[】」』\]}]/g, ' ');
        if (WRAP_CUE_PATTERN.test(prose) && THINKING_PATTERN.test(prose)) {
            return line;
        }
    }
    return '';
}

function scoreCandidate(candidate) {
    let score = 0;
    if (candidate.cotEntry) {
        score += 55;
    }
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
    if (FORMAT_SHELL_PATTERN.test(candidate.tagName)) {
        score -= 120;
    }
    if (candidate.tagName.length > 16) {
        score -= 10;
    }
    // 条目是否在当前 prompt_order 里启用：启用的更可信，但**不作为硬过滤**
    // （有些预设把格式定义写在「多选一」的条目里，用户可能刚切换过）
    if (candidate.enabledEntry) {
        score += 12;
    } else if (candidate.disabledOnly) {
        score -= 12;
    }
    return score;
}

/**
 * 判断候选在当前模式下是否可以用来改设置。
 * safe 模式宁可不动：
 *   - 思维链条目里的**开闭成对**标签直接用（预设自己明说了这条是思维链）
 *   - 其它条目：只认关键词标签或「有明确包裹说明」的成对标签
 */
export function isApplicable(candidate, mode = 'safe') {
    if (!candidate || candidate.blocklisted) {
        return false;
    }
    if (mode === 'aggressive') {
        return true;
    }
    if (candidate.cotEntry && candidate.pairing === 'symmetric') {
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
 *
 * 安全模式（默认）**只读思维链条目**，分两级：
 *   1. 条目名 / 标识符含 思维链/思考/推理/CoT/think… 的条目（最可信）
 *   2. 没有第 1 级时，退而用「内容里明确写了『把思考包在 X 里』」的条目
 * 「反思维链」条目（卡原生思维链 / 禁用 / 收尾型预填充，作用是掐掉模型原生思维链）整个排除。
 * 宽松模式才看全量候选（可能选到 `_format` 外壳、状态栏标签，仅供排查）。
 * @param {{source?: string, text?: string, name?: string, identifier?: string, enabled?: boolean}[]} chunks
 * @param {{mode?: 'safe'|'aggressive', limit?: number}} [options]
 * @returns {{candidates: object[], ignoredCandidates: object[], ignoredCount: number, best: object|null, cotCandidateCount: number, pool: 'named-cot'|'instruction'|'all'|'empty'}}
 */
export function detectReasoningTags(chunks, { mode = 'safe', limit = 10 } = {}) {
    const list = Array.isArray(chunks) ? chunks : [];
    const { tokens, chunkMeta } = tokenize(list);
    const byText = new Map(tokens.map(token => [token.text, token]));
    const candidates = [];
    const seen = new Set();

    for (const openToken of tokens) {
        if (openToken.kind !== 'open' || onlyInAntiChunks(openToken, chunkMeta)) {
            continue;
        }

        const openChunks = [...openToken.presences.keys()].filter(index => !chunkMeta[index]?.anti);
        const cotEntry = inCotChunk(openToken, chunkMeta);
        const enabledEntry = openChunks.some(index => chunkMeta[index]?.enabled === true);
        const disabledOnly = openChunks.length > 0 && openChunks.every(index => chunkMeta[index]?.enabled === false);
        const sources = [...new Set(openChunks.map(index => chunkMeta[index]?.source || chunkMeta[index]?.name).filter(Boolean))].slice(0, 3);

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
                cotEntry,
                enabledEntry,
                disabledOnly,
                sources,
                evidence: instruction || openToken.lines[0] || '',
            };
            candidate.score = scoreCandidate(candidate);
            candidates.push(candidate);
        };

        if (symmetricToken && !onlyInAntiChunks(symmetricToken, chunkMeta)) {
            add(symmetricToken.text, 'symmetric');
        } else if (keyword) {
            const keywordClose = findKeywordClose(openToken, tokens, chunkMeta);
            if (keywordClose) {
                add(keywordClose.text, 'keyword');
            } else if (SYNTHESIZABLE_STYLES.has(openToken.style)) {
                add(closeText, 'synthesized');
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score || a.tagName.length - b.tagName.length || b.count - a.count);

    // 安全模式：先只认「思维链条目」，没有才退到「内容里写明包裹方式」的条目
    const namedCot = candidates.filter(candidate => candidate.cotEntry);
    const instructed = candidates.filter(candidate => !candidate.cotEntry && candidate.instruction);
    let pool = candidates;
    let poolKind = 'all';
    if (mode !== 'aggressive') {
        if (namedCot.length > 0) {
            pool = namedCot;
            poolKind = 'named-cot';
        } else if (instructed.length > 0) {
            pool = instructed;
            poolKind = 'instruction';
        } else {
            pool = [];
            poolKind = 'empty';
        }
    }

    const poolSet = new Set(pool);
    const ignoredCandidates = candidates.filter(candidate => !poolSet.has(candidate));
    const best = pool.find(candidate => isApplicable(candidate, mode)) ?? null;

    return {
        candidates: pool.slice(0, limit),
        ignoredCandidates: ignoredCandidates.slice(0, limit),
        ignoredCount: ignoredCandidates.length,
        best,
        cotCandidateCount: namedCot.length,
        pool: poolKind,
    };
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
        candidate.cotEntry ? '来自思维链条目' : null,
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
